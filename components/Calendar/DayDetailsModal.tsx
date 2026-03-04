'use client';
import { useState } from 'react';
import { X, Calendar as CalendarIcon, Clock, Video, Image, AlertCircle, Play } from 'lucide-react';
import { Post } from '@/app/types';
import IOSButton from '@/components/IOSButton';

interface DayDetailsModalProps {
    date: Date;
    posts: Post[];
    onClose: () => void;
    onPostClick: (post: Post) => void;
}

/** Full-screen local preview for scheduled/pending posts (not yet on Instagram) */
function LocalPreviewModal({ post, onClose }: { post: Post; onClose: () => void }) {
    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-md animate-in fade-in duration-200">
            <button
                onClick={onClose}
                className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors z-10"
                title="Close preview"
            >
                <X size={22} />
            </button>

            <div className="w-full max-w-md flex flex-col items-center gap-4 p-4">
                {/* Media */}
                <div className="w-full aspect-[9/16] max-h-[70vh] bg-black rounded-2xl overflow-hidden shadow-2xl flex items-center justify-center">
                    {post.video_url ? (
                        <video
                            src={post.video_url}
                            className="w-full h-full object-contain"
                            controls
                            autoPlay
                            playsInline
                        />
                    ) : post.image_url || post.thumbnail_url ? (
                        <img
                            src={post.image_url || post.thumbnail_url}
                            className="w-full h-full object-contain"
                            alt="Post preview"
                        />
                    ) : (
                        <div className="text-white/50 text-sm">No media available</div>
                    )}
                </div>

                {/* Info */}
                <div className="bg-white/10 rounded-xl p-4 w-full text-white space-y-2">
                    <div className="flex items-center gap-2 text-xs text-white/60">
                        <Clock size={12} />
                        Scheduled for {new Date(post.scheduled_at).toLocaleString()}
                    </div>
                    {post.caption && (
                        <p className="text-sm leading-relaxed text-white/90 line-clamp-4">{post.caption}</p>
                    )}
                    <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide
                        ${post.status === 'published' ? 'bg-green-500/30 text-green-300' :
                            post.status === 'failed' ? 'bg-red-500/30 text-red-300' :
                                'bg-gray-500/30 text-gray-300'}`}>
                        {post.status.replace('_', ' ')}
                    </span>
                </div>
            </div>
        </div>
    );
}

export default function DayDetailsModal({ date, posts, onClose, onPostClick }: DayDetailsModalProps) {
    const [previewPost, setPreviewPost] = useState<Post | null>(null);

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
                            posts.map(post => (
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
                                </div>
                            ))
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
        </>
    );
}
