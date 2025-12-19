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
    const { data, error } = await supabase
      .from('posts')
      .select('*')
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800">Your Reels</h1>
        <button
          onClick={fetchPosts}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {posts.map((post) => (
          <div key={post.id} className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden flex flex-col">
            <div className="aspect-[9/16] bg-black relative group">
              <video
                src={post.video_url}
                className="w-full h-full object-cover"
                controls
              />
              <div className="absolute top-2 right-2">
                {getStatusBadge(post.status)}
              </div>
            </div>
            <div className="p-4 flex-1 flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <ALargeSmall className="text-slate-400 mt-1 flex-shrink-0" size={16} />
                <p className="text-sm text-slate-600 line-clamp-3">{post.caption || 'No caption'}</p>
              </div>

              <div className="mt-auto pt-4 border-t border-slate-100 text-xs text-slate-400 flex justify-between items-center">
                <span>{new Date(post.created_at).toLocaleDateString()}</span>
                {post.status === 'failed' && post.error_message && (
                  <div className="relative group/tooltip">
                    <span className="text-red-500 font-medium cursor-help">Error Details</span>
                    <div className="absolute bottom-full right-0 mb-2 w-48 p-2 bg-slate-800 text-white text-xs rounded shadow-lg opacity-0 group-hover/tooltip:opacity-100 transition-opacity pointer-events-none z-10">
                      {post.error_message}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}

        {!loading && posts.length === 0 && (
          <div className="col-span-full py-12 text-center text-slate-500 bg-white rounded-lg border border-slate-200 border-dashed">
            <p>No posts found. Create your first Reel!</p>
          </div>
        )}
      </div>
    </div>
  );
}
