'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { RefreshCw, ALargeSmall } from 'lucide-react';

interface Post {
  id: string;
  video_url: string;
  caption: string;
  status: 'pending' | 'processing_upload' | 'ready_to_publish' | 'published' | 'failed';
  created_at: string;
  error_message?: string;
}

export default function Dashboard() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPosts = async () => {
    setLoading(true);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from('posts')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching posts:', error);
    } else {
      setPosts((data as Post[]) || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchPosts();
  }, []);

  const getStatusBadge = (status: Post['status']) => {
    const styles = {
      pending: 'bg-yellow-100 text-yellow-800',
      processing_upload: 'bg-blue-100 text-blue-800',
      ready_to_publish: 'bg-indigo-100 text-indigo-800',
      published: 'bg-green-100 text-green-800',
      failed: 'bg-red-100 text-red-800',
    };

    return (
      <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium border border-opacity-20 ${styles[status] || 'bg-gray-100'}`}>
        {status.replace('_', ' ')}
      </span>
    );
  };

  return (
    <div className="space-y-6 pb-20 md:pb-0">
      <div className="flex items-center justify-between px-2">
        <h1 className="text-[34px] font-bold tracking-tight text-ios-text">Reels</h1>
        <button
          onClick={fetchPosts}
          disabled={loading}
          className="text-ios-blue active:opacity-50 transition-opacity"
        >
          <RefreshCw size={22} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 px-2">
        {posts.map((post) => (
          <div key={post.id} className="ios-card bg-ios-card flex flex-col relative group">
            <div className="aspect-[9/16] bg-black relative">
              <video
                src={post.video_url}
                className="w-full h-full object-cover"
                controls
              />
              <div className="absolute top-2 right-2">
                {getStatusBadge(post.status)}
              </div>
            </div>

            <div className="p-3 flex-1 flex flex-col gap-1">
              <p className="text-[13px] text-ios-text line-clamp-2 leading-tight">
                {post.caption || 'No caption'}
              </p>
              <span className="text-[11px] text-ios-text-secondary mt-auto pt-2">
                {new Date(post.created_at).toLocaleDateString()}
              </span>

              {post.status === 'failed' && post.error_message && (
                <p className="text-[10px] text-ios-red truncate">{post.error_message}</p>
              )}
            </div>
          </div>
        ))}

        {!loading && posts.length === 0 && (
          <div className="col-span-full py-20 text-center text-ios-text-secondary flex flex-col items-center gap-4">
            <div className="w-16 h-16 bg-gray-200 dark:bg-gray-800 rounded-full flex items-center justify-center">
              <ALargeSmall size={32} className="opacity-50" />
            </div>
            <p className="font-medium">No Reels yet</p>
            <p className="text-sm max-w-xs">Tap "New Post" to create your first Reel.</p>
          </div>
        )}
      </div>
    </div>
  );
}
