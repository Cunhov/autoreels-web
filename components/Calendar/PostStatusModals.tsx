'use client';
import { useState, useEffect } from 'react';
import { X, AlertCircle } from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import { Post } from '@/app/types';

interface ErrorModalProps {
    post: Post;
    onClose: () => void;
}

export function ErrorModal({ post, onClose }: ErrorModalProps) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-zinc-900 w-full max-w-md rounded-2xl overflow-hidden shadow-2xl scale-100 animate-in zoom-in-95 duration-200">
                <div className="p-6">
                    <div className="flex items-center gap-3 mb-4 text-red-500">
                        <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                            <AlertCircle size={24} />
                        </div>
                        <h3 className="text-xl font-semibold">Post Failed</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 rounded-xl p-4">
                            <h4 className="text-xs font-bold text-red-600 dark:text-red-400 uppercase tracking-wide mb-1">Error Message</h4>
                            <p className="text-sm text-red-800 dark:text-red-200 font-mono break-words">
                                {post.error_message || "Unknown error occurred"}
                            </p>
                        </div>

                        {post.failed_reason && (
                            <div>
                                <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Possible Reason</h4>
                                <p className="text-sm text-gray-700 dark:text-gray-300">
                                    {post.failed_reason}
                                </p>
                            </div>
                        )}

                        <div className="text-xs text-gray-400 mt-2">
                            Suggestion: Check your Instagram connection or media format.
                        </div>
                    </div>

                    <div className="mt-8">
                        <IOSButton onClick={onClose} variant="secondary" className="w-full justify-center py-3">
                            Close
                        </IOSButton>
                    </div>
                </div>
            </div>
        </div>
    );
}

interface SuccessModalProps {
    post: Post;
    accessToken?: string; // We might need this, or we handle it inside
    onClose: () => void;
}

export function SuccessModal({ post, accessToken, onClose }: SuccessModalProps) {
    const [html, setHtml] = useState<string | null>(null);
    const [insights, setInsights] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (post.video_url || post.instagram_media_id) {
            loadData();
        }
    }, [post]);

    async function loadData() {
        setLoading(true);
        try {
            // Using server actions provided later, or direct fetch if we have token
            // construct fetching here
            const oEmbedUrl = `https://graph.facebook.com/v24.0/instagram_oembed?url=${encodeURIComponent(post.video_url)}&access_token=${accessToken}&omitscript=true`;

            // Note: In real app, we should use a proxy to avoid exposing token if it's a client token
            // But here we might be using the value passed from parent.
            if (accessToken && post.video_url) {
                // Fetch oEmbed
                try {
                    const res = await fetch(oEmbedUrl);
                    const data = await res.json();
                    if (data.html) setHtml(data.html);
                } catch (e) {
                    console.error("oEmbed error", e);
                }
            }

            // Fetch Insights
            if (accessToken && post.instagram_media_id) {
                const metrics = 'engagement,impressions,reach,likes,comments,total_interactions';
                const insightsUrl = `https://graph.facebook.com/v24.0/${post.instagram_media_id}/insights?metric=${metrics}&access_token=${accessToken}`;
                try {
                    const res = await fetch(insightsUrl);
                    const data = await res.json();
                    if (data.data) setInsights(data.data);
                } catch (e) {
                    console.error("Insights error", e);
                }
            }

        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
            // Process instagram embed script
            if ((window as any).instgrm) {
                (window as any).instgrm.Embeds.process();
            } else {
                const script = document.createElement('script');
                script.src = "//www.instagram.com/embed.js";
                script.async = true;
                document.body.appendChild(script);
            }
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
            <div className="bg-white dark:bg-zinc-900 w-full max-w-4xl max-h-[90vh] rounded-2xl overflow-hidden shadow-2xl flex flex-col md:flex-row">

                {/* Close Button Mobile */}
                <button onClick={onClose} className="absolute top-4 right-4 z-50 p-2 bg-black/50 rounded-full text-white md:hidden">
                    <X size={20} />
                </button>

                {/* Left: Preview/Embed */}
                <div className="w-full md:w-1/2 bg-black flex items-center justify-center overflow-y-auto p-4 custom-scrollbar">
                    {loading ? (
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
                    ) : html ? (
                        <div dangerouslySetInnerHTML={{ __html: html }} className="flex justify-center w-full" />
                    ) : (
                        <div className="text-white/50 text-center">
                            <p>Preview unavailable</p>
                            <a href={post.video_url} target="_blank" className="text-blue-400 underline text-sm">Open in Instagram</a>
                        </div>
                    )}
                </div>

                {/* Right: Insights */}
                <div className="w-full md:w-1/2 p-6 flex flex-col bg-ios-background">
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-2xl font-bold text-ios-text">Post Insights</h3>
                        <button onClick={onClose} className="hidden md:block p-2 hover:bg-black/5 rounded-full transition-colors text-ios-secondary">
                            <X size={24} />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            {insights.map((metric: any) => (
                                <div key={metric.name} className="bg-ios-card p-4 rounded-xl border border-ios-separator shadow-sm">
                                    <div className="text-xs text-ios-secondary uppercase font-bold tracking-wider mb-1">
                                        {metric.title}
                                    </div>
                                    <div className="text-2xl font-bold text-ios-text">
                                        {metric.values[0].value}
                                    </div>
                                    <div className="text-[10px] text-gray-400 mt-1">
                                        {metric.description}
                                    </div>
                                </div>
                            ))}
                        </div>
                        {insights.length === 0 && !loading && (
                            <div className="text-center py-10 text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
                                No insights available yet.
                            </div>
                        )}
                    </div>

                    <div className="mt-6 pt-4 border-t border-ios-separator">
                        <p className="text-xs text-center text-gray-400">
                            Posted on {new Date(post.scheduled_at).toLocaleDateString()} at {new Date(post.scheduled_at).toLocaleTimeString()}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
