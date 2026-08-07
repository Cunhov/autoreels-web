'use client';
import { useState, useEffect, useCallback } from 'react';
import {
    Bell, Clock, Database, HardDrive, RefreshCw, Save, XCircle, CheckCircle2,
    Trash2, RotateCcw
} from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import IOSCard from '@/components/IOSComponents';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SensitiveField { set: boolean; masked: string; }

interface SettingsResponse {
    TELEGRAM_BOT_TOKEN: SensitiveField;
    TELEGRAM_CHAT_ID: string;
    NOTIFY_WEBHOOK_URL: SensitiveField;
    PUBLISH_MIN_INTERVAL_SECONDS: number | null;
    RETENTION_POSTS_DAYS: number | null;
    RETENTION_LOGS_DAYS: number | null;
}

interface BackupInfo { name: string; size: number; mtime: string; }

type ToastState = { msg: string; type: 'ok' | 'err' } | null;

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errMsg(e: unknown, fallback: string): string {
    return e instanceof Error && e.message ? e.message : fallback;
}

function Field({
    label, value, onChange, placeholder, hint, type = 'text', mono,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    hint?: string;
    type?: string;
    mono?: boolean;
}) {
    return (
        <div>
            <label className="text-xs font-medium text-ios-text mb-1.5 block">{label}</label>
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className={`w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400 ${mono ? 'font-mono' : ''}`}
            />
            {hint && <p className="text-[11px] text-ios-text-secondary mt-1">{hint}</p>}
        </div>
    );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [toast, setToast] = useState<ToastState>(null);

    // Form state (inputs always hold raw text; sensitive fields only sent when non-empty)
    const [botToken, setBotToken] = useState('');
    const [chatId, setChatId] = useState('');
    const [webhook, setWebhook] = useState('');
    const [minInterval, setMinInterval] = useState('');
    const [retPosts, setRetPosts] = useState('');
    const [retLogs, setRetLogs] = useState('');

    // Display-only hints for sensitive fields
    const [botTokenState, setBotTokenState] = useState<SensitiveField>({ set: false, masked: '' });
    const [webhookState, setWebhookState] = useState<SensitiveField>({ set: false, masked: '' });

    // Backups
    const [backups, setBackups] = useState<BackupInfo[]>([]);
    const [loadingBackups, setLoadingBackups] = useState(false);
    const [creatingBackup, setCreatingBackup] = useState(false);
    const [restoringName, setRestoringName] = useState<string | null>(null);

    const showToast = useCallback((msg: string, type: 'ok' | 'err' = 'ok') => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3000);
    }, []);

    const loadSettings = useCallback(async () => {
        try {
            const res = await fetch('/api/settings');
            if (!res.ok) throw new Error('Failed to load settings');
            const data = (await res.json()) as SettingsResponse;
            setBotTokenState(data.TELEGRAM_BOT_TOKEN);
            setChatId(data.TELEGRAM_CHAT_ID ?? '');
            setWebhookState(data.NOTIFY_WEBHOOK_URL);
            setMinInterval(data.PUBLISH_MIN_INTERVAL_SECONDS === null ? '' : String(data.PUBLISH_MIN_INTERVAL_SECONDS));
            setRetPosts(data.RETENTION_POSTS_DAYS === null ? '' : String(data.RETENTION_POSTS_DAYS));
            setRetLogs(data.RETENTION_LOGS_DAYS === null ? '' : String(data.RETENTION_LOGS_DAYS));
        } catch (e: unknown) {
            console.error('Error loading settings:', e);
            showToast(errMsg(e, 'Failed to load settings'), 'err');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    const loadBackups = useCallback(async () => {
        setLoadingBackups(true);
        try {
            const res = await fetch('/api/admin/backups');
            if (!res.ok) throw new Error('Failed to load backups');
            const data = await res.json();
            setBackups(Array.isArray(data.backups) ? data.backups : []);
        } catch (e: unknown) {
            console.error('Error loading backups:', e);
            showToast(errMsg(e, 'Failed to load backups'), 'err');
        } finally {
            setLoadingBackups(false);
        }
    }, [showToast]);

    useEffect(() => {
        loadSettings();
        loadBackups();
    }, [loadSettings, loadBackups]);

    async function saveSettings() {
        setSaving(true);
        try {
            const payload: Record<string, string> = {};
            // Sensitive fields: only send when the user typed something (empty = keep current)
            if (botToken.trim() !== '') payload.TELEGRAM_BOT_TOKEN = botToken.trim();
            if (webhook.trim() !== '') payload.NOTIFY_WEBHOOK_URL = webhook.trim();
            // Plain / numeric fields: always send (empty clears)
            payload.TELEGRAM_CHAT_ID = chatId.trim();
            payload.PUBLISH_MIN_INTERVAL_SECONDS = minInterval.trim();
            payload.RETENTION_POSTS_DAYS = retPosts.trim();
            payload.RETENTION_LOGS_DAYS = retLogs.trim();

            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(err.error || 'Failed to save settings');
            }
            setBotToken('');
            setWebhook('');
            await loadSettings();
            showToast('Settings saved ✓');
        } catch (e: unknown) {
            console.error('Error saving settings:', e);
            showToast(errMsg(e, 'Failed to save settings'), 'err');
        } finally {
            setSaving(false);
        }
    }

    async function clearSensitive(key: 'TELEGRAM_BOT_TOKEN' | 'NOTIFY_WEBHOOK_URL') {
        try {
            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: '' }),
            });
            if (!res.ok) throw new Error('Failed to clear');
            if (key === 'TELEGRAM_BOT_TOKEN') setBotToken('');
            else setWebhook('');
            await loadSettings();
            showToast(`${key === 'TELEGRAM_BOT_TOKEN' ? 'Bot token' : 'Webhook'} cleared`);
        } catch (e: unknown) {
            console.error(e);
            showToast(errMsg(e, 'Failed to clear value'), 'err');
        }
    }

    async function createBackup() {
        setCreatingBackup(true);
        try {
            const res = await fetch('/api/admin/backups', { method: 'POST' });
            if (!res.ok) throw new Error('Failed to create backup');
            await loadBackups();
            showToast('Backup created ✓');
        } catch (e: unknown) {
            console.error(e);
            showToast(errMsg(e, 'Failed to create backup'), 'err');
        } finally {
            setCreatingBackup(false);
        }
    }

    async function restoreBackup(filename: string) {
        const ok = window.confirm(
            `Restore ${filename}?\n\nThis REPLACES the current database with this backup and restarts the app. A safety copy of the current DB is created first.`
        );
        if (!ok) return;
        setRestoringName(filename);
        try {
            const res = await fetch('/api/admin/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename }),
            });
            const data = await res.json().catch(() => ({})) as { error?: string; restarted?: boolean };
            if (!res.ok) throw new Error(data.error || 'Restore failed');
            showToast('Restored — the app will restart now');
        } catch (e: unknown) {
            console.error(e);
            showToast(errMsg(e, 'Restore failed'), 'err');
        } finally {
            setRestoringName(null);
        }
    }

    if (loading) {
        return (
            <div className="flex justify-center p-20">
                <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div className="space-y-6 pb-8">
            {/* Toast */}
            {toast && (
                <div className={`fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-xl text-white text-[14px] font-medium shadow-xl slide-in-from-top-2 ${toast.type === 'ok' ? 'bg-ios-green' : 'bg-ios-red'}`}>
                    {toast.type === 'ok' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                    {toast.msg}
                </div>
            )}

            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-[34px] font-bold text-ios-text">Settings</h1>
                    <p className="text-ios-text-secondary text-sm">Notifications, publishing limits, retention & backups</p>
                </div>
            </div>

            {/* ── Notifications ── */}
            <IOSCard className="p-5">
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-9 h-9 rounded-xl bg-ios-blue/10 flex items-center justify-center text-ios-blue">
                        <Bell size={18} />
                    </div>
                    <h3 className="text-[17px] font-bold text-ios-text">Notifications</h3>
                </div>
                <div className="space-y-4">
                    <div>
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-ios-text mb-1.5 block">Telegram Bot Token</label>
                            {botTokenState.set && (
                                <button
                                    onClick={() => clearSensitive('TELEGRAM_BOT_TOKEN')}
                                    className="text-[10px] text-ios-red flex items-center gap-1 hover:underline"
                                >
                                    <Trash2 size={10} /> Clear ({botTokenState.masked})
                                </button>
                            )}
                        </div>
                        <input
                            value={botToken}
                            onChange={(e) => setBotToken(e.target.value)}
                            type="password"
                            placeholder={botTokenState.set ? `Set — leave empty to keep (${botTokenState.masked})` : 'Paste bot token from @BotFather'}
                            className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400 font-mono"
                        />
                        <p className="text-[11px] text-ios-text-secondary mt-1">Used to alert you when a post fails or the run finishes with errors.</p>
                    </div>

                    <Field
                        label="Telegram Chat ID"
                        value={chatId}
                        onChange={setChatId}
                        placeholder="e.g. 123456789 or @yourusername"
                        hint="Numeric ID or @username of the chat that receives alerts."
                    />

                    <div>
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-ios-text mb-1.5 block">Webhook URL (alternative)</label>
                            {webhookState.set && (
                                <button
                                    onClick={() => clearSensitive('NOTIFY_WEBHOOK_URL')}
                                    className="text-[10px] text-ios-red flex items-center gap-1 hover:underline"
                                >
                                    <Trash2 size={10} /> Clear ({webhookState.masked})
                                </button>
                            )}
                        </div>
                        <input
                            value={webhook}
                            onChange={(e) => setWebhook(e.target.value)}
                            type="url"
                            placeholder={webhookState.set ? `Set — leave empty to keep (${webhookState.masked})` : 'https://hooks.example.com/...'}
                            className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400 font-mono"
                        />
                        <p className="text-[11px] text-ios-text-secondary mt-1">If set, receives POST JSON {"{text, ts}"} for every alert (used when Telegram is not configured).</p>
                    </div>
                </div>
            </IOSCard>

            {/* ── Publishing ── */}
            <IOSCard className="p-5">
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-9 h-9 rounded-xl bg-ios-green/10 flex items-center justify-center text-ios-green">
                        <Clock size={18} />
                    </div>
                    <h3 className="text-[17px] font-bold text-ios-text">Publishing</h3>
                </div>
                <Field
                    label="Min interval between posts (same channel, seconds)"
                    value={minInterval}
                    onChange={setMinInterval}
                    type="number"
                    placeholder="e.g. 300"
                    hint="The cron skips a post if the channel published less than this many seconds ago. 0 or empty = no limit. Helps avoid Instagram rate limits (429)."
                />
            </IOSCard>

            {/* ── Retention ── */}
            <IOSCard className="p-5">
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-9 h-9 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-500">
                        <Database size={18} />
                    </div>
                    <h3 className="text-[17px] font-bold text-ios-text">Data Retention</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field
                        label="Keep posts for (days)"
                        value={retPosts}
                        onChange={setRetPosts}
                        type="number"
                        placeholder="90"
                        hint="Published/failed/cancelled posts older than this are deleted by the daily maintenance job. Empty = default 90."
                    />
                    <Field
                        label="Keep planner logs for (days)"
                        value={retLogs}
                        onChange={setRetLogs}
                        type="number"
                        placeholder="30"
                        hint="Planner logs older than this are deleted. Empty = default 30."
                    />
                </div>
            </IOSCard>

            {/* ── Backups ── */}
            <IOSCard className="p-5">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                        <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-600">
                            <HardDrive size={18} />
                        </div>
                        <h3 className="text-[17px] font-bold text-ios-text">Backups</h3>
                    </div>
                    <IOSButton
                        variant="secondary"
                        className="!py-2 !px-3 flex items-center gap-1"
                        onClick={createBackup}
                        disabled={creatingBackup}
                    >
                        <RefreshCw size={14} className={creatingBackup ? 'animate-spin' : ''} />
                        Create now
                    </IOSButton>
                </div>
                <p className="text-[12px] text-ios-text-secondary mb-3">
                    Daily backups are stored in /app/data/backups (kept: 7 most recent). Restoring replaces the current database and restarts the app.
                </p>
                {loadingBackups ? (
                    <div className="flex justify-center py-6 text-ios-text-secondary">
                        <RefreshCw size={16} className="animate-spin mr-2" /> Loading backups...
                    </div>
                ) : backups.length === 0 ? (
                    <div className="py-6 text-center text-ios-text-secondary text-sm">
                        <Database size={28} className="mx-auto mb-2 opacity-20" />
                        No backups yet — the daily job will create the first one.
                    </div>
                ) : (
                    <div className="divide-y divide-ios-separator rounded-xl border border-ios-separator overflow-hidden">
                        {backups.map((b) => (
                            <div key={b.name} className="flex items-center gap-3 px-3 py-2.5 bg-ios-background">
                                <div className="flex-1 min-w-0">
                                    <p className="text-[13px] font-medium text-ios-text font-mono truncate">{b.name}</p>
                                    <p className="text-[10px] text-ios-text-secondary">
                                        {formatBytes(b.size)} · {b.mtime ? new Date(b.mtime).toLocaleString() : ''}
                                    </p>
                                </div>
                                <button
                                    onClick={() => restoreBackup(b.name)}
                                    disabled={restoringName === b.name}
                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-ios-red hover:bg-ios-red/10 transition-colors disabled:opacity-50"
                                >
                                    {restoringName === b.name ? <RefreshCw size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                                    Restore
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </IOSCard>

            {/* ── Save bar ── */}
            <div className="sticky bottom-4 flex justify-end">
                <IOSButton variant="primary" className="flex items-center gap-2" onClick={saveSettings} disabled={saving}>
                    {saving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
                    Save Settings
                </IOSButton>
            </div>
        </div>
    );
}
