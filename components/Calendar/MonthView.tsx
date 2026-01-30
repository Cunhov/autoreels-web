import React from 'react';
import { Post } from '@/app/types';

interface MonthViewProps {
    currentDate: Date;
    posts: Post[];
    onPostClick: (post: Post) => void;
}

export default function MonthView({ currentDate, posts, onPostClick, onDayClick }: MonthViewProps & { onDayClick: (date: Date) => void }) {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
    const firstDayOfMonth = (y: number, m: number) => new Date(y, m, 1).getDay();

    const prevMonthDays = daysInMonth(year, month - 1);
    const startDay = firstDayOfMonth(year, month);
    const totalDays = daysInMonth(year, month);

    const days = [];

    // Padding for previous month
    for (let i = startDay - 1; i >= 0; i--) {
        days.push({ day: prevMonthDays - i, current: false, date: new Date(year, month - 1, prevMonthDays - i) });
    }

    // Days of current month
    for (let i = 1; i <= totalDays; i++) {
        days.push({ day: i, current: true, date: new Date(year, month, i) });
    }

    // Padding for next month
    const remaining = 35 - days.length; // 5 weeks grid
    const finalPadding = remaining > 0 ? remaining : (42 - days.length);

    for (let i = 1; i <= finalPadding; i++) {
        days.push({ day: i, current: false, date: new Date(year, month + 1, i) });
    }

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
        <div className="flex flex-col h-full animate-in fade-in zoom-in-95 duration-300">
            <div className="grid grid-cols-7 mb-3 px-1">
                {weekDays.map(d => (
                    <div key={d} className="text-center text-[11px] font-bold text-ios-secondary uppercase tracking-widest opacity-80">
                        {d}
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-7 gap-px bg-ios-separator/50 border border-ios-separator/50 rounded-2xl overflow-hidden shadow-sm ring-1 ring-black/5">
                {days.map((item, i) => {
                    const dayPosts = item.date ? getPostsForDay(item.date) : [];
                    const isToday = item.date && item.date.toDateString() === new Date().toDateString();

                    return (
                        <div
                            key={i}
                            onClick={() => item.date && onDayClick(item.date)}
                            className={`min-h-[140px] p-2 flex flex-col gap-2 transition-colors relative group cursor-pointer
                ${item.current ? 'bg-ios-card hover:bg-ios-gray-6/50' : 'bg-ios-background/60 hover:bg-ios-background/80'}
              `}
                        >
                            <div className="flex justify-between items-start z-10">
                                <span className={`text-[13px] font-medium w-7 h-7 flex items-center justify-center rounded-full transition-all
                  ${isToday
                                        ? 'bg-ios-blue text-white shadow-md shadow-ios-blue/30 scale-110'
                                        : item.current ? 'text-ios-text' : 'text-ios-text-secondary/40'
                                    }`}>
                                    {item.day}
                                </span>
                            </div>

                            <div className="flex-1 space-y-1.5 overflow-hidden">
                                {dayPosts.slice(0, 3).map(p => (
                                    <div
                                        key={p.id}
                                        onClick={(e) => { e.stopPropagation(); onPostClick(p); }}
                                        className={`group/item relative aspect-[4/5] rounded-lg overflow-hidden border shadow-sm cursor-pointer hover:scale-[1.02] hover:z-20 bg-black/5 transition-all
                                            ${getBorderClass(p.status)}
                                        `}
                                    >
                                        {p.video_url || p.thumbnail_url ? (
                                            <video
                                                src={p.video_url || p.thumbnail_url}
                                                className="w-full h-full object-cover opacity-90 group-hover/item:opacity-100 transition-opacity"
                                                muted
                                                playsInline
                                                onMouseOver={e => e.currentTarget.play().catch(() => { })}
                                                onMouseOut={e => {
                                                    e.currentTarget.pause();
                                                    e.currentTarget.currentTime = 0;
                                                }}
                                            />
                                        ) : (
                                            <div className="w-full h-full bg-ios-gray-5 flex items-center justify-center text-[10px] text-ios-secondary">No Media</div>
                                        )}

                                        <div className="absolute top-1 right-1">
                                            <div className={`w-2 h-2 rounded-full border border-white/20 shadow-sm ${p.status === 'published' ? 'bg-ios-green' : p.status === 'failed' ? 'bg-red-500' : 'bg-gray-400'}`} />
                                        </div>
                                        <div className="absolute bottom-0 inset-x-0 p-1 bg-black/30 backdrop-blur-md">
                                            <p className="text-[9px] text-white font-medium truncate text-center">
                                                {new Date(p.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                                {dayPosts.length > 3 && (
                                    <div
                                        onClick={(e) => { e.stopPropagation(); item.date && onDayClick(item.date); }}
                                        className="text-[10px] text-center font-bold text-ios-blue bg-ios-blue/10 rounded-full py-0.5 mt-1 hover:bg-ios-blue/20 transition-colors"
                                    >
                                        +{dayPosts.length - 3} more
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
