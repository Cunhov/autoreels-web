'use client';
import { useEffect, useRef, useState } from 'react';
import {
    X, Calendar as CalendarIcon, Clock, Play, AlertCircle,
    Ban, RotateCcw, CalendarClock, Copy, CheckCircle2
} from 'lucide-react';
import { Post } from '@/app/types';
import IOSButton from '@/components/IOSButton';
import LocalPreviewModal from '@/components/Calendar/LocalPreviewModal';

interface DayDetailsModalProps {
    date: Date;
    posts: Post[];
    onClose: () => void;
    onPostClick: (post: Post) => void;
    /** Called after any mutation (cancel/retry/reschedule/duplicate) so the parent refetches. */
    onPostsChanged?: () => void;
}

/** Post statuses that live outside the current `Post` type union (added by the posts API work). */
const statusOf = (p: Post) => p.status as string;

type Feedback = { type: 'success' | 'error'; message: string } | null;

/** Convert an ISO timestamp to a `<input type="datetime-local">` value (local wall-clock). */
function toLocalInputValue(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Current local wall-clock as a `<input type="datetime-local">` value (for `min`). */
function toLocalNowValue(): string {
    return toLocalInputValue(new Date().toISOString());
}

/** Full-screen local preview for scheduled/pending posts (not yet on Instagram) —
 *  now imported from components/Calendar/LocalPreviewModal.tsx (shared with the
 *  calendar page for the pending/scheduled dead-click fix). */

/** Compact modal to pick a new schedule for a post. Empty value = publish on the next cron tick. */

/** Compact modal to pick a new schedule for a post. Empty value = publish on the next cron tick. */
function RescheduleModal({
    post,
    onClose,
    onConfirm,
    busy,
    error,
}: {
    post: Post;
    onClose: () => void;
    onConfirm: (value: string) => void;
    busy: boolean;
    /** Validation / request error — keeps the modal open with the typed value. */
    error: string | null;
}) {
    const [value, setValue] = useState(post.scheduled_at ? toLocalInputValue(post.scheduled_at) : '');

    return (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-ios-card w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl border border-ios-separator">
                <div className="px-5 py-4 border-b border-ios-separator flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <CalendarClock size={18} className="text-ios-blue" />
                        <h3 className="text-[17px] font-semibold text-ios-text">Reagendar post</h3>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-full hover:bg-black/5 text-ios-secondary transition-colors">
                        <X size={18} />
                    </button>
                </div>
                <div className="p-5 space-y-3">
                    <p className="text-xs text-ios-secondary">
                        Escolha a nova data/hora. Deixe vazio para publicar no próximo ciclo do agendador.
                    </p>
                    <input
                        type="datetime-local"
                        value={value}
                        min={toLocalNowValue()}
                        onChange={(e) => setValue(e.target.value)}
                        className="w-full rounded-xl border border-ios-separator bg-ios-background px-3 py-2.5 text-sm text-ios-text focus:outline-none focus:ring-2 focus:ring-ios-blue/40"
                    />
                    {error && (
                        <p className="text-xs text-ios-red bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/40 rounded-lg px-3 py-2">
                            {error}
                        </p>
                    )}
                    <div className="flex gap-2 pt-1">
                        <IOSButton onClick={onClose} variant="secondary" className="flex-1" disabled={busy}>
                            Cancelar
                        </IOSButton>
                        <IOSButton onClick={() => onConfirm(value)} variant="primary" className="flex-1" disabled={busy}>
                            {value ? 'Agendar' : 'Publicar agora'}
                        </IOSButton>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function DayDetailsModal({ date, posts, onClose, onPostClick, onPostsChanged }: DayDetailsModalProps) {
    const [previewPost, setPreviewPost] = useState<Post | null>(null);
    const [reschedulePost, setReschedulePost] = useState<Post | null>(null);
    const [rescheduleError, setRescheduleError] = useState<string | null>(null);
    const [confirmingCancelId, setConfirmingCancelId] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Feedback>(null);
    const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showFeedback = (type: 'success' | 'error', message: string) => {
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        setFeedback({ type, message });
        feedbackTimer.current = setTimeout(() => setFeedback(null), 3500);
    };

    useEffect(() => {
        return () => {
            if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        };
    }, []);

    const getBorderClass = (status: string) => {
        switch (status) {
            case 'failed': return 'border-red-500 ring-1 ring-red-500/50';
            case 'published': return 'border-green-500 ring-1 ring-green-500/50';
            default: return 'border-gray-400 dark:border-gray-600';
        }
    };

    const handlePostClick = (post: Post) => {
        if (post.status === 'failed' || post.status === 'published') {
            // Delegate to parent — ErrorModal or SuccessModal
            onPostClick(post);
        } else {
            // For pending/scheduled show local preview
            setPreviewPost(post);
        }
    };

    // ── API helpers ───────────────────────────────────────────────────────────
    const patchPost = async (post: Post, body: Record<string, unknown>): Promise<Post> => {
        const res = await fetch(`/api/posts/${post.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error((data as { error?: string }).error || 'Falha na operação');
        }
        return res.json();
    };

    const handleCancel = async (post: Post) => {
        setBusyId(post.id);
        try {
            await patchPost(post, { status: 'cancelled' });
            showFeedback('success', 'Post cancelado');
            onPostsChanged?.();
        } catch (e) {
            showFeedback('error', (e as Error).message);
        } finally {
            setBusyId(null);
            setConfirmingCancelId(null);
        }
    };

    const handleRetry = async (post: Post) => {
        setBusyId(post.id);
        try {
            await patchPost(post, { status: 'pending' });
            showFeedback('success', 'Post re-enfileirado');
            onPostsChanged?.();
        } catch (e) {
            showFeedback('error', (e as Error).message);
        } finally {
            setBusyId(null);
        }
    };

    const handleRescheduleSubmit = async (post: Post, value: string) => {
        setBusyId(post.id);
        setRescheduleError(null);
        try {
            if (value) {
                const d = new Date(value);
                if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
                    // Keep the modal open with the typed value; no request made.
                    setRescheduleError('Escolha uma data/hora futura.');
                    return;
                }
                await patchPost(post, { scheduled_at: d.toISOString() });
                showFeedback('success', 'Post reagendado');
            } else {
                // Publish now: always clear the schedule so the cron picks it up on
                // the next tick — even if the post still has a future scheduled_at.
                await patchPost(post, { status: 'pending', scheduled_at: null });
                showFeedback('success', 'Post re-enfileirado (próximo ciclo)');
            }
            // Only close on success — a failed request keeps the modal open so the
            // user's typed value is not lost.
            setReschedulePost(null);
            onPostsChanged?.();
        } catch (e) {
            const msg = (e as Error).message;
            setRescheduleError(
                msg.includes('retried in its current status')
                    ? 'Este post já está pendente — será publicado no próximo ciclo do agendador.'
                    : msg
            );
        } finally {
            setBusyId(null);
        }
    };

    const handleDuplicate = async (post: Post) => {
        setBusyId(post.id);
        try {
            const payload: Record<string, unknown> = {
                video_url: post.video_url || null,
                image_url: post.image_url || null,
                thumbnail_url: post.thumbnail_url || null,
                caption: post.caption || '',
                media_type: (post as unknown as { media_type?: string }).media_type || 'REELS',
                channel_id: post.channel_id || null,
                // scheduled_at: null → the cron treats it as due on the next tick
                scheduled_at: null,
            };
            const children = (post as unknown as { children_urls?: string }).children_urls;
            if (children) payload.children_urls = children;

            const res = await fetch('/api/posts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((data as { error?: string }).error || 'Falha ao duplicar');
            }
            showFeedback('success', 'Post duplicado — publicado no próximo ciclo');
            onPostsChanged?.();
        } catch (e) {
            showFeedback('error', (e as Error).message);
        } finally {
            setBusyId(null);
        }
    };

    return (
        <>
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                <div className="bg-ios-card w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200 border border-ios-separator">
                    {/* Header */}
                    <div className="px-6 py-4 border-b border-ios-separator flex items-center justify-between bg-ios-background/80 backdrop-blur-md">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-ios-blue/10 flex items-center justify-center text-ios-blue">
                                <CalendarIcon size={20} />
                            </div>
                            <div>
                                <h2 className="text-[17px] font-semibold text-ios-text">
                                    {date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                                </h2>
                                <p className="text-xs text-ios-secondary">
                                    {posts.length} post{posts.length !== 1 ? 's' : ''} scheduled
                                </p>
                            </div>
                        </div>
                        <button onClick={onClose} title="Close" className="p-2 rounded-full hover:bg-black/5 text-ios-secondary transition-colors">
                            <X size={20} />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                        {posts.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-40 text-ios-secondary">
                                <p>No posts scheduled for this day.</p>
                            </div>
                        ) : (
                            posts.map(post => {
                                const status = statusOf(post);
                                const canCancel = ['pending', 'scheduled', 'ready_to_publish'].includes(status);
                                const canRetry = ['failed', 'cancelled'].includes(status);
                                const canManage = ['pending', 'scheduled', 'failed', 'cancelled'].includes(status);
                                const isPublished = status === 'published';
                                const isBusy = busyId === post.id;
                                const confirming = confirmingCancelId === post.id;

                                return (
                                    <div
                                        key={post.id}
                                        onClick={() => handlePostClick(post)}
                                        className={`flex flex-col gap-2 p-3 rounded-xl border bg-ios-background hover:bg-ios-gray-6/50 transition-colors cursor-pointer group ${getBorderClass(post.status)}`}
                                    >
                                        <div className="flex items-start gap-4">
                                            {/* Thumbnail */}
                                            <div className="w-16 h-20 bg-black/5 rounded-lg overflow-hidden flex-shrink-0 relative border border-black/5">
                                                {post.video_url ? (
                                                    /* No <video> — show thumbnail_url if available, else a static placeholder */
                                                    post.thumbnail_url ? (
                                                        <img src={post.thumbnail_url} className="w-full h-full object-cover" alt="Video thumbnail" />
                                                    ) : (
                                                        <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                                                            <Play className="w-5 h-5 text-white/40 fill-white/20" />
                                                        </div>
                                                    )
                                                ) : post.image_url || post.thumbnail_url ? (
                                                    <img src={post.image_url || post.thumbnail_url} className="w-full h-full object-cover" alt="Post preview" />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center text-[10px] text-ios-secondary text-center p-1">No Media</div>
                                                )}

                                                {/* Play icon overlay for video/pending */}
                                                {(post.video_url && post.status !== 'published') && (
                                                    <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/50 transition-colors">
                                                        <Play className="w-6 h-6 text-white/90 drop-shadow-md fill-white" />
                                                    </div>
                                                )}

                                                {/* Status dot */}
                                                <div className={`absolute top-1 right-1 w-2.5 h-2.5 rounded-full border border-white/20 shadow-sm ${post.status === 'published' ? 'bg-ios-green' :
                                                    post.status === 'failed' ? 'bg-red-500' : 'bg-gray-400'
                                                    }`} />
                                            </div>

                                            {/* Details */}
                                            <div className="flex-1 min-w-0 py-0.5">
                                                <div className="flex items-center justify-between mb-1">
                                                    <div className="flex items-center gap-1.5 text-xs font-medium text-ios-secondary">
                                                        <Clock size={12} />
                                                        {new Date(post.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                    </div>
                                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide
                                                        ${post.status === 'published' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                                            post.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                                                'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                                                        {post.status.replace('_', ' ')}
                                                    </span>
                                                </div>
                                                <p className="text-sm text-ios-text font-medium line-clamp-2 leading-relaxed">
                                                    {post.caption || <span className="text-ios-secondary italic">No caption</span>}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Inline error snippet for failed posts */}
                                        {post.status === 'failed' && (post.error_message || post.failed_reason) && (
                                            <div className="flex items-start gap-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/40 rounded-lg px-3 py-2 mt-1">
                                                <AlertCircle size={13} className="text-red-500 shrink-0 mt-0.5" />
                                                <p className="text-xs text-red-700 dark:text-red-300 font-mono break-words line-clamp-2">
                                                    {post.error_message || post.failed_reason}
                                                </p>
                                            </div>
                                        )}

                                        {/* Actions (hidden for published posts) */}
                                        {!isPublished && (
                                            <div
                                                className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 mt-1 border-t border-ios-separator/60"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                {confirming ? (
                                                    <>
                                                        <span className="text-[11px] text-ios-secondary">Cancelar publicação?</span>
                                                        <button
                                                            onClick={() => handleCancel(post)}
                                                            disabled={isBusy}
                                                            className="text-[12px] font-semibold text-ios-red hover:underline disabled:opacity-50"
                                                        >
                                                            Sim, cancelar
                                                        </button>
                                                        <button
                                                            onClick={() => setConfirmingCancelId(null)}
                                                            disabled={isBusy}
                                                            className="text-[12px] font-semibold text-ios-secondary hover:underline disabled:opacity-50"
                                                        >
                                                            Voltar
                                                        </button>
                                                    </>
                                                ) : (
                                                    <>
                                                        {canCancel && (
                                                            <button
                                                                onClick={() => setConfirmingCancelId(post.id)}
                                                                disabled={isBusy}
                                                                title="Cancelar post"
                                                                className="inline-flex items-center gap-1 text-[12px] font-semibold text-ios-red hover:underline disabled:opacity-50"
                                                            >
                                                                <Ban size={12} /> Cancelar
                                                            </button>
                                                        )}
                                                        {canRetry && (
                                                            <button
                                                                onClick={() => handleRetry(post)}
                                                                disabled={isBusy}
                                                                title="Tentar novamente"
                                                                className="inline-flex items-center gap-1 text-[12px] font-semibold text-ios-blue hover:underline disabled:opacity-50"
                                                            >
                                                                <RotateCcw size={12} /> Tentar novamente
                                                            </button>
                                                        )}
                                                        {canManage && (
                                                            <button
                                                                onClick={() => setReschedulePost(post)}
                                                                disabled={isBusy}
                                                                title="Reagendar"
                                                                className="inline-flex items-center gap-1 text-[12px] font-semibold text-ios-text-secondary hover:underline disabled:opacity-50"
                                                            >
                                                                <CalendarClock size={12} /> Reagendar
                                                            </button>
                                                        )}
                                                        {canManage && (
                                                            <button
                                                                onClick={() => handleDuplicate(post)}
                                                                disabled={isBusy}
                                                                title="Duplicar post"
                                                                className="inline-flex items-center gap-1 text-[12px] font-semibold text-ios-text-secondary hover:underline disabled:opacity-50"
                                                            >
                                                                <Copy size={12} /> Duplicar
                                                            </button>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>

                    {/* Footer */}
                    <div className="p-4 border-t border-ios-separator bg-ios-background">
                        <IOSButton onClick={onClose} variant="secondary" className="w-full justify-center">
                            Close
                        </IOSButton>
                    </div>
                </div>
            </div>

            {/* Local preview for pending/scheduled posts */}
            {previewPost && (
                <LocalPreviewModal post={previewPost} onClose={() => setPreviewPost(null)} />
            )}

            {/* Reschedule modal */}
            {reschedulePost && (
                <RescheduleModal
                    post={reschedulePost}
                    busy={busyId === reschedulePost.id}
                    error={rescheduleError}
                    onClose={() => { setReschedulePost(null); setRescheduleError(null); }}
                    onConfirm={(value) => handleRescheduleSubmit(reschedulePost, value)}
                />
            )}

            {/* Action feedback toast */}
            {feedback && (
                <div className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200 ${feedback.type === 'success' ? 'bg-black/80' : 'bg-red-600/95'}`}>
                    {feedback.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                    {feedback.message}
                </div>
            )}
        </>
    );
}
