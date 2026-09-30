#!/usr/bin/env node
/**
 * Autoreels Publisher Worker
 * ──────────────────────────
 * Standalone Node.js process that calls /api/cron/publisher on a configurable
 * interval. Designed to run in a separate Docker container so the Next.js app
 * doesn't need any external cron scheduler.
 *
 * Environment Variables:
 *   APP_URL          - Base URL of the Next.js app  (default: http://app:${PORT:-80})
 *   CRON_SECRET      - Must match the app's CRON_SECRET env var
 *   WORKER_INTERVAL  - Interval between runs in seconds (default: 60, min 5)
 *   AUTOMATION_INTERVAL - Min seconds between automation queue runs (default: 15, min 5)
 *
 * Also calls /api/cron/backup (idempotent — the route decides whether it is
 * time to run) roughly every 6 hours.
 */

'use strict';

// The app may listen on a non-default port (Easypanel sets PORT=80).
// Honour PORT when APP_URL is not explicitly provided.
const DEFAULT_APP_PORT = process.env.PORT || '80';
const APP_URL = (process.env.APP_URL || `http://app:${DEFAULT_APP_PORT}`).replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET || '';

const RAW_INTERVAL = process.env.WORKER_INTERVAL || '60';
let INTERVAL_SEC = parseInt(RAW_INTERVAL, 10);
if (!Number.isFinite(INTERVAL_SEC) || INTERVAL_SEC < 5) {
    console.error(`[${new Date().toISOString()}] ❌ Invalid WORKER_INTERVAL "${RAW_INTERVAL}" — falling back to 60s (min 5s).`);
    INTERVAL_SEC = 60;
}
const INTERVAL_MS = INTERVAL_SEC * 1000;
const ENDPOINT = `${APP_URL}/api/cron/publisher`;
const BACKUP_ENDPOINT = `${APP_URL}/api/cron/backup`;
const MAINTENANCE_ENDPOINT = `${APP_URL}/api/cron/maintenance`;
const METRICS_ENDPOINT = `${APP_URL}/api/cron/metrics`;
const AUTOMATION_ENDPOINT = `${APP_URL}/api/cron/automation`;
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // attempt backup roughly every 6h
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000; // retention/cleanup roughly once a day
const METRICS_INTERVAL_MS = 30 * 60 * 1000; // sync IG metrics roughly every 30 min

const RAW_AUTOMATION_INTERVAL = process.env.AUTOMATION_INTERVAL || '15';
let AUTOMATION_INTERVAL_SEC = parseInt(RAW_AUTOMATION_INTERVAL, 10);
if (!Number.isFinite(AUTOMATION_INTERVAL_SEC) || AUTOMATION_INTERVAL_SEC < 5) {
    console.error(`[${new Date().toISOString()}] ❌ Invalid AUTOMATION_INTERVAL "${RAW_AUTOMATION_INTERVAL}" — falling back to 15s (min 5s).`);
    AUTOMATION_INTERVAL_SEC = 15;
}
const AUTOMATION_INTERVAL_MS = AUTOMATION_INTERVAL_SEC * 1000;

// ── Coloured log helpers ───────────────────────────────────────────────────────
const ts = () => new Date().toISOString();
const log = (...args) => console.log(`[${ts()}]`, ...args);
const err = (...args) => console.error(`[${ts()}] ❌`, ...args);

// ── Single publisher run ───────────────────────────────────────────────────────
async function runPublisher() {
    log('▶ Running publisher...');
    const startedAt = Date.now();
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
        const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        log(`✅ Result (${durationSec}s):`, JSON.stringify(data));
        if (data && data.timeout) {
            err('Publisher hit its execution budget — consider a shorter WORKER_INTERVAL or faster runs.');
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            err(`Request timed out (exceeded interval minus 5s)`);
        } else {
            err('Fetch failed:', e.message);
        }
    }
}

// ── Daily backup (idempotent route, self-gating) ───────────────────────────────
let lastBackupAttemptAt = 0;

async function maybeRunBackup() {
    if (Date.now() - lastBackupAttemptAt < BACKUP_INTERVAL_MS) return;
    lastBackupAttemptAt = Date.now();

    log('▶ Running daily backup...');
    try {
        const res = await fetch(BACKUP_ENDPOINT, {
            method: 'POST',
            headers: { 'x-cron-auth': CRON_SECRET },
        });
        const body = await res.text().catch(() => '(no body)');
        if (res.ok) {
            log('✅ Backup:', body);
        } else {
            err(`Backup HTTP ${res.status}: ${body}`);
        }
    } catch (e) {
        err('Backup failed:', e.message);
    }
}

// ── Daily maintenance (retention/cleanup — idempotent route, self-gating) ──────
let lastMaintenanceAt = 0;

async function maybeRunMaintenance() {
    if (Date.now() - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
    lastMaintenanceAt = Date.now();

    log('▶ Running daily maintenance...');
    try {
        const res = await fetch(MAINTENANCE_ENDPOINT, {
            method: 'POST',
            headers: { 'x-cron-auth': CRON_SECRET },
        });
        const body = await res.text().catch(() => '(no body)');
        if (res.ok) {
            log('✅ Maintenance:', body);
        } else {
            err(`Maintenance HTTP ${res.status}: ${body}`);
        }
    } catch (e) {
        err('Maintenance failed:', e.message);
    }
}

// ── Metrics sync (30 min — idempotent route, self-gating) ─────────────────────
let lastMetricsSyncAt = 0;

async function maybeRunMetricsSync() {
    if (Date.now() - lastMetricsSyncAt < METRICS_INTERVAL_MS) return;
    lastMetricsSyncAt = Date.now();

    log('▶ Syncing IG metrics...');
    try {
        const res = await fetch(METRICS_ENDPOINT, {
            method: 'POST',
            headers: { 'x-cron-auth': CRON_SECRET },
        });
        const body = await res.text().catch(() => '(no body)');
        if (res.ok) {
            log('✅ Metrics sync:', body);
        } else {
            err(`Metrics sync HTTP ${res.status}: ${body}`);
        }
    } catch (e) {
        err('Metrics sync failed:', e.message);
    }
}

// ── Automation queue (jobs/sequências/eventos órfãos) ──────────────────────────
let lastAutomationAt = 0;

async function maybeRunAutomation() {
    if (Date.now() - lastAutomationAt < AUTOMATION_INTERVAL_MS) return;
    lastAutomationAt = Date.now();

    const controller = new AbortController();
    // Timeout próprio: não deixa a chamada passar do intervalo dedicado.
    const timeoutMs = Math.max(5000, AUTOMATION_INTERVAL_MS - 2000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(AUTOMATION_ENDPOINT, {
            method: 'POST',
            headers: { 'x-cron-auth': CRON_SECRET },
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const body = await res.text().catch(() => '(no body)');
        if (res.ok) {
            log('🤖 Automações:', body);
        } else {
            err(`Automações HTTP ${res.status}: ${body}`);
        }
    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') {
            err(`Automações: timeout após ${Math.round(timeoutMs / 1000)}s`);
        } else {
            err('Automações falhou:', e.message);
        }
    }
}

// ── Automation loop (dedicado, independente do loop principal) ────────────────
// Recursive setTimeout: re-agenda APÓS cada execução, garantindo
// AUTOMATION_INTERVAL mesmo quando o loop do publisher demora.
async function automationLoop() {
    await maybeRunAutomation();
    setTimeout(automationLoop, AUTOMATION_INTERVAL_MS);
}

// ── Main loop ──────────────────────────────────────────────────────────────────
// Recursive setTimeout: the next run is only scheduled AFTER the previous one
// finishes, so long runs never overlap.
async function loop() {
    await runPublisher();
    await maybeRunBackup();
    await maybeRunMaintenance();
    await maybeRunMetricsSync();
    setTimeout(loop, INTERVAL_MS);
}

async function main() {
    if (!CRON_SECRET) {
        err('CRON_SECRET is not set — worker will be rejected by the app. Exiting.');
        process.exit(1);
    }

    log(`🚀 Worker started`);
    log(`   App URL  : ${APP_URL}`);
    log(`   Endpoint : ${ENDPOINT}`);
    log(`   Interval : ${INTERVAL_SEC}s`);
    log(`   Automação: ${AUTOMATION_ENDPOINT} (min ${AUTOMATION_INTERVAL_SEC}s, loop dedicado)`);

    void automationLoop().catch(e => err('Automation loop fatal:', e.message));
    await loop();
}

main().catch(e => { err('Fatal:', e.message); process.exit(1); });
