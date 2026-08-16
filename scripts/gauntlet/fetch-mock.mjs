#!/usr/bin/env node
/**
 * Publisher gauntlet — preload fetch mock.
 *
 * Loaded into the STANDALONE SERVER process via
 *   node --import <abs>/scripts/gauntlet/fetch-mock.mjs server.js
 * (see boot.sh).
 *
 * It patches globalThis.fetch so the Instagram/Facebook Graph API is emulated
 * deterministically and the notification webhook is recorded — no real IG call
 * can ever leave the machine, because matching hosts never reach the network.
 *
 * Interface (all via env, set by boot.sh):
 *   IG_MOCK_STATE  — JSON file: { "rules": [rule...], "consumed": {idx: n} }
 *                    boot.sh/mock both read/write this file.
 *   IG_MOCK_CALLS  — JSONL file; EVERY mocked request appends one line:
 *                    {ts, method, url, body, status, kind}
 *
 * Rule: { match?, matchBody?, matchRegex?, method?, responses: [{status?, body?, delayMs?}] }
 *   - match      : substring of the full URL (e.g. "media_publish", "?fields=status_code")
 *   - matchBody  : substring of the (URL-encoded) request body — distinguishes
 *                  carousel children by their media URL
 *   - matchRegex : string compiled to RegExp, tested against the full URL
 *   - method     : GET/POST (case-insensitive), optional
 *   - responses  : FIFO, index by "consumed" for the rule; last entry repeats
 *   - status/body/delayMs/headers on each response
 * If several rules match, the first wins. No rule matches a mock host → 404
 * {"error":{"message":"UNMATCHED_MOCK …"}} (recorded, so it shows up in asserts).
 * Everything that is not a mock host passes through to the original fetch.
 */
import {
	readFileSync,
	writeFileSync,
	appendFileSync,
	renameSync,
	existsSync,
} from "node:fs";

const STATE_FILE = process.env.IG_MOCK_STATE;
const CALLS_FILE = process.env.IG_MOCK_CALLS;
const FIXTURE_STATE_FILE = process.env.IG_FIXTURE_STATE;
const FIXTURE_HOST = process.env.IG_FIXTURE_HOST || "example.com";
const MOCK_HOSTS = new Set([
	"graph.instagram.com",
	"graph.facebook.com",
	"api.instagram.com",
	"mock-webhook.invalid",
]);

const originalFetch = globalThis.fetch;

function readState() {
	if (!STATE_FILE || !existsSync(STATE_FILE))
		return { rules: [], consumed: {} };
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return { rules: [], consumed: {} };
	}
}

function writeState(state) {
	if (!STATE_FILE) return;
	try {
		// Atomic write (temp file + rename): a torn write of the state file could
		// otherwise be read mid-flight by the server and mis-route a request
		// (the M3(a) flake seen in rounds 065951 vs 070031).
		const tmp = `${STATE_FILE}.tmp`;
		writeFileSync(tmp, JSON.stringify(state));
		renameSync(tmp, STATE_FILE);
	} catch {
		/* mock must never crash the server */
	}
}

function recordCall(entry) {
	if (!CALLS_FILE) return;
	try {
		appendFileSync(CALLS_FILE, JSON.stringify(entry) + "\n");
	} catch {
		/* ignore */
	}
}

function ruleMatches(rule, url, method, body) {
	if (rule.method && rule.method.toUpperCase() !== method) return false;
	if (rule.match && !url.includes(rule.match)) return false;
	if (rule.matchRegex) {
		try {
			if (!new RegExp(rule.matchRegex).test(url)) return false;
		} catch {
			return false;
		}
	}
	if (rule.matchBody && !body.includes(rule.matchBody)) return false;
	return true;
}

function buildResponse(response) {
	const { status = 200, body = {}, headers = {} } = response || {};
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Response(text, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

async function respondWithDelay(response, signal) {
	const delayMs = response?.delayMs || 0;
	if (delayMs <= 0) return buildResponse(response);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(buildResponse(response)), delayMs);
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(new DOMException("Aborted", "AbortError"));
				},
				{ once: true },
			);
		}
	});
}

async function mockedFetch(url, options, host) {
	const method = (options?.method || "GET").toUpperCase();
	let body = "";
	if (options?.body) {
		body =
			typeof options.body === "string"
				? options.body.slice(0, 500)
				: String(options.body);
	}

	const state = readState();
	const rules = state.rules || [];
	const consumed = state.consumed || {};

	for (let i = 0; i < rules.length; i++) {
		if (!ruleMatches(rules[i], url, method, body)) continue;
		const count = Number(consumed[i] || 0);
		consumed[i] = count + 1;
		writeState(state);
		const responses = rules[i].responses || [];
		const response = responses[Math.min(count, responses.length - 1)];
		const status = response?.status || 200;
		recordCall({
			ts: Date.now(),
			method,
			url: url.slice(0, 300),
			body,
			status,
			kind: "mock",
		});
		return respondWithDelay(response, options?.signal);
	}

	recordCall({
		ts: Date.now(),
		method,
		url: url.slice(0, 300),
		body,
		status: 404,
		kind: "unmatched",
	});
	return buildResponse({
		status: 404,
		body: {
			error: {
				message: `UNMATCHED_MOCK host=${host} url=${url.slice(0, 200)}`,
			},
		},
	});
}

// ── Import-url FIXTURE host (module-07): deterministic download responses for
//    a PUBLIC hostname (example.com passes the app's SSRF DNS guard). Active
//    ONLY when IG_FIXTURE_STATE is set — every other harness leaves it unset
//    and this section is inert. The route fetches the fixture host for real
//    (redirects followed in-process) so res.url stays meaningful.
function readFixtureState() {
	if (!FIXTURE_STATE_FILE || !existsSync(FIXTURE_STATE_FILE)) return { routes: {} };
	try {
		return JSON.parse(readFileSync(FIXTURE_STATE_FILE, "utf8"));
	} catch {
		return { routes: {} };
	}
}

function fixtureChunkStream(total, chunkSize = 64 * 1024) {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= total) {
				controller.close();
				return;
			}
			const n = Math.min(chunkSize, total - sent);
			controller.enqueue(new Uint8Array(n).fill(65));
			sent += n;
		},
		cancel() {
			/* consumer aborted — stop producing */
		},
	});
}

function fixtureDelay(signal, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (signal) {
			if (signal.aborted) {
				clearTimeout(t);
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			signal.addEventListener("abort", () => {
				clearTimeout(t);
				reject(new DOMException("Aborted", "AbortError"));
			}, { once: true });
		}
	});
}

function fixtureWithUrl(res, url) {
	try {
		Object.defineProperty(res, "url", { value: url, configurable: true });
	} catch {
		/* ignore */
	}
	return res;
}

async function fixtureHandle(pathname, finalUrl, signal) {
	const state = readFixtureState();
	const route = state.routes?.[pathname];
	if (!route) {
		recordCall({ ts: Date.now(), method: "GET", url: finalUrl.slice(0, 300), status: 404, kind: "fixture-unmatched" });
		return fixtureWithUrl(
			new Response(JSON.stringify({ error: "UNMATCHED_FIXTURE", path: pathname }), {
				status: 404,
				headers: { "content-type": "application/json" },
			}),
			finalUrl,
		);
	}
	const { status = 200, contentType = "application/octet-stream", size = 0, bodyText = null, delayMs = 0, redirectTo = null } = route;
	if (delayMs > 0) await fixtureDelay(signal, delayMs);
	if (redirectTo) {
		const target = new URL(redirectTo, `https://${FIXTURE_HOST}`).toString();
		return fixtureHandle(new URL(target).pathname, target, signal);
	}
	recordCall({ ts: Date.now(), method: "GET", url: finalUrl.slice(0, 300), status, kind: "fixture-hit" });
	const headers = { "content-type": contentType };
	let body;
	if (bodyText !== null) body = bodyText;
	else if (size > 0) body = fixtureChunkStream(size);
	else body = "";
	return fixtureWithUrl(new Response(body, { status, headers }), finalUrl);
}

// ── Patched fetch ─────────────────────────────────────────────────────────────

globalThis.fetch = async function patchedFetch(input, options = {}) {
	let url;
	let method;
	try {
		if (typeof input === "string") {
			url = input;
			method = (options?.method || "GET").toUpperCase();
		} else {
			url = input.url;
			method = (options?.method || input.method || "GET").toUpperCase();
		}
	} catch {
		return originalFetch(input, options);
	}

	let host = "";
	try {
		host = new URL(url).hostname;
	} catch {
		return originalFetch(input, options);
	}

	if (FIXTURE_STATE_FILE && host === FIXTURE_HOST) {
		// Module-07 import-url fixture (active only when IG_FIXTURE_STATE is set;
		// FIXTURE_HOST is a MOCK host so the route's fetch is reliably intercepted
		// — checked BEFORE the rules engine). res.url is set so the route's
		// redirect re-validation sees the final URL.
		const pathname = new URL(url).pathname;
		return fixtureHandle(pathname, url, options?.signal);
	}

	if (!MOCK_HOSTS.has(host)) {
		return originalFetch(input, options);
	}

	if (host === "mock-webhook.invalid") {
		recordCall({
			ts: Date.now(),
			method,
			url: url.slice(0, 300),
			body: "",
			status: 200,
			kind: "notify",
		});
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	return mockedFetch(url, options, host);
};
