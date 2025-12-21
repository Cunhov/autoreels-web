'use client'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Calendar as CalendarIcon, Filter as FilterIcon } from 'lucide-react'
import IOSButton from '@/components/IOSButton'
import IOSCard from '@/components/IOSComponents'

interface Post {
  id: string;
  video_url: string;
  caption: string;
  status: string;
  scheduled_at: string;
}

export default function CalendarPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());

  useEffect(() => {
    fetchPosts();
  }, []);

  async function fetchPosts() {
    setLoading(true);
    const { data } = await supabase.from('posts').select('*');
    if (data) setPosts(data);
    setLoading(false);
  }

  const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthName = currentDate.toLocaleString('default', { month: 'long' });

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));

  const days = [];
  const prevMonthDays = daysInMonth(year, month - 1);
  const startDay = firstDayOfMonth(year, month);
  const totalDays = daysInMonth(year, month);

  // Padding for previous month
  for (let i = startDay - 1; i >= 0; i--) {
    days.push({ day: prevMonthDays - i, current: false });
  }

  // Days of current month
  for (let i = 1; i <= totalDays; i++) {
    days.push({ day: i, current: true, date: new Date(year, month, i) });
  }

  // Padding for next month
  const remaining = 35 - days.length; // Use 35 (5 weeks) or adjust for 6 weeks if needed
  const finalPadding = remaining > 0 ? remaining : (42 - days.length);
  for (let i = 1; i <= finalPadding; i++) {
    days.push({ day: i, current: false });
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

  const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="flex flex-col h-full bg-ios-background">
      <header className="p-6 sticky top-0 z-20 bg-ios-background/80 backdrop-blur-md">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-[34px] font-bold text-ios-text">Calendar</h1>
          <div className="flex gap-2">
            <IOSButton variant="secondary" className="!p-2">
              <FilterIcon size={20} />
            </IOSButton>
            <IOSButton variant="primary" className="!py-2 !px-4" onClick={() => window.location.href = '/new'}>
              <Plus size={20} className="inline mr-1" />
              Schedule new post
            </IOSButton>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            <IOSButton variant="secondary" className="!py-1.5 !px-3 font-medium text-[13px]">Week</IOSButton>
            <IOSButton variant="primary" className="!py-1.5 !px-3 font-medium text-[13px]">Month</IOSButton>
          </div>

          <div className="flex items-center gap-4">
            <button onClick={prevMonth} className="p-1 text-ios-blue hover:bg-black/5 rounded-full">
              <ChevronLeft size={24} />
            </button>
            <h2 className="text-lg font-semibold min-w-[140px] text-center">
              {monthName} {year}
            </h2>
            <button onClick={nextMonth} className="p-1 text-ios-blue hover:bg-black/5 rounded-full">
              <ChevronRight size={24} />
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-4 pb-10">
        <div className="grid grid-cols-7 mb-2">
          {weekDays.map(d => (
            <div key={d} className="text-center text-[11px] font-bold text-ios-secondary uppercase py-2">
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-px bg-ios-separator border border-ios-separator rounded-2xl overflow-hidden shadow-sm">
          {days.map((item, i) => {
            const dayPosts = item.current && item.date ? getPostsForDay(item.date) : [];
            const isToday = item.current && item.date && item.date.toDateString() === new Date().toDateString();

            return (
              <div
                key={i}
                className={`min-h-[140px] bg-ios-card p-2 flex flex-col gap-2 ${!item.current ? 'bg-ios-background/50' : ''}`}
              >
                <div className="flex justify-between items-start">
                  <span className={`text-[13px] font-medium w-6 h-6 flex items-center justify-center rounded-full ${isToday ? 'bg-ios-blue text-white' : item.current ? 'text-ios-text' : 'text-ios-secondary/50'
                    }`}>
                    {item.day}
                  </span>
                </div>

                <div className="flex-1 space-y-1">
                  {dayPosts.map(p => (
                    <div
                      key={p.id}
                      className="group relative aspect-[9/16] rounded-lg overflow-hidden border border-ios-separator shadow-xs cursor-pointer hover:ring-2 ring-ios-blue transition-all"
                    >
                      <video src={p.video_url} className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/20 group-hover:bg-black/0 transition-colors" />
                      <div className="absolute top-1 right-1">
                        <div className={`w-2 h-2 rounded-full ${p.status === 'published' ? 'bg-green-500' : 'bg-yellow-500'
                          }`} />
                      </div>
                      <div className="absolute bottom-0 inset-x-0 p-1 bg-black/40 backdrop-blur-xs">
                        <p className="text-[8px] text-white font-medium truncate">
                          {new Date(p.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  ))}
                  {item.current && dayPosts.length > 2 && (
                    <div className="text-[10px] text-center font-bold text-ios-blue">
                      +{dayPosts.length - 2} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
