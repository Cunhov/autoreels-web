'use client';
import { X, Clock, CalendarClock } from 'lucide-react';
import { Post } from '@/app/types';

/**
 * Full-screen local preview for scheduled/pending posts (not yet on Instagram).
 * Extracted from DayDetailsModal so the calendar page can reuse it for the
 * "dead click" fix (pending/scheduled posts now open this preview).
 */
export default function LocalPreviewModal({ post, onClose }: { post: Post; onClose: () => void }) {
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
                    {/* Planner attribution: which planner created this post (hidden when none). */}
                    {post.planner?.name && (
                        <div className="flex items-center gap-2 text-xs text-white/60">
                            <CalendarClock size={12} />
                            <span className="font-medium text-white/90">{post.planner.name}</span>
                        </div>
                    )}
                    {post.scheduled_at && (
                        <div className="flex items-center gap-2 text-xs text-white/60">
                            <Clock size={12} />
                            Scheduled for {new Date(post.scheduled_at).toLocaleString()}
                        </div>
                    )}
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
