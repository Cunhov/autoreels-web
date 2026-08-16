import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { cleanPathSegment, normalizeUploadPath, safeMediaExtension, isVideoExtension } from "@/lib/upload-path";
import { isFfmpegAvailable, getVideoDurationSec } from "@/lib/ffmpeg";
import { randomUUID } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, rename, rm, stat, unlink, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { listPartIndices, getUploadsDir } from "@/app/api/upload-chunk/route";
import { acquireFinalizeLock, type FinalizeLock } from "@/lib/upload-lock";

const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024; // 8MB
const DEFAULT_USER_QUOTA_BYTES = 20 * 1024 * 1024 * 1024; // 20GB per user

function getUserQuotaBytes(): number {
    const fromEnv = Number(process.env.UPLOAD_QUOTA_BYTES);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_USER_QUOTA_BYTES;
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let finalDiskPath: string | null = null;
    let thumbnailDiskPath: string | null = null;
    let partBase: string | null = null;
    let totalChunks = 0;
    let finalizeToken: string | null = null;
    let lock: FinalizeLock | null = null;

    const cleanupParts = async () => {
        if (!partBase) return;
        const indices = await listPartIndices(partBase);
        for (const index of indices) {
            await unlink(`${partBase}.part.${index}`).catch(() => { });
        }
    };

    try {
        const formData = await req.formData();
        const filename = formData.get("filename") as string | null;
        const sizeDeclaredRaw = formData.get("size") as string | null;
        const targetPath = formData.get("path") as string | null;
        const typeRaw = formData.get("type") as string | null;
        const tagsRaw = formData.get("tags") as string | null;
        const parentId = formData.get("parentId") as string | null;
        const caption = formData.get("caption") as string | null;
        const thumbnailPathLegacy = formData.get("thumbnailPath") as string | null;
        const thumbnailFile = formData.get("thumbnail");
        const totalChunksRaw = formData.get("totalChunks") as string | null;

        if (!filename || !targetPath) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        const safeFilename = cleanPathSegment(filename);
        if (safeFilename === null || safeFilename === "" || safeFilename.includes("/") || safeFilename === ".") {
            return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
        }

        // Server-generated file name: {uuid}.{safeExt} — unpredictable, immutable URLs.
        const ext = safeMediaExtension(safeFilename);
        if (!ext) {
            return NextResponse.json({ error: "Unsupported media type (expected video or image file)" }, { status: 400 });
        }

        // Type: honor the client's explicit video/image, else infer from extension.
        const type = typeRaw === "video" || typeRaw === "image"
            ? typeRaw
            : (isVideoExtension(ext) ? "video" : "image");

        const sizeDeclared = parseInt(sizeDeclaredRaw || "0");
        if (Number.isNaN(sizeDeclared) || sizeDeclared < 0) {
            return NextResponse.json({ error: "Invalid size" }, { status: 400 });
        }

        // Validate parent folder ownership (prevent attaching to another user's folder)
        if (parentId) {
            const parent = await prisma.contentItem.findFirst({
                where: { id: parentId, user_id: userId },
                select: { id: true },
            });
            if (!parent) {
                return NextResponse.json({ error: "Invalid parent folder" }, { status: 400 });
            }
        }

        // ── Staging: locate the .part.{i} files ─────────────────────────────────
        const stagingPath = normalizeUploadPath(userId, targetPath);
        if (!stagingPath) {
            return NextResponse.json({ error: "Invalid upload path" }, { status: 400 });
        }

        const uploadDir = getUploadsDir();
        partBase = join(uploadDir, stagingPath);

        // ── Finalize lock: only ONE finalize may consume this part set ─────────
        // While held, chunk POSTs / cancels get 409 and the parts are exclusively
        // ours: no concurrent complete can delete them mid-concatenation.
        lock = await acquireFinalizeLock(partBase);
        if (!lock) {
            return NextResponse.json({ error: "Finalize in progress", finalizing: true }, { status: 409 });
        }

        const stagedIndices = await listPartIndices(partBase);

        // ── Idempotent replay ───────────────────────────────────────────────────
        // No parts left: either a previous finalize already created the item
        // (return it — the client's 409-backoff/retry converges here) or there is
        // genuinely nothing to finalize.
        if (stagedIndices.length === 0) {
            const existingItem = await prisma.contentItem.findFirst({
                where: {
                    user_id: userId,
                    name: safeFilename,
                    ...(parentId ? { parent_id: parentId } : { parent_id: null }),
                },
            });
            if (existingItem) {
                return NextResponse.json({ success: true, item: existingItem, idempotent: true });
            }
            return NextResponse.json({ error: "No uploaded chunks found" }, { status: 400 });
        }

        // totalChunks: prefer the explicit field; fall back to max index + 1 for
        // backward compatibility with clients that don't send it yet.
        const explicitTotal = parseInt(totalChunksRaw || "0");
        totalChunks = Number.isInteger(explicitTotal) && explicitTotal > 0
            ? explicitTotal
            : (stagedIndices.length > 0 ? Math.max(...stagedIndices) + 1 : 0);

        // Verify EVERY part 0..totalChunks-1 is present — no silent corruption.
        const present = new Set(stagedIndices);
        const missing: number[] = [];
        for (let i = 0; i < totalChunks; i++) {
            if (!present.has(i)) missing.push(i);
        }
        if (missing.length > 0) {
            return NextResponse.json(
                { error: "Incomplete upload", missing },
                { status: 409 }
            );
        }

        // ── Consume: rename parts into a private finalize dir ───────────────────
        // After this, no other request can see or delete the parts (atomic rename
        // within the same volume). A chunk POST that slips past the lock check
        // cannot corrupt us: we only read the renamed copies.
        finalizeToken = randomUUID();
        const finalizeDir = join(uploadDir, ".finalizing", finalizeToken);
        await mkdir(finalizeDir, { recursive: true });
        for (let i = 0; i < totalChunks; i++) {
            try {
                await rename(`${partBase}.part.${i}`, join(finalizeDir, `part.${i}`));
            } catch (err: unknown) {
                const code = (err as { code?: string })?.code;
                if (code === "ENOENT") {
                    throw new Error(`Part ${i} missing while consuming staged parts (concurrent delete?)`);
                }
                throw err;
            }
        }

        // ── Concatenate parts into the final file ───────────────────────────────
        // EXACTLY ONE pipeline() call over an async generator of part streams:
        // the out WriteStream gets a single close/error listener pair instead of
        // accumulating one per chunk (the old MaxListenersExceededWarning leak).
        const uuidName = `${randomUUID()}.${ext}`;
        const finalRelativePath = `${userId}/${uuidName}`;
        finalDiskPath = join(uploadDir, finalRelativePath);
        await mkdir(dirname(finalDiskPath), { recursive: true });

        const out = createWriteStream(finalDiskPath, { flags: "w" });
        const source = Readable.from(
            (async function* () {
                for (let i = 0; i < totalChunks; i++) {
                    const partStream = createReadStream(join(finalizeDir, `part.${i}`));
                    for await (const chunk of partStream) {
                        yield chunk;
                    }
                }
            })(),
        );
        try {
            await pipeline(source, out);
        } catch (error: unknown) {
            out.destroy();
            await unlink(finalDiskPath).catch(() => { });
            throw error;
        }

        // ── Verify actual size on disk ──────────────────────────────────────────
        const finalStat = await stat(finalDiskPath);
        const actualSize = finalStat.size;
        if (actualSize === 0) {
            await unlink(finalDiskPath).catch(() => { });
            finalDiskPath = null;
            return NextResponse.json({ error: "Uploaded file is empty" }, { status: 400 });
        }
        if (sizeDeclared > 0 && actualSize !== sizeDeclared) {
            await unlink(finalDiskPath).catch(() => { });
            finalDiskPath = null;
            return NextResponse.json(
                { error: "Size mismatch (uploaded bytes differ from declared size)" },
                { status: 400 }
            );
        }

        // ── Duration via ffprobe (best-effort) ──────────────────────────────────
        let duration: number | null = null;
        if (type === "video" && isFfmpegAvailable()) {
            try {
                duration = await getVideoDurationSec(finalDiskPath);
            } catch {
                duration = null; // non-fatal
            }
        }

        // ── Thumbnail: new path (File in FormData) or legacy thumbnailPath ──────
        let thumbnailUrl: string | null = null;
        if (thumbnailFile instanceof File && thumbnailFile.size > 0) {
            if (thumbnailFile.size > MAX_THUMBNAIL_BYTES) {
                return NextResponse.json({ error: "Thumbnail too large (max 8MB)" }, { status: 400 });
            }
            const thumbName = `thumb-${randomUUID()}.jpg`;
            const thumbRelative = `${userId}/${thumbName}`;
            thumbnailDiskPath = join(uploadDir, thumbRelative);
            const bytes = Buffer.from(await thumbnailFile.arrayBuffer());
            await writeFile(thumbnailDiskPath, bytes);
            thumbnailUrl = `/api/file/${thumbRelative}`;
        } else if (thumbnailPathLegacy) {
            const safeThumb = cleanPathSegment(thumbnailPathLegacy);
            if (safeThumb) thumbnailUrl = `/api/file/${safeThumb}`;
        }

        // ── Quota check (before persisting the DB record) ───────────────────────
        const quotaBytes = getUserQuotaBytes();
        const agg = await prisma.contentItem.aggregate({
            where: { user_id: userId },
            _sum: { size: true },
        });
        const usedBefore = agg._sum.size || 0;
        if (usedBefore + actualSize > quotaBytes) {
            await unlink(finalDiskPath).catch(() => { });
            finalDiskPath = null;
            if (thumbnailDiskPath) {
                await unlink(thumbnailDiskPath).catch(() => { });
                thumbnailDiskPath = null;
            }
            return NextResponse.json({ error: "Quota exceeded (upload limit reached)" }, { status: 413 });
        }

        // ── Dedupe / create the ContentItem ─────────────────────────────────────
        const finalUrl = `/api/file/${finalRelativePath}`;
        const data = {
            size: actualSize,
            url: finalUrl,
            path: finalRelativePath,
            type,
            ...(duration != null ? { duration } : {}),
            ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
            ...(tagsRaw ? { tags: tagsRaw } : {}),
            ...(parentId ? { parent_id: parentId } : { parent_id: null }),
            ...(caption ? { caption } : {}),
        };

        const existingItem = await prisma.contentItem.findFirst({
            where: {
                user_id: userId,
                name: safeFilename,
                ...(parentId ? { parent_id: parentId } : { parent_id: null }),
            },
        });

        let savedItem;
        if (existingItem) {
            savedItem = await prisma.contentItem.update({
                where: { id: existingItem.id },
                data,
            });
        } else {
            savedItem = await prisma.contentItem.create({
                data: {
                    user_id: userId,
                    name: safeFilename,
                    ...data,
                },
            });
        }

        // The finalize dir and any straggler parts are removed in `finally`
        // (the lock guarantees no new parts can appear while we still hold it).

        return NextResponse.json({ success: true, item: savedItem });
    } catch (error: unknown) {
        console.error("Finalizing upload error:", error);
        // On any failure, remove the final/thumbnail files (the staged parts and
        // the finalize dir are cleaned in `finally`).
        if (finalDiskPath) await unlink(finalDiskPath).catch(() => { });
        if (thumbnailDiskPath) await unlink(thumbnailDiskPath).catch(() => { });
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    } finally {
        // Remove the private finalize dir (idempotent — success already emptied it).
        if (finalizeToken) {
            await rm(join(getUploadsDir(), ".finalizing", finalizeToken), { recursive: true, force: true }).catch(() => { });
        }
        // Only the lock OWNER may clean the staging parts. The 409 loser (lock
        // not acquired) must never touch `.part.*` — deleting them would destroy
        // the winner's parts mid-consume (the exact ENOENT race this guard fixes).
        if (lock) {
            // Remove any straggler `.part.*` left under the staging path (normally
            // none: we renamed them all before concatenating).
            await cleanupParts();
            // Release the lock LAST: while we hold it, no other request can write
            // parts or cancel, so this cleanup cannot race a new upload.
            await lock.release();
        }
    }
}
