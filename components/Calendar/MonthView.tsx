import MediaThumbnail from '@/components/MediaThumbnail';
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
            const d = new Date(p.scheduled_at ?? '');
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

    const weekDays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

    return (
        <div className="flex flex-col h-full animate-in fade-in zoom-in-95 duration-300">
            <div className="grid grid-cols-7 mb-3 px-1" style={{gridTemplateColumns:"repeat(7, minmax(0, 1fr))"}}>
                {weekDays.map(d => (
                    <div key={d} className="text-center text-[11px] font-bold text-ios-secondary uppercase tracking-widest opacity-80">
                        {d}
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-7 gap-px bg-ios-separator/50 border border-ios-separator/50 rounded-2xl overflow-hidden shadow-sm ring-1 ring-black/5" style={{gridTemplateColumns:"repeat(7, minmax(0, 1fr))"}}>
                {days.map((item, i) => {
                    const dayPosts = item.date ? getPostsForDay(item.date) : [];
                    // NOTE: `new Date()` in render is safe here — MonthView is only
                    // rendered after the page's `loading` gate, so it never runs during
                    // SSR (no hydration mismatch). If that gate is ever removed, move
                    // this into a state set in useEffect.
                    const isToday = item.date && item.date.toDateString() === new Date().toDateString();

                    return (
                        <div
                            key={i}
                            onClick={() => item.date && onDayClick(item.date)}
                            className={`min-h-[58px] sm:min-h-[90px] md:min-h-[140px] min-w-0 p-0.5 sm:p-1.5 md:p-2 flex flex-col gap-1 sm:gap-2 transition-colors relative group cursor-pointer
                ${item.current ? 'bg-ios-card hover:bg-ios-gray-6/50' : 'bg-ios-background/60 hover:bg-ios-background/80'}
              `}
                        >
                            <div className="flex justify-between items-start z-10">
                                <span className={`text-[11px] sm:text-[13px] font-medium w-5 h-5 sm:w-7 sm:h-7 flex items-center justify-center rounded-full transition-all
                  ${isToday
                                        ? 'bg-ios-blue text-white shadow-md shadow-ios-blue/30 scale-110'
                                        : item.current ? 'text-ios-text' : 'text-ios-text-secondary/40'
                                    }`}>
                                    {item.day}
                                </span>
                                {/* Count badge — derived from the already-fetched posts */}
                                {dayPosts.length > 0 && (
                                    <span className="text-[8px] sm:text-[9px] font-bold text-ios-blue bg-ios-blue/10 border border-ios-blue/20 rounded-full px-1 sm:px-1.5 py-0.5 min-w-[15px] text-center leading-tight">
                                        {dayPosts.length}
                                    </span>
                                )}
                            </div>

                            <div className="flex-1 space-y-1 sm:space-y-1.5 overflow-hidden">
                                {dayPosts.slice(0, 2).map(p => (
                                    <button key={`compact-${p.id}`} type="button" onClick={(e) => { e.stopPropagation(); onPostClick(p); }} className="sm:hidden w-full flex items-center gap-1 text-[8px] leading-tight text-ios-text-secondary min-w-0 text-left">
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.status === 'published' ? 'bg-ios-green' : p.status === 'failed' ? 'bg-red-500' : 'bg-ios-blue'}`} />
                                        <span className="truncate">{new Date(p.scheduled_at ?? '').toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                    </button>
                                ))}
                                {dayPosts.slice(0, 3).map(p => (
                                    <div
                                        key={p.id}
                                        onClick={(e) => { e.stopPropagation(); onPostClick(p); }}
                                        className={`hidden sm:block group/item relative aspect-square rounded-lg overflow-hidden border shadow-sm cursor-pointer hover:scale-[1.02] hover:z-20 bg-black/5 transition-all min-w-0
                                            ${getBorderClass(p.status)}
                                        `}
                                    >
                                        <MediaThumbnail src={p.image_url || p.thumbnail_url} alt="Prévia do post" video={Boolean(p.video_url)} className="opacity-90 group-hover/item:opacity-100 transition-opacity" />

                                        <div className="absolute top-1 right-1">
                                            <div className={`w-2 h-2 rounded-full border border-white/20 shadow-sm ${p.status === 'published' ? 'bg-ios-green' : p.status === 'failed' ? 'bg-red-500' : 'bg-gray-400'}`} />
                                        </div>
                                        <div className="absolute bottom-0 inset-x-0 p-1 bg-black/30 backdrop-blur-md">
                                            <p className="text-[9px] text-white font-medium truncate text-center">
                                                {new Date(p.scheduled_at ?? '').toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false })}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                                {dayPosts.length > 2 && (
                                    <div
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (item.date) onDayClick(item.date);
                                        }}
                                        className="text-[8px] sm:text-[10px] text-center font-bold text-ios-blue bg-ios-blue/10 rounded-full py-0.5 mt-0.5 hover:bg-ios-blue/20 transition-colors"
                                    >
                                        <span className="sm:hidden">+{dayPosts.length - 2}</span><span className="hidden sm:inline">{dayPosts.length > 3 ? `+${dayPosts.length - 3} mais` : ''}</span>
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
