"use client";
import { useState, useEffect, useCallback, useRef } from 'react';
import {
    Youtube, Film, MessageSquare, RefreshCw, Heart, Pin, ThumbsUp,
    MessageCirclePlus, CheckCircle2, XCircle, ChevronLeft, Inbox,
} from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import IOSCard from '@/components/IOSComponents';

interface Channel {
    id: string;
    name: string;
    platform: string;
    account_id: string;
}

interface YoutubePost {
    id: string;
    caption?: string;
    status: string;
    scheduled_at?: string;
    published_at?: string;
    media_type?: string;
    youtube_type?: string | null;
    youtube_video_id?: string | null;
    youtube_post_id?: string | null;
}

interface CommentItem {
    comment_id?: string;
    text?: string;
    author?: string;
    pinned?: boolean;
    hearted?: boolean;
    liked?: boolean;
    [key: string]: unknown;
}

type Toast = { msg: string; type: 'ok' | 'err' } | null;

/** Extrai mensagem de erro de uma resposta fetch. */
async function extractError(res: Response, fallback: string): Promise<string> {
    const data = await res.json().catch(() => ({}));
    return (data as { error?: string }).error || `${fallback} (HTTP ${res.status})`;
}

function formatCommentDate(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export default function YoutubeCommentsPage() {
    const [channels, setChannels] = useState<Channel[]>([]);
    const [selectedChannel, setSelectedChannel] = useState<string>('');
    // Falha ao carregar canais é distinta de "não há canais": sem isso uma
    // sessão expirada/erro de rede mostraria o estado vazio enganoso.
    const [channelsError, setChannelsError] = useState('');
    const [channelsLoading, setChannelsLoading] = useState(true);
    // Token de sequência: ignora respostas obsoletas quando o usuário troca
    // rápido de post e duas requisições de comentários estão em voo.
    const commentsSeqRef = useRef(0);
    const [posts, setPosts] = useState<YoutubePost[]>([]);
    const [postsLoading, setPostsLoading] = useState(false);
    const [postsError, setPostsError] = useState('');
    const [selectedPostId, setSelectedPostId] = useState<string>('');

    const [comments, setComments] = useState<CommentItem[]>([]);
    const [commentsLoading, setCommentsLoading] = useState(false);
    const [commentsError, setCommentsError] = useState('');

    const [newComment, setNewComment] = useState('');
    const [pinnedComment, setPinnedComment] = useState('');
    const [pinnedHeart, setPinnedHeart] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [actingId, setActingId] = useState<string | null>(null);
    const [toast, setToast] = useState<Toast>(null);
    // Timer do toast anterior deve ser limpo antes de criar um novo — um timer
    // antigo dispensaria o toast NOVO cedo (mesmo fix de settings/analytics).
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((msg: string, type: 'ok' | 'err' = 'ok') => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast({ msg, type });
        toastTimerRef.current = setTimeout(() => setToast(null), 3500);
    }, []);

    useEffect(() => {
        return () => {
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        };
    }, []);

    // Canais disponíveis (somente YouTube)
    const fetchChannels = useCallback(async () => {
        setChannelsLoading(true);
        setChannelsError('');
        try {
            const res = await fetch('/api/channels');
            if (!res.ok) throw new Error(`Falha ao carregar canais (HTTP ${res.status})`);
            const data = (await res.json()) as Channel[];
            const yt = data.filter((c) => c.platform === 'youtube');
            setChannels(yt);
            if (yt.length > 0) setSelectedChannel((prev) => prev || yt[0].id);
        } catch (err: unknown) {
            setChannels([]);
            setChannelsError(err instanceof Error ? err.message : 'Falha ao carregar canais');
        } finally {
            setChannelsLoading(false);
        }
    }, []);

    useEffect(() => { fetchChannels(); }, [fetchChannels]);

    const selectedPost = posts.find((p) => p.id === selectedPostId) || null;

    // Posts publicados do canal selecionado
    const fetchPosts = useCallback(async () => {
        if (!selectedChannel) return;
        setPostsLoading(true);
        setPostsError('');
        setSelectedPostId('');
        setComments([]);
        try {
            const res = await fetch(`/api/posts?channel_id=${encodeURIComponent(selectedChannel)}&status=published`);
            if (!res.ok) throw new Error(await extractError(res, 'Falha ao carregar publicações'));
            const data = (await res.json()) as YoutubePost[];
            setPosts(data);
        } catch (err: unknown) {
            setPostsError(err instanceof Error ? err.message : 'Falha ao carregar publicações');
        } finally {
            setPostsLoading(false);
        }
    }, [selectedChannel]);

    useEffect(() => { fetchPosts(); }, [fetchPosts]);

    // Comentários do vídeo selecionado
    const fetchComments = useCallback(async () => {
        if (!selectedChannel || !selectedPost?.youtube_video_id) return;
        const seq = ++commentsSeqRef.current;
        setCommentsLoading(true);
        setCommentsError('');
        try {
            const params = new URLSearchParams({
                channelId: selectedChannel,
                videoId: selectedPost.youtube_video_id,
                limit: '50',
            });
            const res = await fetch(`/api/youtube/comments?${params.toString()}`);
            if (!res.ok) throw new Error(await extractError(res, 'Falha ao carregar comentários'));
            const data = await res.json();
            // Resposta obsoleta (o usuário já trocou de post): descarta.
            if (seq !== commentsSeqRef.current) return;
            setComments(Array.isArray(data.comments) ? data.comments : []);
        } catch (err: unknown) {
            if (seq !== commentsSeqRef.current) return;
            setCommentsError(err instanceof Error ? err.message : 'Falha ao carregar comentários');
        } finally {
            if (seq === commentsSeqRef.current) setCommentsLoading(false);
        }
    }, [selectedChannel, selectedPost]);

    useEffect(() => { fetchComments(); }, [fetchComments]);

    /** Ação em um comentário existente: curtir | coração | fixar. */
    async function runAction(comment: CommentItem, action: 'like' | 'heart' | 'pin') {
        if (!selectedChannel || !selectedPost?.youtube_video_id || !comment.comment_id) return;
        setActingId(comment.comment_id);
        try {
            const res = await fetch('/api/youtube/comments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channelId: selectedChannel,
                    videoId: selectedPost.youtube_video_id,
                    commentId: comment.comment_id,
                    action,
                }),
            });
            if (!res.ok) throw new Error(await extractError(res, 'Ação falhou'));
            showToast(
                action === 'like' ? 'Comentário curtido'
                    : action === 'heart' ? 'Coração adicionado'
                        : 'Comentário fixado',
            );
            await fetchComments();
        } catch (err: unknown) {
            showToast(err instanceof Error ? err.message : 'Ação falhou', 'err');
        } finally {
            setActingId(null);
        }
    }

    /** Cria um comentário comum no vídeo selecionado. */
    async function submitComment(e: React.FormEvent) {
        e.preventDefault();
        const text = newComment.trim();
        if (!text || !selectedChannel || !selectedPost?.youtube_video_id) return;
        setSubmitting(true);
        try {
            const res = await fetch('/api/youtube/comments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channelId: selectedChannel,
                    videoId: selectedPost.youtube_video_id,
                    text,
                }),
            });
            if (!res.ok) throw new Error(await extractError(res, 'Falha ao comentar'));
            setNewComment('');
            showToast('Comentário publicado');
            await fetchComments();
        } catch (err: unknown) {
            showToast(err instanceof Error ? err.message : 'Falha ao comentar', 'err');
        } finally {
            setSubmitting(false);
        }
    }

    /** Cria o comentário fixado (comenta → coração → fixa, na API externa). */
    async function submitPinnedComment(e: React.FormEvent) {
        e.preventDefault();
        const text = pinnedComment.trim();
        if (!text || !selectedChannel || !selectedPost?.youtube_video_id) return;
        setSubmitting(true);
        try {
            const res = await fetch('/api/youtube/comments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channelId: selectedChannel,
                    videoId: selectedPost.youtube_video_id,
                    text,
                    pinned: true,
                    heart: pinnedHeart,
                }),
            });
            if (!res.ok) throw new Error(await extractError(res, 'Falha ao criar comentário fixado'));
            setPinnedComment('');
            showToast('Comentário fixado criado');
            await fetchComments();
        } catch (err: unknown) {
            showToast(err instanceof Error ? err.message : 'Falha ao criar comentário fixado', 'err');
        } finally {
            setSubmitting(false);
        }
    }

    const commentablePosts = posts.filter((p) => p.youtube_video_id);

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
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-[34px] font-bold text-ios-text flex items-center gap-2">
                        <Youtube size={28} className="text-ios-red" />
                        Comentários do YouTube
                    </h1>
                    <p className="text-ios-text-secondary text-sm">
                        Gerencie os comentários dos Shorts publicados pelos seus canais.
                    </p>
                </div>
            </div>

            {/* Seleção de canal */}
            {channels.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                    {channels.map((ch) => (
                        <button
                            key={ch.id}
                            onClick={() => setSelectedChannel(ch.id)}
                            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold border whitespace-nowrap transition-colors ${selectedChannel === ch.id ? 'bg-ios-red text-white border-ios-red' : 'bg-ios-card border-ios-separator text-ios-text-secondary'}`}
                        >
                            <span className="w-5 h-5 rounded-full bg-ios-red/10 flex items-center justify-center text-ios-red text-[10px] font-bold">
                                {ch.name[0]?.toUpperCase() ?? '?'}
                            </span>
                            {ch.name}
                        </button>
                    ))}
                </div>
            )}

            {/* ── Estados globais ─────────────────────────────────────────── */}
            {channelsLoading ? (
                <div className="flex justify-center p-12">
                    <RefreshCw size={24} className="animate-spin text-ios-blue" />
                </div>
            ) : channelsError ? (
                <IOSCard className="p-8 text-center space-y-3">
                    <XCircle size={32} className="mx-auto text-ios-red opacity-70" />
                    <p className="text-[15px] font-semibold text-ios-text">Falha ao carregar canais</p>
                    <p className="text-[13px] text-ios-text-secondary">{channelsError}</p>
                    <IOSButton variant="secondary" onClick={fetchChannels} className="mt-1 justify-center">
                        Tentar novamente
                    </IOSButton>
                </IOSCard>
            ) : channels.length === 0 ? (
                <IOSCard className="p-12 text-center text-ios-text-secondary">
                    <Youtube size={48} className="mx-auto mb-4 opacity-30" strokeWidth={1} />
                    <h3 className="text-xl font-semibold mb-2 text-ios-text">Nenhum canal YouTube</h3>
                    <p className="max-w-xs mx-auto">Conecte um canal do YouTube em Canais para gerenciar comentários.</p>
                </IOSCard>
            ) : postsLoading ? (
                <div className="flex justify-center p-12">
                    <RefreshCw size={24} className="animate-spin text-ios-blue" />
                </div>
            ) : postsError ? (
                <IOSCard className="p-8 text-center space-y-3">
                    <XCircle size={32} className="mx-auto text-ios-red opacity-70" />
                    <p className="text-[15px] font-semibold text-ios-text">Falha ao carregar publicações</p>
                    <p className="text-[13px] text-ios-text-secondary">{postsError}</p>
                    <IOSButton variant="secondary" onClick={fetchPosts} className="mt-1 justify-center">
                        Tentar novamente
                    </IOSButton>
                </IOSCard>
            ) : posts.length === 0 ? (
                <IOSCard className="p-12 text-center text-ios-text-secondary">
                    <Inbox size={48} className="mx-auto mb-4 opacity-30" strokeWidth={1} />
                    <h3 className="text-xl font-semibold mb-2 text-ios-text">Nada publicado ainda</h3>
                    <p className="max-w-xs mx-auto">Este canal ainda não tem publicações concluídas.</p>
                </IOSCard>
            ) : (
                <>
                    {/* Lista de vídeos/publicações */}
                    <div className="space-y-3">
                        <h2 className="text-[13px] font-bold text-ios-text-secondary uppercase tracking-wide px-1">
                            Publicações
                        </h2>
                        {commentablePosts.length === 0 && (
                            <IOSCard className="p-6 text-center text-[13px] text-ios-text-secondary">
                                Este canal só tem posts na Comunidade — a API do YouTube expõe comentários apenas de Shorts/vídeos.
                            </IOSCard>
                        )}
                        {commentablePosts.map((post) => {
                            const isActive = post.id === selectedPostId;
                            return (
                                <button
                                    key={post.id}
                                    onClick={() => setSelectedPostId(isActive ? '' : post.id)}
                                    className={`w-full text-left p-4 rounded-xl border transition-all ${isActive ? 'bg-ios-red/5 border-ios-red' : 'bg-ios-card border-ios-separator hover:border-ios-red/40'}`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <Film size={14} className="text-ios-red shrink-0" />
                                                <span className="font-semibold text-[15px] text-ios-text truncate">
                                                    {(post.caption || '').slice(0, 80) || 'Short sem título'}
                                                </span>
                                            </div>
                                            <p className="text-[11px] text-ios-text-secondary mt-0.5 font-mono truncate">
                                                vídeo {post.youtube_video_id}
                                                {post.published_at ? ` · ${new Date(post.published_at).toLocaleString()}` : ''}
                                            </p>
                                        </div>
                                        {isActive && <ChevronLeft size={16} className="text-ios-red rotate-90 shrink-0" />}
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {/* ── Comentários do vídeo selecionado ────────────────────── */}
                    {selectedPost?.youtube_video_id && (
                        <div className="space-y-4">
                            <h2 className="text-[13px] font-bold text-ios-text-secondary uppercase tracking-wide px-1">
                                Comentários
                            </h2>

                            {/* Criar comentário */}
                            <IOSCard className="p-4 space-y-3">
                                <form onSubmit={submitComment} className="flex items-end gap-2">
                                    <textarea
                                        rows={2}
                                        maxLength={10000}
                                        value={newComment}
                                        onChange={(e) => setNewComment(e.target.value)}
                                        placeholder="Escrever um comentário como o canal..."
                                        className="flex-1 bg-ios-background border border-ios-separator rounded-xl px-4 py-2.5 text-[15px] focus:outline-none focus:ring-1 focus:ring-ios-red resize-none"
                                    />
                                    <IOSButton variant="primary" disabled={submitting || !newComment.trim()} className="!py-2.5 !px-3 justify-center shrink-0">
                                        <MessageCirclePlus size={16} />
                                    </IOSButton>
                                </form>

                                {/* Criar comentário fixado */}
                                <form onSubmit={submitPinnedComment} className="border-t border-ios-separator pt-3 space-y-2">
                                    <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ios-text-secondary uppercase tracking-wide">
                                        <Pin size={12} /> Comentário fixado
                                    </div>
                                    <div className="flex items-end gap-2">
                                        <input
                                            type="text"
                                            maxLength={10000}
                                            value={pinnedComment}
                                            onChange={(e) => setPinnedComment(e.target.value)}
                                            placeholder="Texto do comentário que será criado e fixado"
                                            className="flex-1 bg-ios-background border border-ios-separator rounded-xl px-4 py-2.5 text-[15px] focus:outline-none focus:ring-1 focus:ring-ios-red"
                                        />
                                        <label className="flex items-center gap-1.5 text-[12px] text-ios-text-secondary cursor-pointer select-none pb-2.5">
                                            <input
                                                type="checkbox"
                                                checked={pinnedHeart}
                                                onChange={(e) => setPinnedHeart(e.target.checked)}
                                                className="w-3.5 h-3.5 accent-red-500"
                                            />
                                            ♥ automático
                                        </label>
                                        <IOSButton variant="secondary" disabled={submitting || !pinnedComment.trim()} className="!py-2 !px-3 !text-[13px] justify-center shrink-0">
                                            <Pin size={13} /> Fixar
                                        </IOSButton>
                                    </div>
                                </form>
                            </IOSCard>

                            {/* Lista de comentários */}
                            {commentsLoading ? (
                                <div className="flex justify-center p-10">
                                    <RefreshCw size={22} className="animate-spin text-ios-blue" />
                                </div>
                            ) : commentsError ? (
                                <IOSCard className="p-8 text-center space-y-3">
                                    <XCircle size={30} className="mx-auto text-ios-red opacity-70" />
                                    <p className="text-[14px] font-semibold text-ios-text">Falha ao carregar comentários</p>
                                    <p className="text-[13px] text-ios-text-secondary">{commentsError}</p>
                                    <IOSButton variant="secondary" onClick={fetchComments} className="mt-1 justify-center">
                                        Tentar novamente
                                    </IOSButton>
                                </IOSCard>
                            ) : comments.length === 0 ? (
                                <IOSCard className="p-10 text-center text-ios-text-secondary">
                                    <MessageSquare size={36} className="mx-auto mb-3 opacity-30" strokeWidth={1} />
                                    <p className="text-[15px] font-semibold text-ios-text">Sem comentários</p>
                                    <p className="text-[13px] mt-1">Seja o primeiro a comentar neste Short.</p>
                                </IOSCard>
                            ) : (
                                <div className="space-y-2">
                                    {comments.map((c, i) => (
                                        <IOSCard key={c.comment_id || `comment-${i}`} className="p-4">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="font-semibold text-[14px] text-ios-text">
                                                            {typeof c.author === 'string' && c.author ? c.author : 'Autor desconhecido'}
                                                        </span>
                                                        {c.pinned && (
                                                            <span className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ios-blue/10 text-ios-blue">
                                                                <Pin size={9} /> fixado
                                                            </span>
                                                        )}
                                                        {c.hearted && (
                                                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ios-red/10 text-ios-red">
                                                                ♥ do autor
                                                            </span>
                                                        )}
                                                        {c.liked && (
                                                            <span className="flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ios-green/10 text-ios-green">
                                                                <ThumbsUp size={9} /> curtido
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="text-[14px] text-ios-text mt-1 whitespace-pre-wrap break-words">
                                                        {typeof c.text === 'string' ? c.text : ''}
                                                    </p>
                                                    {(formatCommentDate(c.created_at) || formatCommentDate(c.published_at)) && (
                                                        <p className="text-[11px] text-ios-text-secondary mt-1">
                                                            {formatCommentDate(c.created_at) || formatCommentDate(c.published_at)}
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="flex gap-1 shrink-0">
                                                    <button
                                                        onClick={() => runAction(c, 'like')}
                                                        disabled={!c.comment_id || actingId === c.comment_id}
                                                        title="Curtir"
                                                        className="p-2 rounded-lg text-ios-green hover:bg-ios-green/10 transition-colors disabled:opacity-40"
                                                    >
                                                        {actingId === c.comment_id
                                                            ? <RefreshCw size={15} className="animate-spin" />
                                                            : <ThumbsUp size={15} />}
                                                    </button>
                                                    <button
                                                        onClick={() => runAction(c, 'heart')}
                                                        disabled={!c.comment_id || actingId === c.comment_id}
                                                        title="Dar coração do autor"
                                                        className="p-2 rounded-lg text-ios-red hover:bg-ios-red/10 transition-colors disabled:opacity-40"
                                                    >
                                                        <Heart size={15} />
                                                    </button>
                                                    {!c.pinned && (
                                                        <button
                                                            onClick={() => runAction(c, 'pin')}
                                                            disabled={!c.comment_id || actingId === c.comment_id}
                                                            title="Fixar comentário"
                                                            className="p-2 rounded-lg text-ios-blue hover:bg-ios-blue/10 transition-colors disabled:opacity-40"
                                                        >
                                                            <Pin size={15} />
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        </IOSCard>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
