'use client';
import { useState, useEffect, useMemo } from 'react';
import {
    Sliders, Plus, Play, Pause, Trash2, Calendar, Terminal, Eye,
    X, RefreshCw, Zap, CheckCircle2, XCircle, Clock, Instagram
} from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import IOSCard from '@/components/IOSComponents';
import PlannerWizard from '@/components/PlannerWizard';

interface Planner {
    id: string;
    name: string;
    config: any;
    status: string;
    channels: any[];
    last_run?: string;
    created_at: string;
    stats?: { total: number; published: number; failed: number };
}

function frequencyText(config: any): string {
    const freq = config?.frequency;
    if (!freq) return 'On demand';
    const v = freq.value;
    const u = freq.unit;
    if (v === 1) {
        const s: Record<string, string> = { minutes: 'Every minute', hours: 'Every hour', days: 'Every day', weeks: 'Every week' };
        return s[u] ?? `Every ${v} ${u}`;
    }
    return `Every ${v} ${u}`;
}

function relativeTime(dateStr?: string): string {
    if (!dateStr) return 'Never';
    const diff = Date.now() - new Date(dateStr).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

/**
 * Format a PlannerLog `details` column for display.
 * The cron stores it as a JSON string; older versions may have stored objects.
 * Returns pretty-printed JSON when parseable, otherwise the raw value.
 */
function formatLogDetails(details: any): string {
    if (details === null || details === undefined) return '';
    let parsed: any = details;
    if (typeof details === 'string') {
        try {
            parsed = JSON.parse(details);
            // Some legacy rows are double-stringified
            if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        } catch {
            return details;
        }
    }
    try {
        return JSON.stringify(parsed, null, 2);
    } catch {
        return typeof details === 'string' ? details : String(details);
    }
}

// Config is persisted as a JSON string (possibly double-stringified by legacy
// versions). Parse it once, defensively, so callers always get an object.
function parsePlannerConfig(config: any): any {
    if (config === null || config === undefined) return {};
    if (typeof config !== 'string') return config;
    try {
        const parsed = JSON.parse(config);
        return typeof parsed === 'string' ? parsePlannerConfig(parsed) : parsed;
    } catch {
        return {};
    }
}

export default function PlannersPage() {
    const [planners, setPlanners] = useState<Planner[]>([]);
    const [loading, setLoading] = useState(true);
    const [isWizardOpen, setIsWizardOpen] = useState(false);
    const [editingPlanner, setEditingPlanner] = useState<Planner | null>(null);
    const [viewingLogs, setViewingLogs] = useState<Planner | null>(null);
    const [logs, setLogs] = useState<any[]>([]);
    const [logFilter, setLogFilter] = useState<'all' | 'info' | 'error'>('all');
    const [loadingLogs, setLoadingLogs] = useState(false);
    const [viewingPreview, setViewingPreview] = useState<Planner | null>(null);
    const [previewData, setPreviewData] = useState<any>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [runningId, setRunningId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);

    const showToast = (msg: string, type: 'ok' | 'err' = 'ok') => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3000);
    };

    useEffect(() => { fetchData(); }, []);

    async function fetchData() {
        setLoading(true);
        try {
            const pr = await fetch('/api/planners');
            if (pr.ok) setPlanners(await pr.json());
            else showToast('Failed to load planners', 'err');
        } catch (e: any) {
            console.error('Error fetching planners:', e);
            showToast('Failed to load planners', 'err');
        } finally { setLoading(false); }
    }

    async function toggleStatus(planner: Planner) {
        const newStatus = planner.status === 'active' ? 'paused' : 'active';
        try {
            const res = await fetch(`/api/planners/${planner.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
            });
            if (!res.ok) throw new Error();
            fetchData();
        } catch { showToast('Failed to update status', 'err'); }
    }

    async function runNow(planner: Planner) {
        setRunningId(planner.id);
        try {
            const res = await fetch(`/api/planners/${planner.id}/run`, { method: 'POST' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error((err as any).error || 'Request failed');
            }
            const data = await res.json();
            showToast(`${planner.name} — ${data.posts_created ?? 'N'} post(s) queued ✓`);
            fetchData();
        } catch (e: any) { showToast(`Run failed: ${e.message}`, 'err'); }
        finally { setRunningId(null); }
    }


    async function confirmDelete() {
        if (!deletingId) return;
        try {
            const res = await fetch(`/api/planners/${deletingId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            setDeletingId(null);
            fetchData();
        } catch { showToast('Failed to delete planner', 'err'); setDeletingId(null); }
    }

    async function fetchLogs(plannerId: string) {
        setLoadingLogs(true);
        try {
            const res = await fetch(`/api/planners/logs/${plannerId}`);
            setLogs(res.ok ? await res.json() : []);
        } catch (e: any) {
            console.error('Error fetching logs:', e);
            showToast('Failed to load logs', 'err');
            setLogs([]);
        } finally { setLoadingLogs(false); }
    }

    useEffect(() => { if (viewingLogs) fetchLogs(viewingLogs.id); }, [viewingLogs]);

    const filteredLogs = useMemo(() => {
        if (logFilter === 'all') return logs;
        return logs.filter(log => log.level === logFilter);
    }, [logs, logFilter]);

    async function fetchPreview(plannerId: string) {
        setLoadingPreview(true);
        try {
            const res = await fetch(`/api/planners/${plannerId}/preview`);
            const data = await res.json().catch(() => ({}));
            setPreviewData(res.ok ? data : { error: data.error || 'Failed to load preview' });
        } catch (e: any) {
            console.error('Error fetching preview:', e);
            setPreviewData({ error: 'Failed to load preview' });
        } finally {
            setLoadingPreview(false);
        }
    }

    useEffect(() => { if (viewingPreview) fetchPreview(viewingPreview.id); }, [viewingPreview]);

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
                    <h1 className="text-[34px] font-bold text-ios-text">Planners</h1>
                    <p className="text-ios-text-secondary text-sm">Automate your posting schedule</p>
                </div>
                <IOSButton variant="primary" className="!py-2 !px-4 flex items-center gap-1" onClick={() => { setEditingPlanner(null); setIsWizardOpen(true); }}>
                    <Plus size={18} />
                    New Planner
                </IOSButton>
            </div>

            {/* Content */}
            {loading ? (
                <div className="flex justify-center p-12">
                    <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
                </div>
            ) : planners.length === 0 ? (
                <IOSCard className="p-12 text-center text-ios-text-secondary">
                    <Sliders size={48} className="mx-auto mb-4 opacity-30" strokeWidth={1} />
                    <h3 className="text-xl font-semibold mb-2 text-ios-text">No planners yet</h3>
                    <p className="max-w-xs mx-auto mb-6">Create a planner to automatically schedule reels on a recurring schedule.</p>
                    <IOSButton variant="primary" className="mx-auto" onClick={() => setIsWizardOpen(true)}>
                        Create Your First Planner
                    </IOSButton>
                </IOSCard>
            ) : (
                <div className="space-y-3">
                    {planners.map(p => {
                        // Ensure config is parsed if it's a string from DB
                        const planner = { ...p, config: parsePlannerConfig(p.config) };

                        const stats = planner.stats ?? { total: 0, published: 0, failed: 0 };
                        const isRunning = runningId === planner.id;
                        return (
                            <IOSCard key={planner.id} className="p-5 group">
                                <div className="flex items-center gap-4">
                                    {/* Status toggle */}
                                    <button
                                        onClick={() => toggleStatus(planner)}
                                        title={planner.status === 'active' ? 'Pause planner' : 'Activate planner'}
                                        className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 transition-all hover:opacity-80 ${planner.status === 'active' ? 'bg-ios-green/15 text-ios-green' : 'bg-ios-gray-5 text-ios-text-secondary'
                                            }`}
                                    >
                                        {planner.status === 'active'
                                            ? <Play size={22} fill="currentColor" />
                                            : <Pause size={22} fill="currentColor" />}
                                    </button>

                                    {/* Info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <h4 className="font-bold text-[16px] text-ios-text">{planner.name}</h4>
                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide ${planner.status === 'active' ? 'bg-ios-green/15 text-ios-green' : 'bg-ios-gray-5 text-ios-text-secondary'
                                                }`}>
                                                {planner.status}
                                            </span>
                                        </div>

                                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[12px] text-ios-text-secondary">
                                            <span className="flex items-center gap-1">
                                                <Calendar size={11} />
                                                {frequencyText(planner.config)}
                                            </span>
                                            <span className="flex items-center gap-1">
                                                <Clock size={11} />
                                                Last: {relativeTime(planner.last_run)}
                                            </span>
                                            <span className="flex items-center gap-1">
                                                <Instagram size={11} />
                                                {(planner.channels || []).length} channels
                                            </span>
                                        </div>

                                        {/* Post counts */}
                                        {stats.total > 0 && (
                                            <div className="flex gap-3 mt-2 text-[11px]">
                                                <span className="text-ios-green font-semibold">✓ {stats.published} published</span>
                                                {stats.failed > 0 && <span className="text-ios-red font-semibold">✗ {stats.failed} failed</span>}
                                                <span className="text-ios-text-secondary">{stats.total} total</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Actions */}
                                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                            onClick={() => runNow(planner)}
                                            disabled={isRunning}
                                            title="Run now"
                                            className="p-2 rounded-lg text-ios-blue hover:bg-ios-blue/10 transition-colors disabled:opacity-50"
                                        >
                                            {isRunning
                                                ? <RefreshCw size={18} className="animate-spin" />
                                                : <Zap size={18} />}
                                        </button>
                                        <button
                                            onClick={() => setViewingLogs(planner)}
                                            title="View logs"
                                            className="p-2 rounded-lg text-ios-text-secondary hover:bg-ios-gray-5 transition-colors"
                                        >
                                            <Terminal size={18} />
                                        </button>
                                        <button
                                            onClick={() => setViewingPreview(planner)}
                                            title="Preview next run"
                                            className="p-2 rounded-lg text-ios-text-secondary hover:bg-ios-gray-5 transition-colors"
                                        >
                                            <Eye size={18} />
                                        </button>
                                        <button
                                            onClick={() => { setEditingPlanner(planner); setIsWizardOpen(true); }}
                                            title="Edit planner"
                                            className="p-2 rounded-lg text-ios-blue hover:bg-ios-blue/10 transition-colors"
                                        >
                                            <Sliders size={18} />
                                        </button>
                                        <button
                                            onClick={() => setDeletingId(planner.id)}
                                            title="Delete planner"
                                            className="p-2 rounded-lg text-ios-red hover:bg-ios-red/10 transition-colors"
                                        >
                                            <Trash2 size={18} />
                                        </button>
                                    </div>
                                </div>
                            </IOSCard>
                        );
                    })}
                </div>
            )}

            {/* Wizard */}
            <PlannerWizard
                isOpen={isWizardOpen}
                onClose={() => { setIsWizardOpen(false); setEditingPlanner(null); }}
                onSuccess={fetchData}
                initialData={editingPlanner}
            />

            {/* Delete Confirmation Modal */}
            {deletingId && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm fade-in">
                    <div className="bg-ios-card w-80 rounded-2xl shadow-2xl overflow-hidden zoom-in-95">
                        <div className="p-6 text-center">
                            <div className="w-12 h-12 rounded-full bg-ios-red/15 flex items-center justify-center mx-auto mb-4">
                                <Trash2 size={22} className="text-ios-red" />
                            </div>
                            <h3 className="text-[17px] font-bold text-ios-text mb-1">Delete Planner?</h3>
                            <p className="text-[14px] text-ios-text-secondary">This action cannot be undone.</p>
                        </div>
                        <div className="border-t border-ios-separator flex">
                            <button
                                onClick={() => setDeletingId(null)}
                                className="flex-1 py-3.5 text-[17px] text-ios-blue font-medium border-r border-ios-separator hover:bg-ios-gray-6 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmDelete}
                                className="flex-1 py-3.5 text-[17px] text-ios-red font-semibold hover:bg-ios-red/10 transition-colors"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Logs Modal */}
            {viewingLogs && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm fade-in">
                    <div className="bg-ios-card w-full max-w-2xl max-h-[80vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden zoom-in-95">
                        <div className="p-5 border-b border-ios-separator flex items-center justify-between">
                            <div>
                                <h2 className="text-[17px] font-bold text-ios-text">Logs: {viewingLogs.name}</h2>
                                <p className="text-[12px] text-ios-text-secondary">Execution history</p>
                            </div>
                            <div className="flex items-center gap-2">
                                {/* Level filter */}
                                <div className="flex rounded-lg border border-ios-separator overflow-hidden">
                                    {(['all', 'info', 'error'] as const).map(lv => (
                                        <button
                                            key={lv}
                                            onClick={() => setLogFilter(lv)}
                                            className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${logFilter === lv ? 'bg-ios-blue text-white' : 'text-ios-text-secondary hover:bg-ios-gray-5'}`}
                                        >
                                            {lv}
                                        </button>
                                    ))}
                                </div>
                                <button onClick={() => fetchLogs(viewingLogs.id)} className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-full transition-colors" disabled={loadingLogs}>
                                    <RefreshCw size={18} className={loadingLogs ? 'animate-spin' : ''} />
                                </button>
                                <button onClick={() => setViewingLogs(null)} className="p-2 text-ios-text-secondary hover:bg-ios-gray-5 rounded-full transition-colors">
                                    <X size={20} />
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar bg-ios-background">
                            {filteredLogs.length === 0 ? (
                                <div className="text-center py-12 text-ios-text-secondary">
                                    <Terminal size={32} className="mx-auto mb-2 opacity-20" />
                                    <p>{logs.length === 0 ? 'No logs found for this planner.' : `No ${logFilter} logs.`}</p>
                                </div>
                            ) : (
                                filteredLogs.map(log => (
                                    <div key={log.id} className="bg-ios-card p-3 rounded-xl border border-ios-separator text-sm">
                                        <div className="flex items-center justify-between mb-1">
                                            <span className={`font-bold uppercase text-[10px] px-1.5 py-0.5 rounded ${log.level === 'error' ? 'bg-ios-red/10 text-ios-red' : 'bg-ios-blue/10 text-ios-blue'}`}>
                                                {log.level}
                                            </span>
                                            <span className="text-[10px] text-ios-text-secondary">{new Date(log.created_at).toLocaleString()}</span>
                                        </div>
                                        <p className="text-ios-text font-medium break-words">{log.message}</p>
                                        {formatLogDetails(log.details) && (
                                            <pre className="mt-2 text-[10px] bg-ios-background p-2 rounded border border-ios-separator overflow-x-auto text-ios-text-secondary max-h-32 whitespace-pre-wrap break-words">
                                                {formatLogDetails(log.details)}
                                            </pre>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Preview Modal */}
            {viewingPreview && (
                <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm fade-in">
                    <div className="bg-ios-card w-full max-w-2xl max-h-[85vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden zoom-in-95">
                        <div className="p-5 border-b border-ios-separator flex items-center justify-between">
                            <div>
                                <h2 className="text-[17px] font-bold text-ios-text">Preview: {viewingPreview.name}</h2>
                                <p className="text-[12px] text-ios-text-secondary">Next run without creating posts</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button onClick={() => fetchPreview(viewingPreview.id)} className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-full transition-colors" disabled={loadingPreview}>
                                    <RefreshCw size={18} className={loadingPreview ? 'animate-spin' : ''} />
                                </button>
                                <button onClick={() => setViewingPreview(null)} className="p-2 text-ios-text-secondary hover:bg-ios-gray-5 rounded-full transition-colors">
                                    <X size={20} />
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-ios-background">
                            {loadingPreview ? (
                                <div className="flex items-center justify-center py-12 text-ios-text-secondary">
                                    <RefreshCw size={18} className="animate-spin mr-2" />
                                    Loading preview...
                                </div>
                            ) : previewData?.error ? (
                                <div className="p-4 rounded-xl bg-ios-red/10 text-ios-red text-sm">
                                    {previewData.error}
                                </div>
                            ) : (
                                <>
                                    {previewData?.runtime?.warnings?.length > 0 && (
                                        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm space-y-1">
                                            {previewData.runtime.warnings.map((warning: string) => (
                                                <div key={warning}>{warning}</div>
                                            ))}
                                        </div>
                                    )}
                                    <div className="grid gap-2">
                                        <div className="bg-ios-card border border-ios-separator rounded-xl p-4">
                                            <div className="text-xs uppercase tracking-wide text-ios-text-secondary mb-1">Selected content</div>
                                            <div className="font-semibold text-ios-text">{previewData?.runtime?.selectedContent?.id || 'No content'}</div>
                                            <div className="text-sm text-ios-text-secondary mt-1">
                                                {previewData?.runtime?.mediaType || 'Unknown'} · {previewData?.runtime?.mediaUrl ? 'Media ready' : 'No media URL'}
                                            </div>
                                        </div>
                                        <div className="bg-ios-card border border-ios-separator rounded-xl p-4">
                                            <div className="text-xs uppercase tracking-wide text-ios-text-secondary mb-1">Caption</div>
                                            <p className="text-sm text-ios-text whitespace-pre-wrap">{previewData?.runtime?.caption || 'No caption'}</p>
                                        </div>
                                        <div className="bg-ios-card border border-ios-separator rounded-xl p-4">
                                            <div className="text-xs uppercase tracking-wide text-ios-text-secondary mb-2">Channels</div>
                                            <div className="space-y-2">
                                                {(previewData?.channels || []).map((channel: any) => (
                                                    <div key={channel.id} className="flex items-start justify-between gap-4 text-sm">
                                                        <div>
                                                            <div className="font-medium text-ios-text">{channel.name}</div>
                                                            <div className="text-ios-text-secondary text-xs">{channel.account_id}</div>
                                                        </div>
                                                        <div className="text-right">
                                                            <div className={channel.health?.ok ? 'text-ios-green' : 'text-ios-red'}>
                                                                {channel.health?.ok ? 'Ready' : 'Blocked'}
                                                            </div>
                                                            {(channel.health?.warnings || []).length > 0 && (
                                                                <div className="text-[11px] text-amber-700">{channel.health.warnings.join(', ')}</div>
                                                            )}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
