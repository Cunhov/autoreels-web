'use client';
import { useState, useEffect, useMemo } from 'react';
import {
    Plus, Search, Instagram, Pencil, Trash2,
    CheckCircle2, XCircle, AlertTriangle, RefreshCw, Wifi, WifiOff, Copy, KeyRound
} from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import IOSCard from '@/components/IOSComponents';
import ChannelModal from '@/components/ChannelModal';
import { useSearchParams, useRouter } from 'next/navigation';

interface Channel {
    id: string;
    name: string;
    platform: string;
    status: string;
    account_id: string;
    access_token?: string;
    has_token?: boolean;
    token_source?: string;
    token_expires_at?: string;
    token_refreshed_at?: string;
    username?: string;
    profile_picture_url?: string;
    created_at?: string;
}

interface PostData {
    id: string;
    status: string;
    channel_id?: string;
}

/** Estimate token health: Instagram tokens expire in ~60 days */
function tokenHealth(channel: Channel): 'good' | 'expiring' | 'expired' | 'unknown' {
    if (channel.token_source === 'redis') return 'unknown';
    if (!channel.token_expires_at) return channel.has_token ? 'unknown' : 'expired';
    const daysLeft = (new Date(channel.token_expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft < 1) return 'expired';
    if (daysLeft < 14) return 'expiring';
    return 'good';
}

const healthConfig = {
    good: { label: 'Token OK', color: 'text-ios-green', bg: 'bg-ios-green/10', icon: CheckCircle2 },
    expiring: { label: 'Token expiring', color: 'text-ios-orange', bg: 'bg-ios-orange/10', icon: AlertTriangle },
    expired: { label: 'Token expired', color: 'text-ios-red', bg: 'bg-ios-red/10', icon: XCircle },
    unknown: { label: 'Check token', color: 'text-ios-text-secondary', bg: 'bg-ios-gray-5', icon: AlertTriangle },
};

export default function ChannelsPage() {
    const [channels, setChannels] = useState<Channel[]>([]);
    const [posts, setPosts] = useState<PostData[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingChannel, setEditingChannel] = useState<Channel | undefined>(undefined);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [refreshingId, setRefreshingId] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<Record<string, 'ok' | 'err'>>({});
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);
    const searchParams = useSearchParams();
    const router = useRouter();

    const showToast = (msg: string, type: 'ok' | 'err' = 'ok') => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3500);
    };

    useEffect(() => { fetchData(); }, []);

    useEffect(() => {
        const connect = searchParams.get('connect');
        if (connect === 'success') showToast('Instagram channel connected');
        if (connect === 'error') showToast(searchParams.get('message') || 'Instagram connection failed', 'err');
        if (connect) router.replace('/channels');
    }, [searchParams, router]);

    async function fetchData() {
        setLoading(true);
        try {
            const [cR, pR] = await Promise.all([fetch('/api/channels'), fetch('/api/posts')]);
            if (cR.ok) setChannels(await cR.json());
            if (pR.ok) setPosts(await pR.json());
        } finally { setLoading(false); }
    }

    // Post counts per channel
    const channelPostStats = useMemo(() => {
        const map: Record<string, { published: number; failed: number; total: number }> = {};
        posts.forEach(p => {
            const cid = p.channel_id ?? '';
            if (!cid) return;
            if (!map[cid]) map[cid] = { published: 0, failed: 0, total: 0 };
            map[cid].total++;
            if (p.status === 'published') map[cid].published++;
            if (p.status === 'failed') map[cid].failed++;
        });
        return map;
    }, [posts]);

    async function testConnection(channel: Channel) {
        setTestingId(channel.id);
        try {
            const res = await fetch(`/api/channels/${channel.id}/test`);
            if (res.ok) {
                setTestResult(prev => ({ ...prev, [channel.id]: 'ok' }));
                showToast(`${channel.name} — connection OK ✓`);
            } else throw new Error();
        } catch {
            setTestResult(prev => ({ ...prev, [channel.id]: 'err' }));
            showToast(`${channel.name} — connection failed`, 'err');
        } finally { setTestingId(null); }
    }

    async function confirmDelete() {
        if (!deletingId) return;
        try {
            const res = await fetch(`/api/channels/${deletingId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error();
            setDeletingId(null);
            fetchData();
        } catch { showToast('Failed to delete channel', 'err'); setDeletingId(null); }
    }

    async function refreshToken(channel: Channel) {
        setRefreshingId(channel.id);
        try {
            const res = await fetch(`/api/channels/${channel.id}/refresh`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to refresh token');
            showToast(`${channel.name} — token refreshed`);
            fetchData();
        } catch (err: unknown) {
            showToast(err instanceof Error ? err.message : 'Failed to refresh token', 'err');
        } finally {
            setRefreshingId(null);
        }
    }

    async function copyToken(channel: Channel) {
        try {
            const res = await fetch(`/api/channels/${channel.id}/token`);
            const data = await res.json();
            if (!res.ok || !data.token) throw new Error(data.error || 'Token unavailable');
            await navigator.clipboard.writeText(data.token);
            showToast(`${channel.name} — token copied`);
        } catch (err: unknown) {
            showToast(err instanceof Error ? err.message : 'Failed to copy token', 'err');
        }
    }

    const filtered = channels.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));

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
                    <h1 className="text-[34px] font-bold text-ios-text">Channels</h1>
                    <p className="text-ios-text-secondary text-sm">{channels.length} Instagram account{channels.length !== 1 ? 's' : ''} connected</p>
                </div>
                <IOSButton variant="primary" className="!py-2 !px-4 flex items-center gap-1" onClick={() => { setEditingChannel(undefined); setIsModalOpen(true); }}>
                    <Plus size={18} />
                    Add Channel
                </IOSButton>
            </div>

            {/* Search */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-ios-text-secondary" size={16} />
                <input
                    type="text"
                    placeholder="Search channels…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full bg-ios-card border border-ios-separator rounded-xl py-2.5 pl-9 pr-4 text-[15px] focus:outline-none focus:ring-1 focus:ring-ios-blue transition-all"
                />
            </div>

            {/* List */}
            {loading ? (
                <div className="flex justify-center p-12">
                    <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
                </div>
            ) : filtered.length === 0 ? (
                <IOSCard className="p-12 text-center text-ios-text-secondary">
                    <Instagram size={48} className="mx-auto mb-4 opacity-30" strokeWidth={1} />
                    <h3 className="text-xl font-semibold mb-2 text-ios-text">No channels</h3>
                    <p className="max-w-xs mx-auto mb-6">Connect your Instagram accounts to start scheduling content.</p>
                    <IOSButton variant="primary" onClick={() => setIsModalOpen(true)}>Connect Account</IOSButton>
                </IOSCard>
            ) : (
                <div className="space-y-3">
                    {filtered.map(channel => {
                        const health = tokenHealth(channel);
                        const hConf = healthConfig[health];
                        const HIcon = hConf.icon;
                        const stats = channelPostStats[channel.id] ?? { published: 0, failed: 0, total: 0 };
                        const tested = testResult[channel.id];
                        const isTesting = testingId === channel.id;

                        return (
                            <IOSCard key={channel.id} className="p-4 group">
                                <div className="flex items-center gap-4">
                                    {/* Avatar */}
                                    {channel.profile_picture_url ? (
                                        <img src={channel.profile_picture_url} alt={channel.name} className="w-12 h-12 rounded-full object-cover border border-ios-separator flex-shrink-0" />
                                    ) : (
                                        <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-yellow-400 via-red-500 to-purple-500 p-[2px] flex-shrink-0">
                                            <div className="w-full h-full rounded-full bg-white flex items-center justify-center">
                                                <Instagram size={22} className="text-pink-600" />
                                            </div>
                                        </div>
                                    )}

                                    {/* Info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <h4 className="font-semibold text-[16px] text-ios-text">{channel.name}</h4>
                                            {/* Token health badge */}
                                            <span className={`flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${hConf.bg} ${hConf.color}`}>
                                                <HIcon size={10} />
                                                {hConf.label}
                                            </span>
                                            {/* Live test result */}
                                            {tested === 'ok' && <span className="flex items-center gap-1 text-[10px] text-ios-green font-semibold"><Wifi size={10} /> Connected</span>}
                                            {tested === 'err' && <span className="flex items-center gap-1 text-[10px] text-ios-red font-semibold"><WifiOff size={10} /> Failed</span>}
                                        </div>
                                        <p className="text-[12px] text-ios-text-secondary font-mono mt-0.5 truncate">
                                            @{channel.username || channel.name} · ID: {channel.account_id}
                                        </p>
                                        <p className="text-[11px] text-ios-text-secondary mt-0.5">
                                            {channel.token_source || 'manual'} token
                                            {channel.token_expires_at ? ` · expires ${new Date(channel.token_expires_at).toLocaleDateString()}` : ''}
                                        </p>

                                        {/* Post stats */}
                                        {stats.total > 0 && (
                                            <div className="flex gap-3 mt-1.5 text-[11px]">
                                                <span className="text-ios-green font-semibold">✓ {stats.published}</span>
                                                {stats.failed > 0 && <span className="text-ios-red font-semibold">✗ {stats.failed}</span>}
                                                <span className="text-ios-text-secondary">{stats.total} total</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Actions */}
                                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                        <button
                                            onClick={() => testConnection(channel)}
                                            disabled={isTesting}
                                            title="Test connection"
                                            className="p-2 rounded-lg text-ios-blue hover:bg-ios-blue/10 transition-colors"
                                        >
                                            {isTesting
                                                ? <RefreshCw size={16} className="animate-spin" />
                                                : <Wifi size={16} />}
                                        </button>
                                        <button
                                            onClick={() => refreshToken(channel)}
                                            disabled={refreshingId === channel.id || channel.token_source === 'redis'}
                                            title="Refresh token"
                                            className="p-2 rounded-lg text-ios-green hover:bg-ios-green/10 transition-colors disabled:opacity-40"
                                        >
                                            {refreshingId === channel.id ? <RefreshCw size={16} className="animate-spin" /> : <KeyRound size={16} />}
                                        </button>
                                        <button
                                            onClick={() => copyToken(channel)}
                                            title="Copy current token"
                                            className="p-2 rounded-lg text-ios-text-secondary hover:bg-ios-gray-5 transition-colors"
                                        >
                                            <Copy size={16} />
                                        </button>
                                        <button
                                            onClick={() => { setEditingChannel(channel); setIsModalOpen(true); }}
                                            title="Edit channel"
                                            className="p-2 rounded-lg text-ios-text-secondary hover:bg-ios-gray-5 transition-colors"
                                        >
                                            <Pencil size={16} />
                                        </button>
                                        <button
                                            onClick={() => setDeletingId(channel.id)}
                                            title="Delete channel"
                                            className="p-2 rounded-lg text-ios-red hover:bg-ios-red/10 transition-colors"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                </div>
                            </IOSCard>
                        );
                    })}
                </div>
            )}

            {/* Channel Modal */}
            <ChannelModal
                isOpen={isModalOpen}
                onClose={() => { setIsModalOpen(false); setEditingChannel(undefined); }}
                onSuccess={fetchData}
                channel={editingChannel}
            />

            {/* Delete Confirmation Modal */}
            {deletingId && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm fade-in">
                    <div className="bg-ios-card w-80 rounded-2xl shadow-2xl overflow-hidden zoom-in-95">
                        <div className="p-6 text-center">
                            <div className="w-12 h-12 rounded-full bg-ios-red/15 flex items-center justify-center mx-auto mb-4">
                                <Trash2 size={22} className="text-ios-red" />
                            </div>
                            <h3 className="text-[17px] font-bold text-ios-text mb-1">Remove Channel?</h3>
                            <p className="text-[14px] text-ios-text-secondary">This will remove the channel and all associated posts from your planners.</p>
                        </div>
                        <div className="border-t border-ios-separator flex">
                            <button onClick={() => setDeletingId(null)} className="flex-1 py-3.5 text-[17px] text-ios-blue font-medium border-r border-ios-separator hover:bg-ios-gray-6 transition-colors">Cancel</button>
                            <button onClick={confirmDelete} className="flex-1 py-3.5 text-[17px] text-ios-red font-semibold hover:bg-ios-red/10 transition-colors">Remove</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
