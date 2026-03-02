'use client'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import IOSCard from '@/components/IOSComponents'
import { BarChart2, TrendingUp, Users, Eye, ArrowUpRight, ArrowDownRight, Video, CheckCircle2, Clock } from 'lucide-react'

export default function AnalyticsPage() {
    const [stats, setStats] = useState({
        totalPosts: 0,
        publishedPosts: 0,
        scheduledPosts: 0,
        totalChannels: 0,
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchAnalytics();
    }, []);

    async function fetchAnalytics() {
        try {
            const [postsRes, channelsRes] = await Promise.all([
                fetch('/api/posts'),
                fetch('/api/channels'),
            ]);

            const posts = await postsRes.json();
            const channels = await channelsRes.json();

            if (Array.isArray(posts) && Array.isArray(channels)) {
                setStats({
                    totalPosts: posts.length,
                    publishedPosts: posts.filter((p: any) => p.status === 'published').length,
                    scheduledPosts: posts.filter((p: any) => p.status === 'pending').length,
                    totalChannels: channels.length,
                });
            }
        } catch (error) {
            console.error('Error fetching analytics:', error);
        } finally {
            setLoading(false);
        }
    }

    const statCards = [
        { label: 'Total Posts', value: stats.totalPosts, icon: Video, color: 'text-blue-500' },
        { label: 'Published', value: stats.publishedPosts, icon: CheckCircle2, color: 'text-green-500' },
        { label: 'Pending', value: stats.scheduledPosts, icon: Clock, color: 'text-purple-500' },
    ];

    return (
        <div className="p-6 bg-ios-background min-h-full pb-20">
            <h1 className="text-[34px] font-bold text-ios-text mb-6">Analytics</h1>

            {loading ? (
                <div className="flex justify-center p-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                        {statCards.map((stat) => (
                            <IOSCard key={stat.label} className="p-4">
                                <div className="flex justify-between items-start mb-2">
                                    <div className={`p-2 rounded-lg bg-ios-background ${stat.color}`}>
                                        <stat.icon size={20} />
                                    </div>
                                </div>
                                <p className="text-[13px] text-ios-secondary font-medium">{stat.label}</p>
                                <p className="text-2xl font-bold text-ios-text">{stat.value}</p>
                            </IOSCard>
                        ))}
                    </div>

                    <IOSCard className="p-6 mb-6">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-lg font-bold">Performance</h3>
                        </div>

                        <div className="h-48 flex items-center justify-center text-ios-secondary border-2 border-dashed border-ios-separator rounded-2xl">
                            <div className="text-center">
                                <BarChart2 size={32} className="mx-auto mb-2 opacity-50" />
                                <p className="text-sm">Detailed performance data will appear here after your first posts are published.</p>
                            </div>
                        </div>
                    </IOSCard>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <IOSCard className="p-6">
                            <h3 className="text-lg font-bold mb-4">Total Channels</h3>
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-ios-background border border-ios-separator flex items-center justify-center">
                                            <Users size={16} className="text-ios-blue" />
                                        </div>
                                        <p className="text-[15px] font-medium">Connected Accounts</p>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-xl font-bold">{stats.totalChannels}</p>
                                    </div>
                                </div>
                            </div>
                        </IOSCard>

                        <IOSCard className="p-6">
                            <h3 className="text-lg font-bold mb-4">Insights</h3>
                            <p className="text-ios-secondary text-sm">
                                As you publish more reels, we'll analyze your engagement patterns to provide insights on the best times to post and content performance.
                            </p>
                        </IOSCard>
                    </div>
                </>
            )}
        </div>
    );
}
