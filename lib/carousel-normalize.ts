import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile, lstat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { getPublicUrl } from "@/lib/storage";

/**
 * Instagram carousel aspect-ratio normalization.
 *
 * Confirmed against the Instagram Content Publishing API docs: feed carousels
 * only support images between ~3:4 (0.75) and 1.91:1, and the FIRST carousel
 * image defines the crop for ALL slides ("Carousel images are all cropped
 * based on the first image in the carousel, with the default being a 1:1
 * aspect ratio"). A 9:16 portrait image (0.5625) is outside the accepted
 * range, so Instagram either rejects it or crops it badly. To match
 * Instagram's native behavior we CROP (fill the target frame, cutting the
 * excess top/bottom or left/right) rather than pad: padding produces the
 * "zoomed out" letterbox look users reported as wrong.
 */

// Accepted Instagram feed/carousel ratios (w/h). Minimum ~3:4, max 1.91:1.
export const CAROUSEL_MIN_RATIO = 3 / 4; // 0.75 (3:4, newest supported)
export const CAROUSEL_MAX_RATIO = 1.91; // landscape 1.91:1
// Target when an image is TOO TALL (e.g. 9:16 → 4:5). 4:5 keeps the most
// vertical content while staying inside Instagram's accepted range.
export const CAROUSEL_TARGET_RATIO_TALL = 4 / 5; // 0.8
export const CAROUSEL_TARGET_RATIO_WIDE = 1.91;

const CACHE_SUBDIR = "carousel-cache-v2";

export interface NormalizeResult {
	/** URL to send to the Instagram API (cache file when normalized). */
	url: string;
	/** True when the image was re-encoded/padded. */
	normalized: boolean;
	/** Human-readable note for logs. */
	note?: string;
}

/**
 * Strip the URL down to the relative uploads path.
 * Accepts "/api/file/user/x.png" or a bare relative path "user/x.png".
 * Returns null for external URLs or unsafe paths.
 */
export function uploadUrlToRelativePath(url: string): string | null {
	if (!url) return null;
	// External URLs (import-url) live outside our disk — nothing to normalize.
	if (/^https?:\/\//i.test(url)) return null;

	const clean = url.split("?")[0].split("#")[0];
	const rel = clean.startsWith("/api/file/")
		? clean.slice("/api/file/".length)
		: clean.replace(/^\/+/, "");

	if (!rel) return null;
	if (rel.includes("..") || rel.includes("\\") || rel.startsWith("/")) {
		return null;
	}
	return rel;
}

/**
 * Resolve a relative uploads path to a real file on disk. Tries the current
 * data/uploads dir first, then the legacy public/uploads dir. Returns null
 * when no file exists at any candidate location.
 */
async function resolveUploadFile(relPath: string): Promise<string | null> {
	if (!relPath) return null;
	// relPath was already validated by uploadUrlToRelativePath (no "..", no
	// backslashes, no absolute path); resolve() below re-checks containment.
	const roots = [
		resolve(process.cwd(), "data", "uploads"),
		resolve(process.cwd(), "public", "uploads"),
	];
	for (const root of roots) {
		const candidate = resolve(root, relPath);
		if (!candidate.startsWith(root + sep)) continue; // traversal guard (defense in depth)
		try {
			const stat = await lstat(candidate);
			if (stat.isFile()) return candidate;
		} catch {
			// not here — try next root
		}
	}
	return null;
}

/**
 * Read image dimensions via sharp. Returns null for anything that is not a
 * readable image (videos, corrupt files, missing files).
 */
async function readImageDimensions(filePath: string) {
	try {
		const meta = await sharp(filePath, { failOn: "none" }).metadata();
		if (!meta.width || !meta.height) return null;
		return { width: meta.width, height: meta.height };
	} catch {
		return null;
	}
}

/**
 * Center-crop `filePath` to exactly `targetW` x `targetH`. The excess top/
 * bottom (tall images) or left/right (wide images) is cut away so the output
 * fills the target frame — the same crop Instagram applies natively.
 * Returns the output buffer.
 */
async function cropToTarget(filePath: string, targetW: number, targetH: number) {
	return sharp(filePath, { failOn: "none" })
		.resize(targetW, targetH, { fit: "cover", position: "centre" })
		.jpeg({ quality: 90 })
		.toBuffer();
}

/**
 * Normalize one carousel child image so its aspect ratio is inside
 * Instagram's accepted range (3:4 … 1.91:1). Images already in range are
 * returned untouched (zero cost). Out-of-range images (e.g. 9:16) are
 * center-cropped to the nearest supported ratio — 9:16 → 4:5 (cuts top /
 * bottom), > 1.91:1 → 1.91:1 (cuts left/right) — matching Instagram's own
 * crop behavior exactly.
 *
 * The normalized result is written to a deterministic cache file under
 * data/uploads/carousel-cache-v2/{userId}/ so retries and partial-failure
 * reconciles reuse the same file instead of re-encoding.
 */
export async function normalizeCarouselChild(opts: {
	/** Stored child url, e.g. "/api/file/admin/uuid.png". */
	url: string;
	/** Owner of the content (used to namespace the cache). */
	userId: string;
}): Promise<NormalizeResult> {
	const { url, userId } = opts;
	const originalUrl = url;

	const relPath = uploadUrlToRelativePath(url);
	if (!relPath) {
		// External / legacy URL: leave untouched (Instagram downloads it itself).
		return { url: originalUrl, normalized: false };
	}

	const filePath = await resolveUploadFile(relPath);
	if (!filePath) {
		return { url: originalUrl, normalized: false };
	}

	const dims = await readImageDimensions(filePath);
	if (!dims) {
		// Not an image (or unreadable) — nothing to normalize.
		return { url: originalUrl, normalized: false };
	}

	const ratio = dims.width / dims.height;
	if (ratio >= CAROUSEL_MIN_RATIO && ratio <= CAROUSEL_MAX_RATIO) {
		// Already inside Instagram's accepted range.
		return { url: originalUrl, normalized: false };
	}

	// ── Compute the target canvas (crop to fill, Instagram-style) ────────────
	let targetW: number;
	let targetH: number;
	let targetLabel: string;
	if (ratio < CAROUSEL_MIN_RATIO) {
		// Too tall (e.g. 9:16 = 0.5625 < 0.75) → crop top/bottom to 4:5.
		targetW = dims.width;
		targetH = Math.round(dims.width / CAROUSEL_TARGET_RATIO_TALL);
		targetLabel = "4:5";
	} else {
		// Too wide (> 1.91:1) → crop left/right to 1.91:1.
		targetW = Math.round(dims.height * CAROUSEL_TARGET_RATIO_WIDE);
		targetH = dims.height;
		targetLabel = "1.91:1";
	}

	// ── Deterministic cache path (reused by retries/reconciles) ──────────────
	const cacheKey = createHash("sha1")
		.update(`${relPath}:${targetW}x${targetH}`)
		.digest("hex")
		.slice(0, 24);
	// Sanitize the user's id segment: only alphanumerics/dash/underscore
	// survive, so the resolved cache dir always stays inside data/uploads. The
	// SAME segment is used in the public URL and on disk, so the cache file is
	// always reachable via /api/file/carousel-cache/….
	const safeUserSegment = userId.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, "_");
	const cacheRel = `${CACHE_SUBDIR}/${safeUserSegment}/${cacheKey}.jpg`;
	const safeCacheDir = resolve(
		process.cwd(),
		"data",
		"uploads",
		CACHE_SUBDIR,
		safeUserSegment,
	);
	const cacheDisk = join(safeCacheDir, `${cacheKey}.jpg`);

	try {
		let existing = null;
		try {
			existing = await lstat(cacheDisk);
		} catch {
			// not yet cached
		}
		if (existing && existing.isFile()) {
			return {
				url: getPublicUrl(cacheRel),
				normalized: true,
				note: `${ratio.toFixed(3)} (${dims.width}x${dims.height}) → ${targetLabel} ${targetW}x${targetH} (cache hit)`,
			};
		}

		await mkdir(safeCacheDir, { recursive: true });
		const outBuf = await cropToTarget(filePath, targetW, targetH);

		// Atomic write: .part then rename — a concurrent worker reading the
		// cache never sees a half-written file.
		const partPath = `${cacheDisk}.part`;
		await writeFile(partPath, outBuf);
		await rename(partPath, cacheDisk);

		return {
			url: getPublicUrl(cacheRel),
			normalized: true,
			note: `${ratio.toFixed(3)} (${dims.width}x${dims.height}) → ${targetLabel} ${targetW}x${targetH}`,
		};
	} catch (err) {
		// Normalization is best-effort: on any local failure, fall back to the
		// original URL so the post is not blocked (Instagram's own crop/reject
		// then applies, same as before this change).
		console.error("[carousel-normalize] failed:", err);
		return { url: originalUrl, normalized: false };
	}
}
