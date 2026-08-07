import { prisma } from '@/lib/prisma';

/**
 * Failure/status notifications for the publisher pipeline.
 *
 * Delivery channels (both optional, read from AppConfig):
 *   - Telegram : TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID → sendMessage
 *   - Webhook  : NOTIFY_WEBHOOK_URL → POST JSON { text, ts, level }
 *
 * If neither is configured, the call is a silent no-op. This function NEVER
 * throws — notification failures are logged and swallowed so they can never
 * break the publisher pipeline.
 */
export async function sendNotification(
    message: string,
    opts: { level?: 'info' | 'error' } = {}
): Promise<void> {
    try {
        const rows = await prisma.appConfig.findMany({
            where: { key: { in: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'NOTIFY_WEBHOOK_URL'] } },
        });
        const cfg: Record<string, string> = {};
        for (const row of rows) {
            if (row.value) cfg[row.key] = row.value;
        }

        const botToken = cfg.TELEGRAM_BOT_TOKEN;
        const chatId = cfg.TELEGRAM_CHAT_ID;
        if (botToken && chatId) {
            const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) {
                console.error(`[notify] Telegram HTTP ${res.status}:`, (await res.text().catch(() => '')).slice(0, 200));
            }
            return;
        }

        const webhook = cfg.NOTIFY_WEBHOOK_URL;
        if (webhook) {
            const res = await fetch(webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: message, ts: new Date().toISOString(), level: opts.level || 'info' }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) {
                console.error(`[notify] Webhook HTTP ${res.status}:`, (await res.text().catch(() => '')).slice(0, 200));
            }
        }
    } catch (e) {
        console.error('[notify] sendNotification failed:', e instanceof Error ? e.message : e);
    }
}
