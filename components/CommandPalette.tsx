'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Calendar, BarChart2, Radio, Sliders, Folder, X, ArrowRight, Clock, Youtube } from 'lucide-react';

interface SearchResult {
    id: string;
    type: 'post' | 'planner' | 'channel' | 'page';
    label: string;
    sublabel?: string;
    href: string;
    icon: React.ElementType;
}

/** Shape mínimo dos itens buscáveis vindos das APIs (só os campos usados). */
interface PlannerHit {
    id: string;
    name?: string | null;
    status?: string | null;
}
interface ChannelHit {
    id: string;
    name?: string | null;
}
interface PostHit {
    id: string;
    caption?: string | null;
    status?: string | null;
    scheduled_at?: string | null;
}

const STATIC_PAGES: SearchResult[] = [
    { id: 'page-calendar', type: 'page', label: 'Calendário', sublabel: 'Ver posts agendados', href: '/', icon: Calendar },
    { id: 'page-analytics', type: 'page', label: 'Analytics', sublabel: 'Estatísticas e métricas', href: '/analytics', icon: BarChart2 },
    { id: 'page-channels', type: 'page', label: 'Canais', sublabel: 'Contas Instagram e YouTube', href: '/channels', icon: Radio },
    { id: 'page-youtube-comments', type: 'page', label: 'Comentários do YouTube', sublabel: 'Gerenciar comentários de Shorts', href: '/youtube/comments', icon: Youtube },
    { id: 'page-planners', type: 'page', label: 'Planners', sublabel: 'Regras de automação', href: '/planners', icon: Sliders },
    { id: 'page-library', type: 'page', label: 'Biblioteca', sublabel: 'Arquivos de mídia', href: '/content', icon: Folder },
];

interface CommandPaletteProps {
    open: boolean;
    onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>(STATIC_PAGES);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const router = useRouter();

    // Focus input when opened
    useEffect(() => {
        if (open) {
            setQuery('');
            setResults(STATIC_PAGES);
            setSelected(0);
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [open]);

    const search = useCallback(async (q: string) => {
        if (!q.trim()) {
            setResults(STATIC_PAGES);
            return;
        }
        setLoading(true);
        try {
            const lower = q.toLowerCase();
            const [postsRes, plannersRes, channelsRes] = await Promise.all([
                fetch('/api/posts'),
                fetch('/api/planners'),
                fetch('/api/channels'),
            ]);
            const posts = postsRes.ok ? await postsRes.json() : [];
            const planners = plannersRes.ok ? await plannersRes.json() : [];
            const channels = channelsRes.ok ? await channelsRes.json() : [];

            const found: SearchResult[] = [];

            // Pages
            STATIC_PAGES.filter(p => p.label.toLowerCase().includes(lower)).forEach(p => found.push(p));

            // Planners
            (Array.isArray(planners) ? (planners as PlannerHit[]) : [])
                .filter((pl) => pl.name?.toLowerCase().includes(lower))
                .slice(0, 3)
                .forEach((pl) => found.push({
                    id: `planner-${pl.id}`,
                    type: 'planner',
                    label: pl.name || 'Planner',
                    sublabel: `Planner · ${pl.status ?? ''}`,
                    href: '/planners',
                    icon: Sliders,
                }));

            // Channels
            (Array.isArray(channels) ? (channels as ChannelHit[]) : [])
                .filter((ch) => ch.name?.toLowerCase().includes(lower))
                .slice(0, 3)
                .forEach((ch) => found.push({
                    id: `channel-${ch.id}`,
                    type: 'channel',
                    label: ch.name || 'Canal',
                    sublabel: 'Canal conectado',
                    href: '/channels',
                    icon: Radio,
                }));

            // Posts (by caption)
            (Array.isArray(posts) ? (posts as PostHit[]) : [])
                .filter((p) => p.caption?.toLowerCase().includes(lower))
                .slice(0, 4)
                .forEach((p) => found.push({
                    id: `post-${p.id}`,
                    type: 'post',
                    label: p.caption?.slice(0, 60) || 'Post sem legenda',
                    sublabel: `Post · ${p.status ?? ''} · ${p.scheduled_at ? new Date(p.scheduled_at).toLocaleDateString() : ''}`,
                    href: '/',
                    icon: Clock,
                }));

            setResults(found.slice(0, 8));
            setSelected(0);
        } catch {
            setResults(STATIC_PAGES);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const t = setTimeout(() => search(query), 200);
        return () => clearTimeout(t);
    }, [query, search]);

    const navigate = (result: SearchResult) => {
        router.push(result.href);
        onClose();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelected(s => Math.min(s + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected(s => Math.max(s - 1, 0));
        } else if (e.key === 'Enter' && results[selected]) {
            navigate(results[selected]);
        } else if (e.key === 'Escape') {
            onClose();
        }
    };

    if (!open) return null;

    const typeColor: Record<string, string> = {
        page: 'bg-ios-blue/10 text-ios-blue',
        planner: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
        channel: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
        post: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    };

    return (
        <div
            className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4 bg-black/60 backdrop-blur-sm fade-in"
            onClick={onClose}
        >
            <div
                className="bg-ios-card w-full max-w-lg rounded-2xl shadow-2xl border border-ios-separator overflow-hidden zoom-in-95"
                onClick={e => e.stopPropagation()}
                onKeyDown={handleKeyDown}
            >
                {/* Search input */}
                <div className="flex items-center gap-3 px-4 py-3.5 border-b border-ios-separator">
                    <Search size={18} className="text-ios-secondary shrink-0" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search posts, planners, channels…"
                        className="flex-1 bg-transparent text-ios-text text-[16px] placeholder:text-ios-secondary outline-none"
                        autoComplete="off"
                    />
                    {loading && <div className="w-4 h-4 border-2 border-ios-blue border-t-transparent rounded-full animate-spin shrink-0" />}
                    <button onClick={onClose} title="Close" className="text-ios-secondary hover:text-ios-text transition-colors">
                        <X size={18} />
                    </button>
                </div>

                {/* Results */}
                <div className="max-h-80 overflow-y-auto custom-scrollbar py-1">
                    {results.length === 0 && (
                        <p className="text-center text-ios-secondary text-sm py-8">No results for “{query}”</p>
                    )}
                    {results.map((r, i) => (
                        <button
                            key={r.id}
                            onClick={() => navigate(r)}
                            className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${i === selected ? 'bg-ios-blue/10' : 'hover:bg-ios-gray-6/50'
                                }`}
                        >
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${typeColor[r.type]}`}>
                                <r.icon size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-[14px] font-medium text-ios-text truncate">{r.label}</p>
                                {r.sublabel && <p className="text-[12px] text-ios-secondary truncate">{r.sublabel}</p>}
                            </div>
                            <ArrowRight size={14} className="text-ios-secondary shrink-0" />
                        </button>
                    ))}
                </div>

                {/* Footer */}
                <div className="flex items-center gap-4 px-4 py-2.5 border-t border-ios-separator bg-ios-gray-6/50">
                    <kbd className="text-[11px] text-ios-secondary bg-ios-separator px-1.5 py-0.5 rounded font-mono">↑↓</kbd>
                    <span className="text-[11px] text-ios-secondary">Navigate</span>
                    <kbd className="text-[11px] text-ios-secondary bg-ios-separator px-1.5 py-0.5 rounded font-mono">↵</kbd>
                    <span className="text-[11px] text-ios-secondary">Open</span>
                    <kbd className="text-[11px] text-ios-secondary bg-ios-separator px-1.5 py-0.5 rounded font-mono">Esc</kbd>
                    <span className="text-[11px] text-ios-secondary">Close</span>
                </div>
            </div>
        </div>
    );
}
