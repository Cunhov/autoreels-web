'use client';
import { useState, useEffect, useMemo } from 'react';
import IOSCard from '@/components/IOSComponents';
import {
    BarChart2, Video, CheckCircle2, Clock, XCircle, Radio,
    Sliders, TrendingUp, AlertTriangle
} from 'lucide-react';

interface PostData {
    id: string;
    status: string;
    scheduled_at: string;
    caption?: string;
    error_message?: string;
    channel_name?: string;
    channel?: { name: string };
    planner_id?: string;
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

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
    const [posts, setPosts] = useState<PostData[]>([]);
    const [channels, setChannels] = useState<ChannelData[]>([]);
    const [planners, setPlanners] = useState<PlannerData[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const [pR, cR, plR] = await Promise.all([
                    fetch('/api/posts'),
                    fetch('/api/channels'),
                    fetch('/api/planners'),
                ]);
                if (pR.ok) setPosts(await pR.json());
                if (cR.ok) setChannels(await cR.json());
                if (plR.ok) setPlanners(await plR.json());
            } catch { }
            finally { setLoading(false); }
        })();
    }, []);

    // KPIs
    const published = useMemo(() => posts.filter(p => p.status === 'published').length, [posts]);
    const failed = useMemo(() => posts.filter(p => p.status === 'failed').length, [posts]);
    const pending = useMemo(() => posts.filter(p => ['pending', 'scheduled'].includes(p.status)).length, [posts]);
    const successRate = posts.length ? Math.round((published / posts.length) * 100) : 0;

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
        posts.filter(p => p.status === 'published' && p.scheduled_at).forEach(p => {
            const d = new Date(p.scheduled_at);
            const key = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            if (key in counts) counts[key]++;
        });
        return { daily30: labels.map(l => counts[l]), daily30Labels: labels };
    }, [posts]);

    // Per-channel stats
    const channelStats = useMemo(() => {
        return channels.map(ch => {
            const chPosts = posts.filter(p => (p as any).channel_id === ch.id || (p as any).channel?.name === ch.name);
            return {
                id: ch.id,
                name: ch.name,
                published: chPosts.filter(p => p.status === 'published').length,
                failed: chPosts.filter(p => p.status === 'failed').length,
                pending: chPosts.filter(p => ['pending', 'scheduled'].includes(p.status)).length,
            };
        });
    }, [posts, channels]);

    // Recent failures
    const recentFailed = useMemo(() =>
        posts.filter(p => p.status === 'failed').slice(-5).reverse(),
        [posts]);

    const kpis = [
        { label: 'Total Posts', value: posts.length, icon: Video, color: 'text-ios-blue', bg: 'bg-ios-blue/10' },
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
        <div className="space-y-6 pb-8">
            <h1 className="text-[34px] font-bold text-ios-text">Analytics</h1>

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
                    {posts.length === 0 ? (
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
                <PostingHeatmap posts={posts} />
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
                                <p className="text-[13px] text-ios-text truncate">{p.caption?.slice(0, 60) || 'No caption'}</p>
                                <p className="text-[11px] text-ios-red mt-0.5 truncate">{p.error_message || 'Unknown error'}</p>
                                <p className="text-[10px] text-ios-text-secondary mt-0.5">
                                    {p.scheduled_at ? new Date(p.scheduled_at).toLocaleString() : ''}
                                </p>
                            </div>
                        ))}
                    </div>
                </IOSCard>
            )}
        </div>
    );
}
