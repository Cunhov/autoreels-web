#!/usr/bin/env node
/**
 * Module-07 gauntlet — preload fetch fixture for /api/import-url.
 *
 * Loaded into the STANDALONE SERVER process AFTER fetch-mock.mjs:
 *   node --import fetch-mock.mjs --import import-fixture.mjs server.js
 *
 * The app's import-url route refuses loopback/private hosts (SSRF guard —
 * verified as a scenario) so a local fixture server is UNREACHABLE through the
 * real route. Instead this preload hijacks a PUBLIC hostname (FIXTURE_HOST,
 * default example.com — passes the guard's DNS check) and serves deterministic
 * fixture content: bytes, status codes, content-types, redirects, delays.
 * No real example.com traffic ever leaves the machine for a matched route;
 * unmatched fixture-host paths return a deterministic 404 (never passthrough).
 * Everything else delegates to the previous fetch (fetch-mock's wrapper).
 *
 * Interface (env, set by import-run.sh):
 *   IG_FIXTURE_STATE — JSON file: { "routes": { "<pathname>": {
 *       status, contentType, size (bytes, streamed), bodyText,
 *       delayMs, redirectTo } } }
 *   IG_FIXTURE_HOST — the host to hijack (default example.com)
 *
 * Redirects are followed in-process (same host) so res.url reflects the final
 * URL — the route re-validates the redirect target host against the SSRF guard.
 */
import { readFileSync, existsSync } from "node:fs";

const STATE_FILE = process.env.IG_FIXTURE_STATE;
const FIXTURE_HOST = process.env.IG_FIXTURE_HOST || "example.com";
const prevFetch = globalThis.fetch;

function readState() {
	if (!STATE_FILE || !existsSync(STATE_FILE)) return { routes: {} };
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return { routes: {} };
	}
}

/** Stream `total` bytes in chunks without buffering (oversized case: 310MB). */
function chunkStream(total, chunkSize = 64 * 1024) {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= total) {
				controller.close();
				return;
			}
			const n = Math.min(chunkSize, total - sent);
			controller.enqueue(new Uint8Array(n).fill(65)); // 'A'
			sent += n;
		},
		cancel() {
			/* consumer aborted (size cap / timeout) — stop producing */
		},
	});
}

function delay(signal, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (signal) {
			if (signal.aborted) {
				clearTimeout(t);
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					reject(new DOMException("Aborted", "AbortError"));
				},
				{ once: true },
			);
		}
	});
}

/** Response.url is read-only from the constructor — define an own property. */
function withUrl(res, url) {
	try {
		Object.defineProperty(res, "url", { value: url, configurable: true });
	} catch {
		/* ignore */
	}
	return res;
}

async function handle(pathname, finalUrl, signal) {
	const state = readState();
	const route = state.routes?.[pathname];
	if (!route) {
		return withUrl(
			new Response(JSON.stringify({ error: "UNMATCHED_FIXTURE", path: pathname }), {
				status: 404,
				headers: { "content-type": "application/json" },
			}),
			finalUrl,
		);
	}
	const { status = 200, contentType = "application/octet-stream", size = 0, bodyText = null, delayMs = 0, redirectTo = null } = route;
	if (delayMs > 0) await delay(signal, delayMs);
	if (redirectTo) {
		const target = new URL(redirectTo, `https://${FIXTURE_HOST}`).toString();
		return handle(new URL(target).pathname, target, signal);
	}
	const headers = { "content-type": contentType };
	let body;
	if (bodyText !== null) body = bodyText;
	else if (size > 0) body = chunkStream(size);
	else body = "";
	const res = new Response(body, { status, headers });
	return withUrl(res, finalUrl);
}

globalThis.fetch = async function patchedFixtureFetch(input, options = {}) {
	let url;
	try {
		url = typeof input === "string" ? input : input.url;
	} catch {
		return prevFetch(input, options);
	}
	let host;
	try {
		host = new URL(url).hostname;
	} catch {
		return prevFetch(input, options);
	}
	if (host !== FIXTURE_HOST) return prevFetch(input, options);
	const pathname = new URL(url).pathname;
	return handle(pathname, url, options?.signal);
};
