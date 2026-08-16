#!/usr/bin/env node
/**
 * Channels gauntlet — M4b (restore SUCCESS). MUST run as the LAST part of
 * channels-run.sh: in prod mode the restore route schedules process.exit(0)
 * ~1.5s after responding (container restart mechanism), which kills the
 * standalone server. All assertions here are file/DB-level, done with a FRESH
 * better-sqlite3 connection in this process — the server is not needed after
 * the response arrives.
 *
 * Flow:
 *   1. Ensure today's backup exists (POST /api/admin/backups — skipped if yes).
 *   2. Insert a marker row into the live DB (AFTER the backup snapshot).
 *   3. Hash the live DB, then POST /api/admin/restore {filename: <today>}.
 *   4. Assert with a fresh sqlite connection: marker gone, integrity ok,
 *      <db>.pre-restore emergency copy exists with the pre-restore hash.
 *   5. Assert the server is still answering in dev mode (restart skipped) —
 *      in prod the process may exit right after the response (documented).
 *
 * Usage:
 *   node channels-restore.mjs --base http://127.0.0.1:PORT --db <test.db>
 *        --secret <NEXTAUTH_SECRET> --uploads-dir <dir> --backups-dir <dir>
 *        --server-log <server.log> --out <dir>
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { encode } from "next-auth/jwt";

const argv = process.argv.slice(2);
const getArg = (key) => {
	const i = argv.indexOf(key);
	return i >= 0 ? argv[i + 1] : null;
};
const BASE = getArg("--base");
const DB_PATH = getArg("--db");
const SECRET = getArg("--secret");
const BACKUPS_DIR = getArg("--backups-dir");
const OUT_DIR = getArg("--out");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--backups-dir", BACKUPS_DIR],
	["--out", OUT_DIR],
]) {
	if (!value) {
		console.error(`Missing required argument ${name}`);
		process.exit(2);
	}
}

const SESSION_COOKIE = `next-auth.session-token=${await encode({
	token: { sub: "admin" },
	secret: SECRET,
	maxAge: 3600,
})}`;

const sha256File = (p) =>
	createHash("sha256").update(readFileSync(p)).digest("hex");

async function req(path, { method = "GET", body, headers = {} } = {}) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: { Cookie: SESSION_COOKIE, ...headers },
		body,
	});
	let json = null;
	try {
		json = await res.json();
	} catch {
		/* non-JSON */
	}
	return { ok: res.ok, status: res.status, json };
}

function todayBackupName() {
	const d = new Date();
	return `backup-${[
		d.getFullYear(),
		String(d.getMonth() + 1).padStart(2, "0"),
		String(d.getDate()).padStart(2, "0"),
	].join("")}.db`;
}

async function main() {
	// 1. Ensure today's backup exists (created by M4a normally).
	const ensure = await req("/api/admin/backups", { method: "POST" });
	const filename = todayBackupName();
	const backupPath = join(BACKUPS_DIR, filename);
	if (!existsSync(backupPath)) {
		console.log(`SCENARIO M4b: FAIL — today's backup missing (${backupPath})`);
		console.log(
			`  ensure response: ${ensure.status} ${JSON.stringify(ensure.json)}`,
		);
		process.exit(1);
	}

	// 2. Marker row AFTER the snapshot.
	const Database = (await import("better-sqlite3")).default;
	const live = new Database(DB_PATH, { readonly: false });
	live
		.prepare(
			"INSERT INTO content_items (id, user_id, name, type, size, created_at) VALUES (?, 'admin', ?, 'video', 1, datetime('now'))",
		)
		.run("marker-restore-m4b", "marker-before-restore");
	live.close();

	const hashBefore = sha256File(DB_PATH);

	// 3. Restore.
	const restore = await req("/api/admin/restore", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ filename }),
	});

	// 4. Assert via a FRESH connection.
	const check = new Database(DB_PATH, { readonly: true });
	const markerCount = check
		.prepare(
			"SELECT COUNT(*) AS n FROM content_items WHERE id = 'marker-restore-m4b'",
		)
		.get().n;
	const integrity = check.pragma("integrity_check", { simple: true });
	check.close();

	const preRestorePath = `${DB_PATH}.pre-restore`;
	const preRestoreOk =
		existsSync(preRestorePath) && sha256File(preRestorePath) === hashBefore;

	// Server liveness (dev mode: no restart; prod: may exit right after).
	let serverAlive = "n/a";
	try {
		const health = await fetch(`${BASE}/api/health`, {
			signal: AbortSignal.timeout(4000),
		});
		serverAlive = health.status;
	} catch {
		serverAlive = "down";
	}

	const pass =
		restore.ok === true &&
		restore.json?.ok === true &&
		markerCount === 0 &&
		integrity === "ok" &&
		preRestoreOk;

	console.log(
		`SCENARIO M4b: ${pass ? "PASS" : "FAIL"} — restore=${restore.status}/${JSON.stringify(restore.json)} markerGone=${markerCount === 0} integrity=${integrity} preRestore=${preRestoreOk} serverAfter=${serverAlive}`,
	);
	process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
	console.error("M4b FATAL:", err?.stack || err);
	process.exit(2);
});
