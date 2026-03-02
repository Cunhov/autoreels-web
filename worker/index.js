#!/usr/bin/env node
/**
 * Autoreels Publisher Worker
 * ──────────────────────────
 * Standalone Node.js process that calls /api/cron/publisher on a configurable
 * interval. Designed to run in a separate Docker container so the Next.js app
 * doesn't need any external cron scheduler.
 *
 * Environment Variables:
 *   APP_URL          - Base URL of the Next.js app  (default: http://app:80)
 *   CRON_SECRET      - Must match the app's CRON_SECRET env var
 *   WORKER_INTERVAL  - Interval between runs in seconds (default: 60)
 */

'use strict';

const APP_URL = (process.env.APP_URL || 'http://app:80').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET || '';
const INTERVAL_SEC = parseInt(process.env.WORKER_INTERVAL || '60', 10);
const INTERVAL_MS = INTERVAL_SEC * 1000;
const ENDPOINT = `${APP_URL}/api/cron/publisher`;

// ── Coloured log helpers ───────────────────────────────────────────────────────
const ts = () => new Date().toISOString();
const log = (...args) => console.log(`[${ts()}]`, ...args);
const err = (...args) => console.error(`[${ts()}] ❌`, ...args);

// ── Single publisher run ───────────────────────────────────────────────────────
async function runPublisher() {
    log('▶ Running publisher...');
    try {
        const controller = new AbortController();
        // Abort if the request takes longer than the interval itself
        const timeout = setTimeout(() => controller.abort(), INTERVAL_MS - 5000);

        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-cron-auth': CRON_SECRET,
            },
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!res.ok) {
            const body = await res.text().catch(() => '(no body)');
            err(`HTTP ${res.status}: ${body}`);
            return;
        }

        const data = await res.json();
        log('✅ Result:', JSON.stringify(data));
    } catch (e) {
        if (e.name === 'AbortError') {
            err('Request timed out (exceeded interval minus 5s)');
        } else {
            err('Fetch failed:', e.message);
        }
    }
}

// ── Main loop ──────────────────────────────────────────────────────────────────
async function main() {
    if (!CRON_SECRET) {
        err('CRON_SECRET is not set — worker will be rejected by the app. Exiting.');
        process.exit(1);
    }

    log(`🚀 Worker started`);
    log(`   App URL  : ${APP_URL}`);
    log(`   Endpoint : ${ENDPOINT}`);
    log(`   Interval : ${INTERVAL_SEC}s`);

    // Run once immediately on start, then on interval
    await runPublisher();

    setInterval(runPublisher, INTERVAL_MS);
}

main().catch(e => { err('Fatal:', e.message); process.exit(1); });
