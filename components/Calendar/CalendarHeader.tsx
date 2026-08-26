import React from 'react';
import { ChevronLeft, ChevronRight, Plus, Filter, Calendar as CalendarIcon } from 'lucide-react';
import IOSButton from '@/components/IOSButton';

interface CalendarHeaderProps {
    currentDate: Date;
    viewMode: 'month' | 'week';
    onViewChange: (mode: 'month' | 'week') => void;
    onPrev: () => void;
    onNext: () => void;
    onToday: () => void;
    onNewPost: () => void;
    onFilterToggle?: () => void;
    filterActive?: boolean;
}

export default function CalendarHeader({
    currentDate,
    viewMode,
    onViewChange,
    onPrev,
    onNext,
    onToday,
    onNewPost,
    onFilterToggle,
    filterActive,
}: CalendarHeaderProps) {
    const monthName = currentDate.toLocaleString('pt-BR', { month: 'long' });
    const year = currentDate.getFullYear();

    return (
        <header className="px-4 sm:px-6 py-3 sm:py-4 sticky top-0 z-20 bg-ios-background/90 backdrop-blur-xl border-b border-ios-separator/50 transition-all duration-300">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3 sm:mb-4">
                <h1 className="text-[24px] sm:text-[34px] font-bold text-ios-text tracking-tight leading-tight">Calendário</h1>
                <div className="flex flex-wrap gap-2 sm:gap-3">
                    <button
                        aria-label="Toggle filters"
                        title="Filter"
                        onClick={onFilterToggle}
                        className={`p-2 sm:p-2.5 rounded-xl shadow-sm transition-colors ${filterActive ? 'bg-ios-blue/15 ring-1 ring-ios-blue/30 text-ios-blue' : 'bg-ios-card/80 hover:bg-ios-card text-ios-blue'}`}
                    >
                        <Filter size={20} />
                    </button>
                    <IOSButton
                        variant="primary"
                        className="!py-2.5 !px-5 shadow-md shadow-ios-blue/20 transition-transform active:scale-95"
                        onClick={onNewPost}
                    >
                        <Plus size={20} className="inline mr-1.5" />
                        Agendar post
                    </IOSButton>
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 gap-y-3">
                <div className="bg-ios-gray-5/50 p-1 rounded-lg flex gap-0.5 backdrop-blur-sm shrink-0">
                    <button
                        onClick={() => onViewChange('week')}
                        className={`px-3 sm:px-4 py-1.5 text-[12px] sm:text-[13px] font-medium rounded-md transition-all duration-300 ${viewMode === 'week'
                            ? 'bg-ios-card text-ios-text shadow-sm'
                            : 'text-ios-text-secondary hover:text-ios-text'
                            }`}
                    >
                        Semana
                    </button>
                    <button
                        onClick={() => onViewChange('month')}
                        className={`px-3 sm:px-4 py-1.5 text-[12px] sm:text-[13px] font-medium rounded-md transition-all duration-300 ${viewMode === 'month'
                            ? 'bg-ios-card text-ios-text shadow-sm'
                            : 'text-ios-text-secondary hover:text-ios-text'
                            }`}
                    >
                        Mês
                    </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {/* Explicit Today button (the month title also navigates home) */}
                    <button
                        onClick={onToday}
                        className="text-xs font-semibold text-ios-blue bg-ios-blue/10 hover:bg-ios-blue/20 rounded-full px-3 py-1.5 transition-colors active:scale-95"
                    >
                        Hoje
                    </button>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={onPrev}
                            className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-full transition-colors active:scale-90"
                        >
                            <ChevronLeft size={24} />
                        </button>
                        <h2 className="text-base sm:text-xl font-semibold min-w-[120px] sm:min-w-[160px] text-center tabular-nums cursor-pointer hover:opacity-70 transition-opacity" onClick={onToday}>
                            {monthName} <span className="text-ios-text-secondary">{year}</span>
                        </h2>
                        <button
                            onClick={onNext}
                            className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-full transition-colors active:scale-90"
                        >
                            <ChevronRight size={24} />
                        </button>
                    </div>
                </div>
            </div>
        </header>
    );
}
