import { mkdtemp, mkdir, writeFile, utimes, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { sweepStaleStaging } from "../../lib/upload-gc";

async function main() {
	const root = await mkdtemp(join(tmpdir(), "gc-sim-"));
	const uploads = join(root, "uploads");
	const old = new Date(Date.now() - 30 * 60 * 1000);
	const fresh = new Date();

	// 1) stale orphan part (30 min old) — must be swept
	await mkdir(join(uploads, "admin"), { recursive: true });
	const orphan = join(uploads, "admin", "video.mp4.part.3");
	await writeFile(orphan, "x");
	await utimes(orphan, old, old);

	// 2) fresh part (just written) — must survive
	const freshPart = join(uploads, "admin", "video2.mp4.part.0");
	await writeFile(freshPart, "y");

	// 3) stale .finalizing dir, marker -> path with NO lock — must be swept
	const finDead = join(uploads, ".finalizing", "dead-beef");
	await mkdir(finDead, { recursive: true });
	await writeFile(join(finDead, "source"), join(uploads, "admin", "video.mp4"));
	await writeFile(join(finDead, "part.0"), "z");
	await utimes(finDead, old, old);

	// 4) fresh .finalizing dir — must survive (mtime guard)
	const finLive = join(uploads, ".finalizing", "live-uuid");
	await mkdir(finLive, { recursive: true });
	await writeFile(join(finLive, "source"), join(uploads, "admin", "video3.mp4"));
	await writeFile(join(finLive, "part.0"), "w");
	await utimes(finLive, fresh, fresh);

	// 5) stale .finalizing dir whose marker path holds a FRESH lock — must survive (lock guard)
	const finLocked = join(uploads, ".finalizing", "locked-uuid");
	await mkdir(finLocked, { recursive: true });
	await writeFile(join(finLocked, "source"), join(uploads, "admin", "video4.mp4"));
	await writeFile(join(finLocked, "part.0"), "q");
	await utimes(finLocked, old, old);
	await writeFile(join(uploads, "admin", "video4.mp4.finalizing.lock"), `${process.pid} ${Date.now()}\n`);

	await sweepStaleStaging(uploads);

	const adminFiles = await readdir(join(uploads, "admin"));
	const finFiles = await readdir(join(uploads, ".finalizing"));
	const out = {
		orphanSwept: !adminFiles.includes("video.mp4.part.3"),
		freshPartAlive: adminFiles.includes("video2.mp4.part.0"),
		staleFinalizeSwept: !finFiles.includes("dead-beef"),
		freshFinalizeAlive: finFiles.includes("live-uuid"),
		lockedFinalizeAlive: finFiles.includes("locked-uuid"),
		lockFileAlive: adminFiles.includes("video4.mp4.finalizing.lock"),
	};
	console.log(JSON.stringify(out));
	const ok = out.orphanSwept && out.freshPartAlive && out.staleFinalizeSwept && out.freshFinalizeAlive && out.lockedFinalizeAlive && out.lockFileAlive;
	process.exit(ok ? 0 : 1);
}

main().then(
	() => {},
	(e) => {
		console.error(e);
		process.exit(1);
	},
);
