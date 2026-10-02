"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import type { ChannelLite } from "./types";
import { apiFetch, channelLabel, isRecord } from "./types";

type Post = { id: string; mediaId: string; channelId: string; caption: string; thumbnailUrl: string; permalink?: string };
type Scope = "all" | "selected";
interface Props {
    channels: ChannelLite[];
    selectedIds: string[];
    mediaIdsByChannel: Record<string, string[]>;
    scopeByChannel: Record<string, Scope>;
    onChange: (next: Record<string, string[]>) => void;
    onScopeChange: (next: Record<string, Scope>) => void;
}
const input = "w-full bg-ios-background border border-ios-separator rounded-lg p-2.5 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400";
function parsePosts(rows: unknown[]): Post[] {
    return rows.filter(isRecord).map(p => ({
        id: String(p.id ?? p.mediaId ?? ""), mediaId: String(p.mediaId ?? p.id ?? ""),
        channelId: String(p.channelId ?? ""), caption: String(p.caption ?? ""),
        thumbnailUrl: String(p.thumbnailUrl ?? ""), permalink: p.permalink ? String(p.permalink) : undefined,
    })).filter(p => p.mediaId);
}
function PostThumbnail({ src }: { src: string }) {
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [src]);
    return <div className="aspect-square bg-ios-gray-5">{src && !failed
        ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="w-full h-full object-cover"/>
        : <div className="w-full h-full flex items-center justify-center text-xs text-ios-text-secondary">Sem miniatura</div>}</div>;
}
export default function ProfilePostPicker({ channels, selectedIds, mediaIdsByChannel, scopeByChannel, onChange, onScopeChange }: Props) {
    const [posts, setPosts] = useState<Post[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [offset, setOffset] = useState(0);
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const requestVersion = useRef(0);
    const key = selectedIds.slice().sort().join(",");
    useEffect(() => {
        const version = ++requestVersion.current;
        let cancelled = false;
        setError(""); setOffset(0); setPosts([]); setHasMore(false);
        if (!key) { setLoading(false); return () => { cancelled = true; }; }
        setLoading(true);
        const params = new URLSearchParams({ channelIds: key, limit: "50", offset: "0" });
        if (query.trim()) params.set("query", query.trim());
        apiFetch<unknown>(`/api/ig/posts?${params}`).then(raw => {
            if (cancelled || version !== requestVersion.current) return;
            const o = isRecord(raw) ? raw : {};
            const rows = Array.isArray(o.posts) ? o.posts : [];
            setPosts(parsePosts(rows)); setHasMore(o.hasMore === true); setOffset(Number(o.nextOffset ?? rows.length));
        }).catch(e => {
            if (!cancelled && version === requestVersion.current) setError(e instanceof Error ? e.message : "Não foi possível carregar os posts.");
        }).finally(() => { if (!cancelled && version === requestVersion.current) setLoading(false); });
        return () => { cancelled = true; };
    }, [key, query]);
    const known = useMemo(() => new Set(posts.map(p => `${p.channelId}:${p.mediaId}`)), [posts]);
    async function more() {
        if (loading || !hasMore) return;
        const version = requestVersion.current; setLoading(true);
        const params = new URLSearchParams({ channelIds: key, limit: "50", offset: String(offset) });
        if (query.trim()) params.set("query", query.trim());
        try {
            const raw = await apiFetch<unknown>(`/api/ig/posts?${params}`);
            if (version !== requestVersion.current) return;
            const o = isRecord(raw) ? raw : {}; const rows = Array.isArray(o.posts) ? o.posts : [];
            setPosts(old => [...old, ...parsePosts(rows)]); setHasMore(o.hasMore === true); setOffset(Number(o.nextOffset ?? offset + rows.length));
        } catch (e) {
            if (version === requestVersion.current) setError(e instanceof Error ? e.message : "Falha ao carregar mais posts.");
        } finally { if (version === requestVersion.current) setLoading(false); }
    }
    const allFor = (id: string) => scopeByChannel[id] !== "selected";
    const selectAll = () => {
        const next = { ...mediaIdsByChannel }; const scopes = { ...scopeByChannel };
        selectedIds.forEach(id => { next[id] = []; scopes[id] = "all"; });
        onChange(next); onScopeChange(scopes);
    };
    const setAll = (id: string) => { onChange({ ...mediaIdsByChannel, [id]: [] }); onScopeChange({ ...scopeByChannel, [id]: "all" }); };
    const setSelected = (id: string) => onScopeChange({ ...scopeByChannel, [id]: "selected" });
    const toggle = (id: string, mediaId: string) => {
        const values = new Set(mediaIdsByChannel[id] ?? []);
        values.has(mediaId) ? values.delete(mediaId) : values.add(mediaId);
        onChange({ ...mediaIdsByChannel, [id]: [...values] }); onScopeChange({ ...scopeByChannel, [id]: "selected" });
    };
    return <section className="space-y-3" aria-label="Posts por perfil">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium text-ios-text">Posts que podem disparar esta regra</p><p className="text-xs text-ios-text-secondary">A lista mostra posts publicados pelo AutoReels. Posts externos podem ser adicionados pelos IDs manuais.</p></div><button type="button" onClick={selectAll} className="min-h-11 px-3 rounded-lg text-sm font-medium text-ios-blue hover:bg-ios-blue/10">Todos os perfis: todos os posts</button></div>
        <label className="relative block"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ios-text-secondary"/><input className={`${input} pl-9`} value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar posts por legenda" aria-label="Buscar posts"/></label>
        {!selectedIds.length && <p className="text-sm text-ios-text-secondary rounded-xl border border-dashed border-ios-separator p-4">Selecione ao menos um perfil para carregar os posts.</p>}
        {selectedIds.map(id => {
            const channel = channels.find(c => c.id === id); const list = posts.filter(p => p.channelId === id); const selected = mediaIdsByChannel[id] ?? [];
            return <div key={id} className="rounded-xl border border-ios-separator p-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-sm text-ios-text">{channel ? channelLabel(channel) : id}</p><div className="flex gap-1"><button type="button" onClick={() => setAll(id)} aria-pressed={allFor(id)} className={`min-h-11 px-3 rounded-lg text-sm ${allFor(id) ? "bg-ios-blue/10 text-ios-blue" : "text-ios-text-secondary hover:bg-ios-gray-5"}`}>Todos</button><button type="button" onClick={() => setSelected(id)} aria-pressed={!allFor(id)} className={`min-h-11 px-3 rounded-lg text-sm ${!allFor(id) ? "bg-ios-blue/10 text-ios-blue" : "text-ios-text-secondary hover:bg-ios-gray-5"}`}>Selecionados</button></div></div>
                {allFor(id) ? <p className="text-xs text-ios-text-secondary">Qualquer post deste perfil pode disparar a regra.</p> : <p className="text-xs text-ios-text-secondary">Selecione ao menos um post. Sem seleção, este perfil não aceitará eventos.</p>}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{list.map(p => { const checked = selected.includes(p.mediaId); return <button key={p.mediaId} type="button" onClick={() => toggle(id, p.mediaId)} aria-pressed={checked} className={`text-left rounded-lg border overflow-hidden min-w-0 ${checked ? "border-ios-blue ring-2 ring-ios-blue/30" : "border-ios-separator"}`}><PostThumbnail src={p.thumbnailUrl}/><p className="p-2 text-xs text-ios-text line-clamp-2">{p.caption || p.mediaId}</p><span className="sr-only">{checked ? "Selecionado" : "Não selecionado"}</span></button>; })}</div>
                {!list.length && !loading && <p className="text-xs text-ios-text-secondary">Nenhum post encontrado para este perfil.</p>}
            </div>;
        })}
        {loading && <p className="flex items-center gap-2 text-xs text-ios-text-secondary"><Loader2 size={14} className="animate-spin"/>Carregando posts…</p>}{error && <p role="status" className="text-xs text-ios-orange">{error}</p>}{hasMore && <button type="button" onClick={more} disabled={loading} className="min-h-11 px-4 rounded-lg border border-ios-separator text-sm">Carregar mais</button>}
        <details className="rounded-xl border border-ios-separator p-3"><summary className="cursor-pointer min-h-8 text-sm font-medium text-ios-text">IDs manuais e posts antigos</summary><div className="mt-2 space-y-3">{selectedIds.map(id => <label key={id} className="block text-xs text-ios-text-secondary">{channels.find(c => c.id === id)?.username || id}<textarea rows={2} value={(mediaIdsByChannel[id] ?? []).filter(mediaId => !known.has(`${id}:${mediaId}`)).join("\n")} onChange={e => { const old = mediaIdsByChannel[id] ?? []; const loaded = old.filter(mediaId => known.has(`${id}:${mediaId}`)); const manual = e.target.value.split(/[\n,]+/).map(v => v.trim()).filter(Boolean); onChange({ ...mediaIdsByChannel, [id]: [...new Set([...loaded, ...manual])] }); onScopeChange({ ...scopeByChannel, [id]: "selected" }); }} placeholder="Um mediaId por linha" className={`${input} mt-1 font-mono`}/></label>)}</div></details>
    </section>;
}
