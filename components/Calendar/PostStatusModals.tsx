'use client';
import { useState } from 'react';
import { X, AlertCircle, RotateCcw } from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import { Post } from '@/app/types';

interface ErrorModalProps {
    post: Post;
    onClose: () => void;
    /** Called after a successful retry so the parent can refetch the post list. */
    onPostsChanged?: () => void;
}

export function ErrorModal({ post, onClose, onPostsChanged }: ErrorModalProps) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleRetry = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/posts/${post.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'pending' }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((data as { error?: string }).error || 'Falha ao re-enfileirar');
            }
            onClose();
            onPostsChanged?.();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-zinc-900 w-full max-w-md rounded-2xl overflow-hidden shadow-2xl scale-100 animate-in zoom-in-95 duration-200">
                <div className="p-6">
                    <div className="flex items-center gap-3 mb-4 text-red-500">
                        <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                            <AlertCircle size={24} />
                        </div>
                        <h3 className="text-xl font-semibold">Falha na publicação</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 rounded-xl p-4">
                            <h4 className="text-xs font-bold text-red-600 dark:text-red-400 uppercase tracking-wide mb-1">Mensagem de erro</h4>
                            <p className="text-sm text-red-800 dark:text-red-200 font-mono break-words">
                                {post.error_message || "Erro desconhecido"}
                            </p>
                        </div>

                        {post.failed_reason && (
                            <div>
                                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Motivo possível</h4>
                                <p className="text-sm text-gray-700 dark:text-gray-300">
                                    {post.failed_reason}
                                </p>
                            </div>
                        )}

                        <div className="text-xs text-gray-400 mt-2">
                            Sugestão: verifique a conexão do canal (Instagram/YouTube) ou o formato da mídia.
                        </div>
                    </div>

                    <div className="mt-4 flex flex-col gap-2">
                        {error && (
                            <p className="text-xs text-red-500 text-center">{error}</p>
                        )}
                        <IOSButton onClick={handleRetry} variant="primary" disabled={busy} className="w-full justify-center py-3">
                            <RotateCcw size={16} className="mr-2" /> Tentar novamente
                        </IOSButton>
                        <IOSButton onClick={onClose} variant="secondary" className="w-full justify-center py-3">
                            Fechar
                        </IOSButton>
                    </div>
                </div>
            </div>
        </div>
    );
}

interface SuccessModalProps {
    post: Post;
    onClose: () => void;
}

export function SuccessModal({ post, onClose }: SuccessModalProps) {
    // The IG oEmbed/Insights endpoints require an access token and don't allow
    // browser CORS. Fetching them client-side is broken AND leaks the token.
    // Preview is replaced with a deep link to the published post.
    const instagramPostUrl = post.instagram_media_id
        ? `https://www.instagram.com/p/${post.instagram_media_id}/`
        : null;

    // Deep link do Short publicado (youtube_video_id é salvo pelo publisher).
    const youtubeUrl = post.youtube_video_id
        ? `https://youtu.be/${post.youtube_video_id}`
        : null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
            <div className="bg-white dark:bg-zinc-900 w-full max-w-4xl max-h-[90vh] rounded-2xl overflow-hidden shadow-2xl flex flex-col md:flex-row">

                {/* Close Button Mobile */}
                <button onClick={onClose} className="absolute top-4 right-4 z-50 p-2 bg-black/50 rounded-full text-white md:hidden">
                    <X size={20} />
                </button>

                {/* Left: Preview/Embed */}
                <div className="w-full md:w-1/2 bg-black flex items-center justify-center overflow-y-auto p-4 custom-scrollbar">
                    <div className="text-white/50 text-center space-y-3">
                        <p>Prévia indisponível no app</p>
                        {youtubeUrl ? (
                            <a href={youtubeUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline text-sm block">
                                Ver no YouTube
                            </a>
                        ) : instagramPostUrl ? (
                            <a href={instagramPostUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline text-sm block">
                                Ver no Instagram
                            </a>
                        ) : post.video_url ? (
                            <a href={post.video_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline text-sm block">
                                Abrir mídia
                            </a>
                        ) : null}
                    </div>
                </div>

                {/* Right: Insights */}
                <div className="w-full md:w-1/2 p-6 flex flex-col bg-ios-background">
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-2xl font-bold text-ios-text">Detalhes da publicação</h3>
                        <button onClick={onClose} className="hidden md:block p-2 hover:bg-black/5 rounded-full transition-colors text-ios-secondary">
                            <X size={24} />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                        </div>
                        <div className="text-center py-10 text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
                            Métricas ainda não disponíveis.
                        </div>
                    </div>

                    <div className="mt-6 pt-4 border-t border-ios-separator">
                        <p className="text-xs text-center text-gray-400">
                            Publicado em {new Date(post.scheduled_at).toLocaleDateString()} às {new Date(post.scheduled_at).toLocaleTimeString()}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
