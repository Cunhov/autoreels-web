import React from 'react';
import { Post } from '@/app/types';

interface WeekViewProps {
    currentDate: Date;
    posts: Post[];
    onPostClick: (post: Post) => void;
    /** Called when a day cell is clicked (empty days → deep link to /new). */
    onDayClick?: (date: Date) => void;
}

export default function WeekView({ currentDate, posts, onPostClick, onDayClick }: WeekViewProps) {
    const getWeekDays = (date: Date) => {
        const days = [];
        const startOfWeek = new Date(date);
        // Adjust to start on Sunday (or Monday if preferred, sticking to Sunday as per MonthView)
        const day = startOfWeek.getDay();
        const diff = startOfWeek.getDate() - day; // adjust when day is sunday
        startOfWeek.setDate(diff);

        for (let i = 0; i < 7; i++) {
            const d = new Date(startOfWeek);
            d.setDate(startOfWeek.getDate() + i);
            days.push(d);
        }
        return days;
    };

    const days = getWeekDays(currentDate);

    const getPostsForDay = (date: Date) => {
        return posts.filter(p => {
            if (!p.scheduled_at) return false;
            const d = new Date(p.scheduled_at);
            return d.getFullYear() === date.getFullYear() &&
                d.getMonth() === date.getMonth() &&
                d.getDate() === date.getDate();
        });
    };

    const getBorderClass = (status: string) => {
        switch (status) {
            case 'failed': return 'border-red-500 ring-1 ring-red-500/50 shadow-red-500/10';
            case 'published': return 'border-green-500 ring-1 ring-green-500/50 shadow-green-500/10';
            default: return 'border-gray-400 dark:border-gray-600';
        }
    };

    const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    return (
        <div className="flex flex-col h-full animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="grid grid-cols-7 mb-3 px-1">
                {days.map((d, i) => {
                    const isToday = d.toDateString() === new Date().toDateString();
                    return (
                        <div key={i} className="text-center flex flex-col items-center gap-1 group cursor-pointer" onClick={() => onDayClick?.(d)}>
                            <span className="text-[11px] font-bold text-ios-secondary uppercase tracking-widest opacity-80">
                                {weekDays[d.getDay()]}
                            </span>
                            <span className={`text-[15px] font-medium w-9 h-9 flex items-center justify-center rounded-full transition-all
                    ${isToday ? 'bg-ios-blue text-white shadow-lg shadow-ios-blue/30 scale-110' : 'text-ios-text group-hover:bg-ios-gray-5'}`}>
                                {d.getDate()}
                            </span>
                        </div>
                    )
                })}
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="grid grid-cols-7 gap-px bg-ios-separator/50 border border-ios-separator/50 rounded-2xl overflow-hidden shadow-sm h-full min-h-[600px] ring-1 ring-black/5">
                    {days.map((date, i) => {
                        const dayPosts = getPostsForDay(date);
                        // NOTE: `new Date()` in render is safe here — WeekView renders
                        // only after the page's `loading` gate (no SSR => no hydration
                        // mismatch). If that gate is ever removed, compute today in state.
                        const isToday = date.toDateString() === new Date().toDateString();

                        return (
                            <div key={i} className={`h-full flex flex-col p-2 gap-3
                        ${isToday ? 'bg-ios-card' : 'bg-ios-background/40'} 
                        hover:bg-ios-card/80 transition-colors
                    `}>
                                {dayPosts.map(p => (
                                    <div
                                        key={p.id}
                                        onClick={(e) => { e.stopPropagation(); onPostClick(p); }}
                                        className={`group relative aspect-[9/16] w-full rounded-xl overflow-hidden border shadow-sm cursor-pointer hover:scale-[1.02] hover:shadow-md bg-black/5 transition-all
                                             ${getBorderClass(p.status)}
                                        `}
                                    >
                                        {/* Static preview — no <video> to save RAM/CPU.
                                            Mirrors the MonthView fallback: show the
                                            image/thumbnail when available, else a label. */}
                                        {p.image_url || p.thumbnail_url ? (
                                            <img
                                                src={p.image_url || p.thumbnail_url}
                                                className="w-full h-full object-cover opacity-90"
                                                alt="Post preview"
                                                loading="lazy"
                                                decoding="async"
                                            />
                                        ) : (
                                            <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                                                <div className="text-[9px] text-white/40 font-medium text-center">
                                                    {p.video_url ? 'Video' : 'No Media'}
                                                </div>
                                            </div>
                                        )}
                                        <div className="absolute top-2 right-2">
                                            <div className={`w-2.5 h-2.5 rounded-full border border-white/20 shadow-sm ${p.status === 'published' ? 'bg-ios-green' : p.status === 'failed' ? 'bg-red-500' : 'bg-gray-400'}`} />
                                        </div>
                                        <div className="absolute bottom-0 inset-x-0 p-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent backdrop-blur-[2px]">
                                            <p className="text-[10px] text-white/90 font-medium truncate text-center">
                                                {new Date(p.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                                {dayPosts.length === 0 && (
                                    <div className="flex-1 flex flex-col items-center justify-center opacity-30 gap-2">
                                        <div className="w-1 bg-ios-separator/50 h-full rounded-full"></div>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    );
}
