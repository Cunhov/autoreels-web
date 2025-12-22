'use client'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import CalendarHeader from '@/components/Calendar/CalendarHeader'
import MonthView from '@/components/Calendar/MonthView'
import WeekView from '@/components/Calendar/WeekView'
import { Post } from '@/app/types'
import { useRouter } from 'next/navigation'
import { ErrorModal, SuccessModal } from '@/components/Calendar/PostStatusModals';

export default function CalendarPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<'month' | 'week'>('month');
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    setLoading(true);
    const [postsRes, channelsRes] = await Promise.all([
      supabase.from('posts').select('*'),
      supabase.from('channels').select('*')
    ]);

    if (postsRes.data) setPosts(postsRes.data as Post[]);
    if (channelsRes.data) setChannels(channelsRes.data);
    setLoading(false);
  }

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

  const getChannelToken = (channelId: string) => {
    return channels.find(c => c.id === channelId)?.access_token;
  };

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
      />

      <div className="flex-1 overflow-auto px-4 pb-10 pt-2 z-10 scrollbar-hide">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
          </div>
        ) : (
          viewMode === 'month' ? (
            <MonthView
              currentDate={currentDate}
              posts={posts}
              onPostClick={setSelectedPost}
            />
          ) : (
            <WeekView
              currentDate={currentDate}
              posts={posts}
              onPostClick={setSelectedPost}
            />
          )
        )}
      </div>

      {/* Modals */}
      {selectedPost && selectedPost.status === 'failed' && (
        <ErrorModal post={selectedPost} onClose={() => setSelectedPost(null)} />
      )}

      {selectedPost && selectedPost.status === 'published' && (
        <SuccessModal
          post={selectedPost}
          accessToken={getChannelToken(selectedPost.channel_id)}
          onClose={() => setSelectedPost(null)}
        />
      )}
    </div>
  );
}
