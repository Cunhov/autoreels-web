'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import IOSCard from '@/components/IOSComponents';
import IOSButton from '@/components/IOSButton';
import {
    Video, CheckCircle2, Clock, XCircle, Radio,
    Sliders, TrendingUp, AlertTriangle, Heart, MessageCircle,
    Eye, Bookmark, Share2, Repeat2, RotateCcw, Ban, RefreshCw,
    ExternalLink, Inbox
} from 'lucide-react';

interface PostData {
    id: string;
    status: string;
    scheduled_at: string;
    channel_id?: string;
    caption?: string;
    error_message?: string;
    channel_name?: string;
    channel?: { name: string };
    planner_id?: string;
    video_url?: string;
    image_url?: string;
    thumbnail_url?: string;
    media_type?: string;
    children_urls?: string;
    published_at?: string;
    failed_reason?: string;
}

interface ChannelData {
    id: string;
    name: string;
    status: string;
}

interface PlannerData {
    id: string;
    name: string;
    status: string;
}

interface InsightsPost {
    id: string;
    instagram_media_id: string | null;
    permalink: string | null;
    caption: string | null;
    media_type: string | null;
    published_at: string | null;
    video_url?: string | null;
    image_url?: string | null;
    thumbnail_url?: string | null;
    metrics: { likes: number; comments: number; reach: number; impressions: number; saved: number; shares: number };
}

interface InsightsResponse {
    channel_id: string;
    channel_name: string;
    days: number;
    fetched_at: string;
    totals: { likes: number; comments: number; reach: number; impressions: number; saved: number; shares: number; posts_analyzed: number };
    posts: InsightsPost[];
}

type ToastState = { msg: string; type: 'ok' | 'err' } | null;

// ── Shared helpers ────────────────────────────────────────────────────────────

async function apiAction(path: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
    try {
        const res = await fetch(path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (res.ok) return { ok: true };
        const data = await res.json().catch(() => ({}));
        return { ok: false, error: (data as { error?: string }).error || `HTTP ${res.status}` };
    } catch (e: unknown) {
        return { ok: false, error: (e as { message?: string })?.message || 'Network error' };
    }
}

function useToast(): [ToastState, (msg: string, type?: 'ok' | 'err') => void] {
    const [toast, setToast] = useState<ToastState>(null);
    const showToast = useCallback((msg: string, type: 'ok' | 'err' = 'ok') => {
        setToast({ msg, type });
        window.setTimeout(() => setToast(null), 3000);
    }, []);
    return [toast, showToast];
}

function ToastView({ toast }: { toast: ToastState }) {
    if (!toast) return null;
    return (
        <div className={`fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-xl text-white text-[14px] font-medium shadow-xl slide-in-from-top-2 ${toast.type === 'ok' ? 'bg-ios-green' : 'bg-ios-red'}`}>
            {toast.type === 'ok' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            {toast.msg}
        </div>
    );
}

// ── Tiny SVG bar chart (no library) ──────────────────────────────────────────
function BarChart({ data, label }: { data: number[]; label: string[] }) {
    const max = Math.max(...data, 1);
    const barW = 100 / data.length;
    return (
        <div className="w-full">
            <svg viewBox={`0 0 100 40`} className="w-full h-32" preserveAspectRatio="none">
                {data.map((v, i) => {
                    const pct = v / max;
                    const h = pct * 36;
                    const x = i * barW + barW * 0.1;
                    const y = 40 - h;
                    return (
                        <rect
                            key={i}
                            x={x}
                            y={y}
                            width={barW * 0.8}
                            height={h}
                            rx="1"
                            fill={v === 0 ? 'var(--ios-gray-5)' : 'var(--ios-blue)'}
                            opacity={v === 0 ? 0.4 : 0.9}
                        />
                    );
                })}
            </svg>
            {/* X-axis labels - only show first, middle, last */}
            <div className="flex justify-between text-[9px] text-ios-text-secondary mt-1 px-0.5">
                <span>{label[0]}</span>
                <span>{label[Math.floor(label.length / 2)]}</span>
                <span>{label[label.length - 1]}</span>
            </div>
        </div>
    );
}

// ── Tiny SVG donut ────────────────────────────────────────────────────────────
function DonutChart({ published, failed, pending }: { published: number; failed: number; pending: number }) {
    const total = published + failed + pending || 1;
    const r = 16;
    const cx = 20;
    const cy = 20;
    const circ = 2 * Math.PI * r;

    const segments = [
        { val: published, color: '#34C759' },
        { val: failed, color: '#FF3B30' },
        { val: pending, color: '#8E8E93' },
    ];

    let offset = 0;
    return (
        <svg viewBox="0 0 40 40" className="w-20 h-20">
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--ios-gray-5)" strokeWidth="5" />
            {segments.map((seg, i) => {
                const pct = seg.val / total;
                const dash = pct * circ;
                const el = (
                    <circle
                        key={i}
                        cx={cx} cy={cy} r={r}
                        fill="none"
                        stroke={seg.color}
                        strokeWidth="5"
                        strokeDasharray={`${dash} ${circ - dash}`}
                        strokeDashoffset={-offset}
                        strokeLinecap="butt"
                        transform={`rotate(-90 ${cx} ${cy})`}
                    />
                );
                offset += dash;
                return el;
            })}
            <text x={cx} y={cy + 1.5} textAnchor="middle" dominantBaseline="middle" fontSize="7" fontWeight="bold" fill="var(--ios-text)">
                {total}
            </text>
            <text x={cx} y={cy + 8} textAnchor="middle" dominantBaseline="middle" fontSize="3.5" fill="var(--ios-text-secondary)">
                total
            </text>
        </svg>
    );
}

// ── Heatmap (7 days × 24 hours) ──────────────────────────────────────────────
function PostingHeatmap({ posts }: { posts: PostData[] }) {
    // Build 7×24 grid
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0)) as number[][];
    posts.filter(p => p.status === 'published' && p.scheduled_at).forEach(p => {
        const d = new Date(p.scheduled_at);
        grid[d.getDay()][d.getHours()]++;
    });
    const cellMax = Math.max(...grid.flat(), 1);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    return (
        <div className="overflow-x-auto">
            <div className="flex gap-1 min-w-max">
                {/* Day labels */}
                <div className="flex flex-col gap-1 pt-4">
                    {days.map(d => (
                        <div key={d} className="h-4 flex items-center text-[9px] text-ios-text-secondary w-6">{d}</div>
                    ))}
                </div>
                {/* Grid */}
                <div>
                    {/* Hour labels */}
                    <div className="flex gap-1 ml-0 mb-1">
                        {Array.from({ length: 24 }, (_, h) => (
                            <div key={h} className="w-4 text-center text-[7px] text-ios-text-secondary">
                                {h % 6 === 0 ? h : ''}
                            </div>
                        ))}
                    </div>
                    {grid.map((row, di) => (
                        <div key={di} className="flex gap-1 mb-1">
                            {row.map((count, hi) => {
                                const opacity = count === 0 ? 0.08 : 0.15 + (count / cellMax) * 0.85;
                                return (
                                    <div
                                        key={hi}
                                        title={`${days[di]} ${hi}:00 — ${count} posts`}
                                        className="w-4 h-4 rounded-sm"
                                        style={{ backgroundColor: `rgba(0,122,255,${opacity})` }}
                                    />
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
            <p className="text-[10px] text-ios-text-secondary mt-2">Best posting times based on published posts</p>
        </div>
    );
}

// ── Local dashboard (no channel selected) ─────────────────────────────────────
function LocalDashboard({ onToast }: { onToast: (msg: string, type?: 'ok' | 'err') => void }) {
    const [posts, setPosts] = useState<PostData[]>([]);
    const [channels, setChannels] = useState<ChannelData[]>([]);
    const [planners, setPlanners] = useState<PlannerData[]>([]);
    const [loading, setLoading] = useState(true);
    const [rangeDays, setRangeDays] = useState(30);
    const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'failed' | 'pending'>('all');

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const start = new Date();
            start.setDate(start.getDate() - 90);
            const params = new URLSearchParams({ start: start.toISOString(), limit: '2000' });
            const [pR, cR, plR] = await Promise.all([
                fetch(`/api/posts?${params.toString()}`),
                fetch('/api/channels'),
                fetch('/api/planners'),
            ]);
            if (pR.ok) setPosts(await pR.json());
            if (cR.ok) setChannels(await cR.json());
            if (plR.ok) setPlanners(await plR.json());
        } catch { /* silent */ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    const retryPost = async (id: string) => {
        const r = await apiAction(`/api/posts/${id}`, 'PATCH', { status: 'pending' });
        onToast(r.ok ? 'Post re-enfileirado para publicação' : r.error || 'Falha no retry', r.ok ? 'ok' : 'err');
        if (r.ok) fetchData();
    };

    const cancelPost = async (id: string) => {
        if (!window.confirm('Cancelar este post?')) return;
        const r = await apiAction(`/api/posts/${id}`, 'PATCH', { status: 'cancelled' });
        onToast(r.ok ? 'Post cancelado' : r.error || 'Falha ao cancelar', r.ok ? 'ok' : 'err');
        if (r.ok) fetchData();
    };

    const filteredPosts = useMemo(() => {
        if (statusFilter === 'all') return posts;
        if (statusFilter === 'pending') {
            return posts.filter(p => !['published', 'failed'].includes(p.status));
        }
        return posts.filter(p => p.status === statusFilter);
    }, [posts, statusFilter]);

    // KPIs
    const published = useMemo(() => filteredPosts.filter(p => p.status === 'published').length, [filteredPosts]);
    const failed = useMemo(() => filteredPosts.filter(p => p.status === 'failed').length, [filteredPosts]);
    const pending = useMemo(() => filteredPosts.filter(p => ['pending', 'scheduled', 'processing', 'processing_upload', 'processing_children', 'ready_to_publish'].includes(p.status)).length, [filteredPosts]);
    const successRate = filteredPosts.length ? Math.round((published / filteredPosts.length) * 100) : 0;

    // Last-30-days bar chart
    const { daily30, daily30Labels } = useMemo(() => {
        const counts: Record<string, number> = {};
        const labels: string[] = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            counts[key] = 0;
            labels.push(key);
        }
        filteredPosts.filter(p => p.status === 'published' && p.scheduled_at).forEach(p => {
            const d = new Date(p.scheduled_at);
            const key = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            if (key in counts) counts[key]++;
        });
        return { daily30: labels.map(l => counts[l]), daily30Labels: labels };
    }, [filteredPosts]);

    // Per-channel stats
    const channelStats = useMemo(() => {
        return channels.map(ch => {
            const chPosts = filteredPosts.filter(p => p.channel_id === ch.id || p.channel?.name === ch.name);
            return {
                id: ch.id,
                name: ch.name,
                published: chPosts.filter(p => p.status === 'published').length,
                failed: chPosts.filter(p => p.status === 'failed').length,
                pending: chPosts.filter(p => ['pending', 'scheduled'].includes(p.status)).length,
            };
        });
    }, [filteredPosts, channels]);

    // Recent failures
    const recentFailed = useMemo(() =>
        filteredPosts.filter(p => p.status === 'failed').slice(-5).reverse(),
        [filteredPosts]);

    const kpis = [
        { label: 'Total Posts', value: filteredPosts.length, icon: Video, color: 'text-ios-blue', bg: 'bg-ios-blue/10' },
        { label: 'Published', value: published, icon: CheckCircle2, color: 'text-ios-green', bg: 'bg-ios-green/10' },
        { label: 'Failed', value: failed, icon: XCircle, color: 'text-ios-red', bg: 'bg-ios-red/10' },
        { label: 'Pending', value: pending, icon: Clock, color: 'text-ios-text-secondary', bg: 'bg-ios-gray-5/50' },
        { label: 'Success Rate', value: `${successRate}%`, icon: TrendingUp, color: 'text-ios-green', bg: 'bg-ios-green/10' },
        { label: 'Channels', value: channels.length, icon: Radio, color: 'text-pink-500', bg: 'bg-pink-100 dark:bg-pink-900/30' },
        { label: 'Active Planners', value: planners.filter(p => p.status === 'active').length, icon: Sliders, color: 'text-purple-500', bg: 'bg-purple-100 dark:bg-purple-900/30' },
    ];

    if (loading) return (
        <div className="flex justify-center p-20">
            <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h2 className="text-[17px] font-bold text-ios-text">Resumo local</h2>
                    <p className="text-sm text-ios-text-secondary">Dashboard baseado no histórico local do app.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {[7, 30, 90].map(days => (
                        <button
                            key={days}
                            onClick={() => setRangeDays(days)}
                            className={`px-3 py-2 rounded-lg text-sm font-semibold border ${rangeDays === days ? 'bg-ios-blue text-white border-ios-blue' : 'bg-ios-card border-ios-separator text-ios-text-secondary'}`}
                        >
                            {days}d
                        </button>
                    ))}
                    {(['all', 'published', 'failed', 'pending'] as const).map(status => (
                        <button
                            key={status}
                            onClick={() => setStatusFilter(status)}
                            className={`px-3 py-2 rounded-lg text-sm font-semibold border capitalize ${statusFilter === status ? 'bg-ios-gray-5 text-ios-text border-ios-separator' : 'bg-ios-card border-ios-separator text-ios-text-secondary'}`}
                        >
                            {status}
                        </button>
                    ))}
                </div>
            </div>

            {/* KPI Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {kpis.map(k => (
                    <IOSCard key={k.label} className="p-4 flex flex-col gap-2">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${k.bg}`}>
                            <k.icon size={18} className={k.color} />
                        </div>
                        <p className="text-[22px] font-bold text-ios-text leading-none">{k.value}</p>
                        <p className="text-[12px] text-ios-text-secondary">{k.label}</p>
                    </IOSCard>
                ))}
            </div>

            {/* Activity + Donut */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <IOSCard className="p-5 lg:col-span-2">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-[17px] font-bold">Posts Per Day</h3>
                        <span className="text-[12px] text-ios-text-secondary">Last 30 days</span>
                    </div>
                    {filteredPosts.length === 0 ? (
                        <div className="h-32 flex items-center justify-center text-ios-text-secondary text-sm">
                            No published posts yet
                        </div>
                    ) : (
                        <BarChart data={daily30} label={daily30Labels} />
                    )}
                </IOSCard>

                <IOSCard className="p-5 flex flex-col items-center justify-center gap-3">
                    <h3 className="text-[17px] font-bold self-start">Status</h3>
                    <DonutChart published={published} failed={failed} pending={pending} />
                    <div className="flex flex-col gap-1.5 w-full">
                        {[
                            { label: 'Published', color: 'bg-ios-green', val: published },
                            { label: 'Failed', color: 'bg-ios-red', val: failed },
                            { label: 'Pending', color: 'bg-ios-gray-2', val: pending },
                        ].map(s => (
                            <div key={s.label} className="flex items-center gap-2 text-[12px]">
                                <div className={`w-2 h-2 rounded-full ${s.color}`} />
                                <span className="flex-1 text-ios-text-secondary">{s.label}</span>
                                <span className="font-semibold text-ios-text">{s.val}</span>
                            </div>
                        ))}
                    </div>
                </IOSCard>
            </div>

            {/* Heatmap */}
            <IOSCard className="p-5">
                <h3 className="text-[17px] font-bold mb-4">Posting Heatmap</h3>
                <PostingHeatmap posts={filteredPosts} />
            </IOSCard>

            {/* Per-channel stats */}
            {channelStats.length > 0 && (
                <IOSCard className="p-5">
                    <h3 className="text-[17px] font-bold mb-4">Channels</h3>
                    <div className="divide-y divide-ios-separator">
                        {channelStats.map(ch => (
                            <div key={ch.id} className="py-3 flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-pink-100 dark:bg-pink-900/30 flex items-center justify-center text-pink-500 text-[13px] font-bold flex-shrink-0">
                                    {ch.name[0]?.toUpperCase() ?? '?'}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[14px] font-semibold truncate">{ch.name}</p>
                                </div>
                                <div className="flex gap-3 text-[12px] shrink-0">
                                    <span className="text-ios-green font-medium">{ch.published} ✓</span>
                                    <span className="text-ios-red font-medium">{ch.failed} ✗</span>
                                    <span className="text-ios-text-secondary">{ch.pending} ⏳</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </IOSCard>
            )}

            {/* Recent failures */}
            {recentFailed.length > 0 && (
                <IOSCard className="p-5">
                    <h3 className="text-[17px] font-bold mb-4 flex items-center gap-2">
                        <AlertTriangle size={18} className="text-ios-red" />
                        Recent Failures
                    </h3>
                    <div className="divide-y divide-ios-separator">
                        {recentFailed.map(p => (
                            <div key={p.id} className="py-3">
                                <div className="flex items-start justify-between gap-2">
                                    <p className="text-[13px] text-ios-text truncate flex-1">{p.caption?.slice(0, 60) || 'No caption'}</p>
                                    <button
                                        onClick={() => retryPost(p.id)}
                                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/20 shrink-0"
                                    >
                                        <RotateCcw size={11} /> Retry
                                    </button>
                                </div>
                                <p className="text-[11px] text-ios-red mt-0.5 truncate">{p.error_message || 'Unknown error'}</p>
                                <div className="flex items-center justify-between mt-0.5">
                                    <p className="text-[10px] text-ios-text-secondary">
                                        {p.scheduled_at ? new Date(p.scheduled_at).toLocaleString() : ''}
                                    </p>
                                    <button
                                        onClick={() => cancelPost(p.id)}
                                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-red-500/10 text-ios-red hover:bg-red-500/20"
                                    >
                                        <Ban size={11} /> Cancel
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </IOSCard>
            )}
        </div>
    );
}

// ── Channel insights (channel selected) ───────────────────────────────────────
function ChannelInsights({ channelId, onToast }: { channelId: string; onToast: (msg: string, type?: 'ok' | 'err') => void }) {
    const [data, setData] = useState<InsightsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [days, setDays] = useState(30);

    const fetchInsights = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/channels/${channelId}/insights?days=${days}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                setError((body as { error?: string; detail?: string }).error || `HTTP ${res.status}`);
                setData(null);
                return;
            }
            setData(await res.json());
        } catch {
            setError('Network error while fetching insights');
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [channelId, days]);

    useEffect(() => { fetchInsights(); }, [fetchInsights]);

    const repostPost = async (p: InsightsPost) => {
        const r = await apiAction('/api/posts', 'POST', {
            caption: p.caption || '',
            media_type: p.media_type || 'REELS',
            channel_id: channelId,
            video_url: p.video_url || null,
            image_url: p.image_url || null,
            thumbnail_url: p.thumbnail_url || null,
        });
        onToast(r.ok ? 'Post duplicado para a fila de publicação' : r.error || 'Falha ao duplicar', r.ok ? 'ok' : 'err');
    };

    const retryPost = async (id: string) => {
        const r = await apiAction(`/api/posts/${id}`, 'PATCH', { status: 'pending' });
        onToast(r.ok ? 'Post re-enfileirado para publicação' : r.error || 'Falha no retry', r.ok ? 'ok' : 'err');
        if (r.ok) fetchInsights();
    };

    const cancelPost = async (id: string) => {
        if (!window.confirm('Cancelar este post?')) return;
        const r = await apiAction(`/api/posts/${id}`, 'PATCH', { status: 'cancelled' });
        onToast(r.ok ? 'Post cancelado' : r.error || 'Falha ao cancelar', r.ok ? 'ok' : 'err');
        if (r.ok) fetchInsights();
    };

    const metricCards = [
        { label: 'Likes', value: data?.totals.likes ?? 0, icon: Heart, color: 'text-ios-red', bg: 'bg-red-500/10' },
        { label: 'Comments', value: data?.totals.comments ?? 0, icon: MessageCircle, color: 'text-ios-blue', bg: 'bg-ios-blue/10' },
        { label: 'Reach', value: data?.totals.reach ?? 0, icon: Eye, color: 'text-purple-500', bg: 'bg-purple-500/10' },
        { label: 'Impressions', value: data?.totals.impressions ?? 0, icon: TrendingUp, color: 'text-ios-green', bg: 'bg-ios-green/10' },
        { label: 'Saved', value: data?.totals.saved ?? 0, icon: Bookmark, color: 'text-amber-500', bg: 'bg-amber-500/10' },
        { label: 'Shares', value: data?.totals.shares ?? 0, icon: Share2, color: 'text-pink-500', bg: 'bg-pink-500/10' },
        { label: 'Posts analyzed', value: data?.totals.posts_analyzed ?? 0, icon: Video, color: 'text-ios-text-secondary', bg: 'bg-ios-gray-5/50' },
    ];

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h2 className="text-[17px] font-bold text-ios-text flex items-center gap-2">
                        <InstagramIcon />
                        {data?.channel_name || 'Channel insights'}
                    </h2>
                    <p className="text-sm text-ios-text-secondary">
                        Métricas reais da API do Instagram · atualizado a cada 5 min
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {[7, 30, 90].map(d => (
                        <button
                            key={d}
                            onClick={() => setDays(d)}
                            className={`px-3 py-2 rounded-lg text-sm font-semibold border ${days === d ? 'bg-ios-blue text-white border-ios-blue' : 'bg-ios-card border-ios-separator text-ios-text-secondary'}`}
                        >
                            {d}d
                        </button>
                    ))}
                    <button
                        onClick={fetchInsights}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-ios-card border border-ios-separator text-ios-text-secondary hover:bg-ios-gray-5/50"
                    >
                        <RefreshCw size={14} /> Atualizar
                    </button>
                </div>
            </div>

            {loading && (
                <div className="flex justify-center p-20">
                    <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
                </div>
            )}

            {!loading && error && (
                <IOSCard className="p-8 flex flex-col items-center gap-3 text-center">
                    <AlertTriangle size={28} className="text-ios-red" />
                    <p className="text-[15px] font-semibold text-ios-text">Falha ao carregar insights</p>
                    <p className="text-[13px] text-ios-text-secondary max-w-sm">{error}</p>
                    <IOSButton onClick={fetchInsights} variant="secondary" className="mt-1">
                        Tentar novamente
                    </IOSButton>
                </IOSCard>
            )}

            {!loading && !error && data && (
                <>
                    {/* Metrics grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                        {metricCards.map(k => (
                            <IOSCard key={k.label} className="p-4 flex flex-col gap-2">
                                <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${k.bg}`}>
                                    <k.icon size={18} className={k.color} />
                                </div>
                                <p className="text-[22px] font-bold text-ios-text leading-none">{k.value.toLocaleString()}</p>
                                <p className="text-[12px] text-ios-text-secondary">{k.label}</p>
                            </IOSCard>
                        ))}
                    </div>

                    {/* Per-post table */}
                    <IOSCard className="p-5">
                        <h3 className="text-[17px] font-bold mb-4">Posts no período</h3>
                        {data.posts.length === 0 ? (
                            <div className="flex flex-col items-center gap-2 py-10 text-ios-text-secondary">
                                <Inbox size={28} />
                                <p className="text-sm">Nenhum post publicado no período.</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-ios-separator">
                                {data.posts.map(p => (
                                    <div key={p.id} className="py-3">
                                        <div className="flex items-start gap-3">
                                            {/* Thumbnail */}
                                            <div className="w-12 h-14 bg-black/5 rounded-lg overflow-hidden flex-shrink-0 border border-black/5">
                                                {p.video_url ? (
                                                    p.thumbnail_url ? (
                                                        <img src={p.thumbnail_url} className="w-full h-full object-cover" alt="" />
                                                    ) : (
                                                        <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                                                            <Video className="w-4 h-4 text-white/40" />
                                                        </div>
                                                    )
                                                ) : p.image_url || p.thumbnail_url ? (
                                                    <img src={p.image_url || p.thumbnail_url || undefined} className="w-full h-full object-cover" alt="" />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center text-[9px] text-ios-text-secondary text-center p-0.5">No media</div>
                                                )}
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                <p className="text-[13px] text-ios-text truncate">{p.caption || <span className="text-ios-text-secondary italic">No caption</span>}</p>
                                                <p className="text-[10px] text-ios-text-secondary mt-0.5">
                                                    {p.published_at ? new Date(p.published_at).toLocaleString() : ''}
                                                    {p.media_type ? ` · ${p.media_type}` : ''}
                                                </p>
                                                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-ios-text-secondary">
                                                    <span className="flex items-center gap-1"><Heart size={10} className="text-ios-red" /> {p.metrics.likes.toLocaleString()}</span>
                                                    <span className="flex items-center gap-1"><MessageCircle size={10} /> {p.metrics.comments.toLocaleString()}</span>
                                                    <span className="flex items-center gap-1"><Eye size={10} /> {p.metrics.reach.toLocaleString()}</span>
                                                    <span className="flex items-center gap-1"><TrendingUp size={10} /> {p.metrics.impressions.toLocaleString()}</span>
                                                    <span className="flex items-center gap-1"><Bookmark size={10} /> {p.metrics.saved.toLocaleString()}</span>
                                                    <span className="flex items-center gap-1"><Share2 size={10} /> {p.metrics.shares.toLocaleString()}</span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div className="flex flex-wrap gap-2 mt-2">
                                            <button
                                                onClick={() => repostPost(p)}
                                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/20"
                                            >
                                                <Repeat2 size={12} /> Republicar
                                            </button>
                                            <button
                                                onClick={() => retryPost(p.id)}
                                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-ios-green/10 text-ios-green hover:bg-ios-green/20"
                                            >
                                                <RotateCcw size={12} /> Reenfileirar
                                            </button>
                                            <button
                                                onClick={() => cancelPost(p.id)}
                                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-red-500/10 text-ios-red hover:bg-red-500/20"
                                            >
                                                <Ban size={12} /> Cancelar
                                            </button>
                                            {p.permalink && (
                                                <a
                                                    href={p.permalink}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-ios-card border border-ios-separator text-ios-text-secondary hover:bg-ios-gray-5/50"
                                                >
                                                    <ExternalLink size={12} /> Ver no Instagram
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </IOSCard>
                </>
            )}
        </div>
    );
}

// Small inline IG glyph (lucide has no brand icons)
function InstagramIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-pink-500">
            <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
            <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
            <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
        </svg>
    );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
    const [channels, setChannels] = useState<ChannelData[]>([]);
    const [selectedChannel, setSelectedChannel] = useState<string>('all');
    const [toast, showToast] = useToast();

    useEffect(() => {
        fetch('/api/channels')
            .then(r => (r.ok ? r.json() : []))
            .then(setChannels)
            .catch(() => { });
    }, []);

    return (
        <div className="space-y-6 pb-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-[34px] font-bold text-ios-text">Analytics</h1>
                    <p className="text-sm text-ios-text-secondary">
                        {selectedChannel === 'all'
                            ? 'Resumo local de todas as contas — selecione um canal para métricas reais do Instagram.'
                            : 'Métricas reais do Instagram (alcance, engajamento, salvos).'}
                    </p>
                </div>
            </div>

            {/* Channel selector */}
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                <button
                    onClick={() => setSelectedChannel('all')}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold border whitespace-nowrap transition-colors ${selectedChannel === 'all' ? 'bg-ios-blue text-white border-ios-blue' : 'bg-ios-card border-ios-separator text-ios-text-secondary'}`}
                >
                    <Radio size={14} /> Todos
                </button>
                {channels.map(ch => (
                    <button
                        key={ch.id}
                        onClick={() => setSelectedChannel(ch.id)}
                        className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold border whitespace-nowrap transition-colors ${selectedChannel === ch.id ? 'bg-ios-blue text-white border-ios-blue' : 'bg-ios-card border-ios-separator text-ios-text-secondary'}`}
                    >
                        <span className="w-5 h-5 rounded-full bg-pink-100 dark:bg-pink-900/30 flex items-center justify-center text-pink-500 text-[10px] font-bold">
                            {ch.name[0]?.toUpperCase() ?? '?'}
                        </span>
                        {ch.name}
                    </button>
                ))}
            </div>

            {selectedChannel === 'all' ? (
                <LocalDashboard onToast={showToast} />
            ) : (
                <ChannelInsights channelId={selectedChannel} onToast={showToast} />
            )}

            <ToastView toast={toast} />
        </div>
    );
}
