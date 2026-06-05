'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { X, CheckCircle2, XCircle, Clock, CalendarClock } from 'lucide-react'

import CalendarHeader from '@/components/Calendar/CalendarHeader'
import MonthView from '@/components/Calendar/MonthView'
import WeekView from '@/components/Calendar/WeekView'
import { Post } from '@/app/types'
import { useRouter } from 'next/navigation'
import { ErrorModal, SuccessModal } from '@/components/Calendar/PostStatusModals';
import DayDetailsModal from '@/components/Calendar/DayDetailsModal';

type FilterStatus = 'all' | 'published' | 'failed' | 'pending';

interface Planner { id: string; name: string; }

function toApiDate(date: Date) {
  return date.toISOString();
}

function getFetchWindow(currentDate: Date, viewMode: 'month' | 'week') {
  const today = new Date();
  let start: Date;
  let end: Date;

  if (viewMode === 'month') {
    start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    start.setDate(start.getDate() - 7);
    end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59, 999);
    end.setDate(end.getDate() + 14);
  } else {
    start = new Date(currentDate);
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 14);
    end.setHours(23, 59, 59, 999);
  }

  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);
  const upcomingEnd = new Date(today);
  upcomingEnd.setDate(upcomingEnd.getDate() + 30);
  upcomingEnd.setHours(23, 59, 59, 999);

  return {
    start: new Date(Math.min(start.getTime(), todayStart.getTime())),
    end: new Date(Math.max(end.getTime(), upcomingEnd.getTime())),
  };
}

export default function CalendarPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [planners, setPlanners] = useState<Planner[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<'month' | 'week'>('month');
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [filterPlannerId, setFilterPlannerId] = useState<string>('all');

  const router = useRouter();

  const fetchPosts = useCallback(async () => {
    setLoading(true);
    try {
      const { start, end } = getFetchWindow(currentDate, viewMode);
      const postsParams = new URLSearchParams({
        start: toApiDate(start),
        end: toApiDate(end),
        limit: '1000',
      });
      const postsRes = await fetch(`/api/posts?${postsParams.toString()}`);
      const postsData = await postsRes.json();

      if (Array.isArray(postsData)) setPosts(postsData);
    } catch (err) {
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  }, [currentDate, viewMode]);

  useEffect(() => {
    fetchPosts();
  }, [fetchPosts]);

  useEffect(() => {
    (async () => {
      try {
        const plannersRes = await fetch('/api/planners');
        const plannersData = await plannersRes.json();

        if (Array.isArray(plannersData)) setPlanners(plannersData);
      } catch (err) {
        console.error('Error fetching metadata:', err);
      }
    })();
  }, []);

  const handlePrev = () => {
    const newDate = new Date(currentDate);
    if (viewMode === 'month') {
      newDate.setMonth(currentDate.getMonth() - 1);
    } else {
      newDate.setDate(currentDate.getDate() - 7);
    }
    setCurrentDate(newDate);
  };

  const handleNext = () => {
    const newDate = new Date(currentDate);
    if (viewMode === 'month') {
      newDate.setMonth(currentDate.getMonth() + 1);
    } else {
      newDate.setDate(currentDate.getDate() + 7);
    }
    setCurrentDate(newDate);
  };

  const handleToday = () => {
    setCurrentDate(new Date());
  }

  // Apply filters
  const filteredPosts = useMemo(() => {
    return posts.filter(p => {
      if (filterStatus !== 'all') {
        if (filterStatus === 'pending') {
          if (p.status === 'published' || p.status === 'failed') return false;
        } else {
          if (p.status !== filterStatus) return false;
        }
      }
      if (filterPlannerId !== 'all' && p.planner_id !== filterPlannerId) return false;
      return true;
    });
  }, [posts, filterStatus, filterPlannerId]);

  const filterActive = filterStatus !== 'all' || filterPlannerId !== 'all';

  const statusOptions: { value: FilterStatus; label: string; color: string }[] = [
    { value: 'all', label: 'All', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
    { value: 'published', label: 'Published', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
    { value: 'failed', label: 'Failed', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
    { value: 'pending', label: 'Pending / Scheduled', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  ];

  return (
    <div className="flex flex-col h-full bg-ios-background relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-50/50 via-blue-50/30 to-purple-50/50 dark:from-indigo-950/20 dark:via-blue-950/10 dark:to-purple-950/20 pointer-events-none" />

      <CalendarHeader
        currentDate={currentDate}
        viewMode={viewMode}
        onViewChange={setViewMode}
        onPrev={handlePrev}
        onNext={handleNext}
        onToday={handleToday}
        onNewPost={() => router.push('/new')}
        onFilterToggle={() => setShowFilters(v => !v)}
        filterActive={filterActive}
      />

      {/* Filter Panel */}
      {showFilters && (
        <div className="relative z-10 border-b border-ios-separator bg-ios-card/70 backdrop-blur-md px-6 py-4 animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-ios-text">Filters</h3>
            <div className="flex items-center gap-3">
              {filterActive && (
                <button
                  onClick={() => { setFilterStatus('all'); setFilterPlannerId('all'); }}
                  className="text-xs text-ios-blue hover:underline"
                >
                  Clear all
                </button>
              )}
              <button onClick={() => setShowFilters(false)} title="Close filters" className="text-ios-secondary hover:text-ios-text transition-colors">
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
            {/* Status filter */}
            <div className="flex-1">
              <p className="text-[11px] font-bold uppercase tracking-wide text-ios-secondary mb-2">Status</p>
              <div className="flex flex-wrap gap-2">
                {statusOptions.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setFilterStatus(opt.value)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${filterStatus === opt.value
                      ? `${opt.color} ring-2 ring-offset-1 ring-ios-blue/40 border-transparent`
                      : 'border-ios-separator text-ios-secondary hover:border-ios-blue/40'
                      }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Planner filter */}
            {planners.length > 0 && (
              <div className="flex-1">
                <p className="text-[11px] font-bold uppercase tracking-wide text-ios-secondary mb-2">Planner</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setFilterPlannerId('all')}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${filterPlannerId === 'all'
                      ? 'bg-ios-blue/10 text-ios-blue ring-2 ring-offset-1 ring-ios-blue/40 border-transparent'
                      : 'border-ios-separator text-ios-secondary hover:border-ios-blue/40'
                      }`}
                  >
                    All planners
                  </button>
                  {planners.map(pl => (
                    <button
                      key={pl.id}
                      onClick={() => setFilterPlannerId(pl.id)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-all border ${filterPlannerId === pl.id
                        ? 'bg-ios-blue/10 text-ios-blue ring-2 ring-offset-1 ring-ios-blue/40 border-transparent'
                        : 'border-ios-separator text-ios-secondary hover:border-ios-blue/40'
                        }`}
                    >
                      {pl.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {filterActive && (
            <p className="text-[11px] text-ios-secondary mt-3">
              Showing {filteredPosts.length} of {posts.length} posts
            </p>
          )}
        </div>
      )}

      {/* Today's Summary Bar */}
      {(() => {
        const today = new Date();
        const todayPosts = posts.filter(p => {
          if (!p.scheduled_at) return false;
          const d = new Date(p.scheduled_at);
          return d.toDateString() === today.toDateString();
        });
        const todayPublished = todayPosts.filter(p => p.status === 'published').length;
        const todayFailed = todayPosts.filter(p => p.status === 'failed').length;
        const todayScheduled = todayPosts.filter(p => !['published', 'failed'].includes(p.status)).length;
        if (todayPosts.length === 0) return null;
        return (
          <div className="relative z-10 bg-ios-card/60 backdrop-blur-md border-b border-ios-separator px-5 py-2.5 flex items-center gap-6 text-[13px]">
            <span className="text-ios-text-secondary font-semibold">Today</span>
            <span className="flex items-center gap-1.5 text-ios-green font-medium">
              <CheckCircle2 size={13} />{todayPublished} published
            </span>
            {todayFailed > 0 && (
              <span className="flex items-center gap-1.5 text-ios-red font-medium">
                <XCircle size={13} />{todayFailed} failed
              </span>
            )}
            <span className="flex items-center gap-1.5 text-ios-text-secondary">
              <Clock size={13} />{todayScheduled} scheduled
            </span>
          </div>
        );
      })()}

      {/* Upcoming Posts Strip */}
      {(() => {
        const upcoming = posts
          .filter(p => p.scheduled_at && !['published', 'failed'].includes(p.status) && new Date(p.scheduled_at) > new Date())
          .sort((a, b) => new Date(a.scheduled_at!).getTime() - new Date(b.scheduled_at!).getTime())
          .slice(0, 5);
        if (upcoming.length === 0) return null;
        return (
          <div className="relative z-10 px-4 py-2 border-b border-ios-separator bg-ios-background/50">
            <div className="flex items-center gap-2 mb-1.5">
              <CalendarClock size={12} className="text-ios-text-secondary" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ios-text-secondary">Upcoming</span>
            </div>
            <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
              {upcoming.map(p => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPost(p)}
                  className="flex-shrink-0 bg-ios-card border border-ios-separator rounded-xl px-3 py-2 text-left hover:bg-ios-blue/5 transition-colors"
                >
                  <p className="text-[11px] font-semibold text-ios-blue">
                    {new Date(p.scheduled_at!).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                  <p className="text-[11px] text-ios-text truncate max-w-[160px] mt-0.5">{p.caption?.slice(0, 50) || 'No caption'}</p>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      <div className="flex-1 overflow-auto px-4 pb-10 pt-2 z-10 scrollbar-hide">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
          </div>
        ) : (
          viewMode === 'month' ? (
            <MonthView
              currentDate={currentDate}
              posts={filteredPosts}
              onPostClick={setSelectedPost}
              onDayClick={setSelectedDay}
            />
          ) : (
            <WeekView
              currentDate={currentDate}
              posts={filteredPosts}
              onPostClick={setSelectedPost}
            />
          )
        )}
      </div>

      {/* Modals */}
      {selectedDay && (
        <DayDetailsModal
          date={selectedDay}
          posts={filteredPosts.filter(p => {
            if (!p.scheduled_at) return false;
            const d = new Date(p.scheduled_at);
            return d.getFullYear() === selectedDay.getFullYear() &&
              d.getMonth() === selectedDay.getMonth() &&
              d.getDate() === selectedDay.getDate();
          })}
          onClose={() => setSelectedDay(null)}
          onPostClick={(p) => {
            setSelectedPost(p);
          }}
        />
      )}

      {selectedPost && selectedPost.status === 'failed' && (
        <ErrorModal post={selectedPost} onClose={() => setSelectedPost(null)} />
      )}

      {selectedPost && selectedPost.status === 'published' && (
        <SuccessModal
          post={selectedPost}
          onClose={() => setSelectedPost(null)}
        />
      )}

    </div>
  );
}
