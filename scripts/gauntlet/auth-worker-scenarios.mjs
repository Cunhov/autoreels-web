#!/usr/bin/env node
/**
 * Module-07 gauntlet — I5 (login/auth + rate limiting) and I6 (worker process).
 *
 * I5 drives REAL next-auth credential logins over HTTP against the running
 * standalone app (csrf token + callback POST). The rate limiter keys on
 * `x-forwarded-for` — the harness sets a FIXED header per test IP so the
 * limiter is deterministic (and independent of the browser-visual logins,
 * which use ip="unknown" — no x-forwarded-for from Playwright).
 *
 * I6 spawns worker/index.js as a subprocess pointed at a local stub HTTP
 * server (this script) and asserts the REAL worker loop: publisher POST with
 * x-cron-auth, first-loop backup/maintenance/metrics calls, interval spacing,
 * 5xx handling (logged, process stays alive), and exit(1) without CRON_SECRET.
 *
 * Usage:
 *   node auth-worker-scenarios.mjs --base http://127.0.0.1:PORT --db <db>
 *        --secret <NEXTAUTH_SECRET> --out <dir> --admin-email <e>
 *        --admin-password <p> --worker-dir <repo-root> --cron-secret <s>
 *
 * Exit code 0 only if every scenario passes.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const getArg = (key) => {
	const i = argv.indexOf(key);
	return i >= 0 ? argv[i + 1] : null;
};
const BASE = getArg("--base");
const DB_PATH = getArg("--db");
const SECRET = getArg("--secret");
const OUT_DIR = getArg("--out");
const ADMIN_EMAIL = getArg("--admin-email");
const ADMIN_PASSWORD = getArg("--admin-password");
const WORKER_DIR = getArg("--worker-dir");
const CRON_SECRET = getArg("--cron-secret");
for (const [name, value] of [
	["--base", BASE],
	["--db", DB_PATH],
	["--secret", SECRET],
	["--out", OUT_DIR],
	["--admin-email", ADMIN_EMAIL],
	["--admin-password", ADMIN_PASSWORD],
	["--worker-dir", WORKER_DIR],
	["--cron-secret", CRON_SECRET],
]) {
	if (!value) {
		console.error(`Missing required argument ${name}`);
		process.exit(2);
	}
}

let resultsTotal = [];
function record(label, pass, line, detail = {}) {
	resultsTotal.push({ scenario: label, pass, line, detail });
	console.log(`SCENARIO ${label}: ${pass ? "PASS" : "FAIL"} — ${line}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// I5 — login / auth / rate limiting
// ═══════════════════════════════════════════════════════════════════════════
async function loginAttempt(email, password, ip) {
	const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
	const csrf = await csrfRes.json().catch(() => ({ csrfToken: "" }));
	const csrfCookie = (csrfRes.headers.get("set-cookie") || "").split(";")[0];
	const body = new URLSearchParams({
		csrfToken: csrf.csrfToken || "",
		email,
		password,
		json: "true",
	});
	const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...(ip ? { "x-forwarded-for": ip } : {}),
			...(csrfCookie ? { Cookie: csrfCookie } : {}),
		},
		body: body.toString(),
		redirect: "manual",
	});
	const text = await res.text().catch(() => "");
	const setCookie = res.headers.get("set-cookie") || "";
	return { status: res.status, text, setCookie };
}

async function scenarioI5() {
	// (a) wrong password → 401, no session cookie.
	const wrongPass = await loginAttempt(ADMIN_EMAIL, "DefinitelyWrong99!", "192.0.2.50");
	// (b) wrong email → 401 with an IDENTICAL body (no user enumeration).
	const wrongUser = await loginAttempt("nobody@example.com", ADMIN_PASSWORD, "192.0.2.50");
	// (c) correct → 200 + session cookie + the session actually works.
	const correct = await loginAttempt(ADMIN_EMAIL, ADMIN_PASSWORD, "192.0.2.50");
	const sessionToken = (correct.setCookie.match(/next-auth\.session-token=([^;]+)/) || [])[1] || "";
	const sessionWorks = await (async () => {
		if (!sessionToken) return false;
		const res = await fetch(`${BASE}/api/content-items?limit=1`, {
			headers: { Cookie: `next-auth.session-token=${sessionToken}` },
		});
		return res.status === 200;
	})();

	// (d) rate limit: 10 wrong attempts from 192.0.2.99 → 11th (CORRECT) blocked;
	// a different IP with the correct password still succeeds (per-IP keying).
	const LIMIT_IP = "192.0.2.99";
	for (let i = 0; i < 10; i++) {
		await loginAttempt(ADMIN_EMAIL, `WrongPassword${i}`, LIMIT_IP);
	}
	const lockedOut = await loginAttempt(ADMIN_EMAIL, ADMIN_PASSWORD, LIMIT_IP);
	const otherIpOk = await loginAttempt(ADMIN_EMAIL, ADMIN_PASSWORD, "192.0.2.200");

	const pass =
		wrongPass.status === 401 &&
		wrongUser.status === 401 &&
		wrongPass.text === wrongUser.text &&
		correct.status === 200 &&
		Boolean(sessionToken) &&
		sessionWorks &&
		lockedOut.status === 401 &&
		otherIpOk.status === 200;
	record(
		"I5",
		Boolean(pass),
		`login: wrongPass=${wrongPass.status} wrongUser=${wrongUser.status}(identicalBody=${wrongPass.text === wrongUser.text}) correct=${correct.status}/sessionWorks=${sessionWorks} rateLimit: 10 wrong + correct from ${LIMIT_IP} → ${lockedOut.status}(lockout) otherIp=${otherIpOk.status} (per-IP keying)`,
		{ wrongPassStatus: wrongPass.status, correctStatus: correct.status, sessionWorks, lockedOutStatus: lockedOut.status, otherIpStatus: otherIpOk.status },
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// I6 — worker subprocess vs a local stub
// ═══════════════════════════════════════════════════════════════════════════
function bootStub() {
	const requests = [];
	let publisher500 = false;
	const modeFile = join(OUT_DIR, "worker-stub-mode.txt");
	try {
		writeFileSync(modeFile, "ok");
	} catch {
		/* ignore */
	}
	const server = http.createServer((req, res) => {
		requests.push({ ts: Date.now(), url: req.url, method: req.method, auth: req.headers["x-cron-auth"] || "" });
		try {
			if (existsSync(modeFile) && readFileSync(modeFile, "utf8").trim() === "publisher-500" && req.url?.includes("/api/cron/publisher")) {
				res.statusCode = 500;
				res.end("boom");
				return;
			}
		} catch {
			/* ignore */
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ ok: true }));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve({ server, requests, modeFile, port: server.address().port }));
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

async function scenarioI6() {
	const { server, requests, modeFile, port } = await bootStub();
	const APP_URL = `http://127.0.0.1:${port}`;
	const WORKER_INTERVAL = "8";

	const runWorker = (extraEnv) =>
		new Promise((resolve) => {
			const child = spawn("node", ["worker/index.js"], {
				cwd: WORKER_DIR,
				env: { ...process.env, ...extraEnv },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			let errOut = "";
			child.stdout.on("data", (d) => (out += d.toString()));
			child.stderr.on("data", (d) => (errOut += d.toString()));
			resolve({ child, out: () => out, errOut: () => errOut });
		});

	// (a) healthy loop: publisher + backup + maintenance + metrics, right auth.
	const w1 = await runWorker({ APP_URL, CRON_SECRET, WORKER_INTERVAL });
	const publisherCallOk = await waitFor(
		() => requests.some((r) => r.url === "/api/cron/publisher" && r.method === "POST" && r.auth === CRON_SECRET),
		15_000,
	);
	const allFourCalled = await waitFor(
		() =>
			["/api/cron/publisher", "/api/cron/backup", "/api/cron/maintenance", "/api/cron/metrics"].every((u) =>
				requests.some((r) => r.url === u),
			),
		15_000,
	);
	const firstPublisherTs = (requests.find((r) => r.url === "/api/cron/publisher") || {}).ts || 0;

	// (b) 5xx → logged, process stays alive, next loop still fires.
	writeFileSync(modeFile, "publisher-500");
	const got500 = await waitFor(
		() => requests.filter((r) => r.url === "/api/cron/publisher").length >= 2,
		15_000,
	);
	await sleep(1500); // let the worker log the error
	const err500 = w1.errOut().includes("HTTP 500");
	const stillAlive = w1.child.exitCode === null;

	// (c) interval spacing (recursive setTimeout — no backoff, documented).
	const publisherTs = requests.filter((r) => r.url === "/api/cron/publisher").map((r) => r.ts);
	let gapOk = true;
	for (let i = 1; i < publisherTs.length; i++) {
		const gapSec = (publisherTs[i] - publisherTs[i - 1]) / 1000;
		if (gapSec < 5) gapOk = false; // min interval 5s; with 8s config gaps must be ≥ ~5s
	}

	w1.child.kill("SIGTERM");
	await sleep(500);

	// (d) missing CRON_SECRET → exit(1) fast.
	const noSecret = await new Promise((resolve) => {
		const child = spawn("node", ["worker/index.js"], {
			cwd: WORKER_DIR,
			env: { ...process.env, APP_URL },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let errText = "";
		child.stderr.on("data", (d) => (errText += d.toString()));
		child.on("exit", (code) => resolve({ code, errText }));
	});

	server.close();

	const pass =
		publisherCallOk &&
		allFourCalled &&
		firstPublisherTs > 0 &&
		got500 && err500 && stillAlive &&
		gapOk &&
		noSecret.code === 1 &&
		noSecret.errText.includes("CRON_SECRET");
	record(
		"I6",
		Boolean(pass),
		`worker: publisherPOST+auth=${publisherCallOk} all4Endpoints=${allFourCalled} 500logged=${err500} aliveAfter500=${stillAlive} intervalGapOk=${gapOk}(gaps=${publisherTs.map((t, i) => (i ? ((t - publisherTs[i - 1]) / 1000).toFixed(0) : 0)).join(",")}s) missingSecretExit=${noSecret.code} (no backoff: fixed recursive-setTimeout interval — documented)`,
		{ publisherCallOk, allFourCalled, got500, err500, gapOk, noSecretExit: noSecret.code, publisherCalls: publisherTs.length },
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════
for (const [label, fn] of [
	["I5", scenarioI5],
	["I6", scenarioI6],
]) {
	try {
		await fn();
	} catch (err) {
		resultsTotal.push({ scenario: label, pass: false, line: `EXCEPTION: ${err?.message || err}` });
		console.error(`SCENARIO ${label}: EXCEPTION — ${err?.stack || err}`);
	}
}
const anyPass = resultsTotal.filter((r) => r.pass).length;
console.log("\n=== SUMMARY ===");
for (const r of resultsTotal) console.log(`${r.scenario}: ${r.pass ? "PASS" : "FAIL"} — ${r.line}`);
console.log(`\nTOTAL: ${anyPass}/${resultsTotal.length} pass`);

try {
	writeFileSync(join(OUT_DIR, "auth-worker-summary.txt"), resultsTotal.map((r) => `${r.scenario}: ${r.pass ? "PASS" : "FAIL"} — ${r.line}`).join("\n"));
} catch {
	/* ignore */
}
process.exit(anyPass === resultsTotal.length ? 0 : 1);
