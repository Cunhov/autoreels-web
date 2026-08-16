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
	existsSync,
} from "node:fs";

const STATE_FILE = process.env.IG_MOCK_STATE;
const CALLS_FILE = process.env.IG_MOCK_CALLS;
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
		writeFileSync(STATE_FILE, JSON.stringify(state));
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
