'use client'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { X, CheckCircle2, XCircle, Clock, CalendarClock } from 'lucide-react'

import CalendarHeader from '@/components/Calendar/CalendarHeader'
import MonthView from '@/components/Calendar/MonthView'
import WeekView from '@/components/Calendar/WeekView'
import { Post } from '@/app/types'
import { useRouter } from 'next/navigation'
import { ErrorModal, SuccessModal } from '@/components/Calendar/PostStatusModals';
import DayDetailsModal from '@/components/Calendar/DayDetailsModal';
import LocalPreviewModal from '@/components/Calendar/LocalPreviewModal';

type FilterStatus = 'all' | 'published' | 'failed' | 'pending';

interface Planner { id: string; name: string; }

function toApiDate(date: Date) {
  return date.toISOString();
}

/** Range of the visible calendar (month: first day ± padding; week: week start + 14d). */
function getVisibleRange(currentDate: Date, viewMode: 'month' | 'week') {
  if (viewMode === 'month') {
    const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    start.setDate(start.getDate() - 7);
    const end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59, 999);
    end.setDate(end.getDate() + 14);
    return { start, end };
  }
  const start = new Date(currentDate);
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 14);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/** Upcoming strip range: today → today+30d (fetched separately so past months stay lean). */
function getUpcomingRange() {
  const today = new Date();
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + 30);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/** Normalize the /api/calendar response into a Post[] (defensive: array or { posts: [...] }). */
function normalizeCalendarData(data: unknown): Post[] {
  if (Array.isArray(data)) return data as Post[];
  if (data && typeof data === 'object' && Array.isArray((data as { posts?: unknown }).posts)) {
    return (data as { posts: Post[] }).posts;
  }
  return [];
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

  const lastFetchRef = useRef(0);
  const postsRef = useRef<Post[]>([]);
  // Monotonic fetch sequence: guards against a stale response from a rapid
  // month navigation overwriting a newer window's data (critic finding: rapid
  // ArrowLeft/Right could apply an older window's response last).
  const fetchSeqRef = useRef(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // `today` is computed after mount so the Today bar / Upcoming strip never
  // render during SSR (avoids hydration mismatches from wall-clock reads).
  const [today, setToday] = useState<Date | null>(null);

  useEffect(() => {
    setToday(new Date());
  }, []);

  const fetchPosts = useCallback(async () => {
    const hasData = postsRef.current.length > 0;
    // Keep the current data visible on refetch — spinner only on the first load.
    setLoading(!hasData);
    lastFetchRef.current = Date.now();
    const seq = ++fetchSeqRef.current;
    try {
      // Two parallel, lean fetches: the visible month/week range and the
      // upcoming strip (today..+30d). Dedupe by id when they overlap.
      // limit=1000: the route's default cap is 500 — without an explicit limit,
      // windows with >500 posts silently drop the NEWEST ones (critic finding).
      const visible = getVisibleRange(currentDate, viewMode);
      const upcoming = getUpcomingRange();
      const visibleParams = new URLSearchParams({ start: toApiDate(visible.start), end: toApiDate(visible.end), limit: '1000' });
      const upcomingParams = new URLSearchParams({ start: toApiDate(upcoming.start), end: toApiDate(upcoming.end), limit: '1000' });
      const [visibleRes, upcomingRes] = await Promise.all([
        fetch(`/api/calendar?${visibleParams.toString()}`),
        fetch(`/api/calendar?${upcomingParams.toString()}`),
      ]);
      const [visibleData, upcomingData] = await Promise.all([visibleRes.json(), upcomingRes.json()]);

      if (!visibleRes.ok || !upcomingRes.ok) {
        throw new Error('Failed to load calendar data');
      }

      const merged = new Map<string, Post>();
      [...normalizeCalendarData(visibleData), ...normalizeCalendarData(upcomingData)].forEach(p => {
        if (p && p.id) merged.set(p.id, p);
      });
      const nextPosts = Array.from(merged.values());
      // Stale-response guard: a newer navigation may have started while this
      // fetch was in flight — its response must not overwrite the newer window.
      if (seq !== fetchSeqRef.current) return;
      postsRef.current = nextPosts;
      setPosts(nextPosts);
      setFetchError(null);
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      console.error('Error fetching data:', err);
      setFetchError('Falha ao carregar os dados do calendário.');
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [currentDate, viewMode]);

  useEffect(() => {
    fetchPosts();
  }, [fetchPosts]);

  // Refetch when the tab regains focus / visibility — posts published by the
  // cron (or by another tab) otherwise stay stale until a manual reload.
  useEffect(() => {
    const refetchIfStale = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastFetchRef.current > 10_000) {
        fetchPosts();
      }
    };
    document.addEventListener('visibilitychange', refetchIfStale);
    window.addEventListener('focus', refetchIfStale);
    return () => {
      document.removeEventListener('visibilitychange', refetchIfStale);
      window.removeEventListener('focus', refetchIfStale);
    };
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

  const handlePrev = useCallback(() => {
    if (viewMode === 'month') {
      // Navigate from the 1st of the month — fixes the day-31 month-skip rollover.
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    } else {
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() - 7));
    }
  }, [currentDate, viewMode]);

  const handleNext = useCallback(() => {
    if (viewMode === 'month') {
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
    } else {
      setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 7));
    }
  }, [currentDate, viewMode]);

  const handleToday = useCallback(() => {
    setCurrentDate(new Date());
  }, []);

  // Keyboard shortcuts: ←/→ change month, T jumps to today.
  // Ignored while typing in inputs/textarea/selects or contentEditable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNext();
      } else if (e.key.toLowerCase() === 't') {
        handleToday();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlePrev, handleNext, handleToday]);

  // Apply filters
  const filteredPosts = useMemo(() => {
    return posts.filter(p => {
      if (filterStatus !== 'all') {
        if (filterStatus === 'pending') {
          // 'pending' bucket: pending/scheduled/processing — excludes published,
          // failed AND cancelled (cancelled is a terminal state, not an active one).
          if (['published', 'failed', 'cancelled'].includes(p.status)) return false;
        } else {
          if (p.status !== filterStatus) return false;
        }
      }
      if (filterPlannerId !== 'all' && p.planner_id !== filterPlannerId) return false;
      return true;
    });
  }, [posts, filterStatus, filterPlannerId]);

  // Click on a day cell: empty day → deep link to /new with a pre-filled time;
  // day with posts → open the DayDetailsModal.
  const handleDayClick = useCallback((date: Date) => {
    const dayPosts = filteredPosts.filter(p => {
      if (!p.scheduled_at) return false;
      const d = new Date(p.scheduled_at);
      return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() && d.getDate() === date.getDate();
    });
    if (dayPosts.length === 0) {
      const pad = (n: number) => String(n).padStart(2, '0');
      router.push(`/new?scheduled_at=${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T12:00`);
    } else {
      setSelectedDay(date);
    }
  }, [filteredPosts, router]);

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

      {/* Today's Summary Bar — gated on `today` (set after mount) to avoid SSR
          wall-clock reads that would cause hydration mismatches. */}
      {today && (() => {
        const todayPosts = posts.filter(p => {
          if (!p.scheduled_at) return false;
          const d = new Date(p.scheduled_at);
          return d.toDateString() === today.toDateString();
        });
        const todayPublished = todayPosts.filter(p => p.status === 'published').length;
        const todayFailed = todayPosts.filter(p => p.status === 'failed').length;
        const todayScheduled = todayPosts.filter(p => !['published', 'failed', 'cancelled'].includes(p.status)).length;
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

      {/* Upcoming Posts Strip — gated on `today` (see comment above). */}
      {today && (() => {
        const upcoming = posts
          .filter(p => p.scheduled_at && !['published', 'failed', 'cancelled'].includes(p.status) && new Date(p.scheduled_at) > today)
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

      {/* Fetch error banner with retry */}
      {fetchError && (
        <div className="relative z-10 px-4 py-2 border-b border-ios-separator bg-red-50 dark:bg-red-950/30 flex items-center justify-between gap-3">
          <p className="text-xs text-ios-red">{fetchError}</p>
          <button onClick={fetchPosts} className="text-xs font-semibold text-ios-blue hover:underline shrink-0">
            Tentar novamente
          </button>
        </div>
      )}

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
              onDayClick={handleDayClick}
            />
          ) : (
            <WeekView
              currentDate={currentDate}
              posts={filteredPosts}
              onPostClick={setSelectedPost}
              onDayClick={handleDayClick}
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
          onPostsChanged={() => fetchPosts()}
        />
      )}

      {selectedPost && selectedPost.status === 'failed' && (
        <ErrorModal
          post={selectedPost}
          onClose={() => setSelectedPost(null)}
          onPostsChanged={() => fetchPosts()}
        />
      )}

      {selectedPost && selectedPost.status === 'published' && (
        <SuccessModal
          post={selectedPost}
          onClose={() => setSelectedPost(null)}
        />
      )}

      {/* Dead-click fix: pending/scheduled/processing posts open a local preview. */}
      {selectedPost && !['failed', 'published'].includes(selectedPost.status) && (
        <LocalPreviewModal
          post={selectedPost}
          onClose={() => setSelectedPost(null)}
        />
      )}

    </div>
  );
}
