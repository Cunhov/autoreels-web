'use client'
import IOSCard from '@/components/IOSComponents'
import { BarChart2, TrendingUp, Users, Eye, ArrowUpRight, ArrowDownRight } from 'lucide-react'

export default function AnalyticsPage() {
    const stats = [
        { label: 'Followers', value: '12.4K', change: '+2.4%', trend: 'up', icon: Users, color: 'text-blue-500' },
        { label: 'Reach', value: '84.2K', change: '+12.1%', trend: 'up', icon: Eye, color: 'text-purple-500' },
        { label: 'Engagement', value: '4.8%', change: '-0.2%', trend: 'down', icon: TrendingUp, color: 'text-green-500' },
    ];

    const chartData = [40, 70, 45, 90, 65, 80, 95];

    return (
        <div className="p-6 bg-ios-background min-h-full pb-20">
            <h1 className="text-[34px] font-bold text-ios-text mb-6">Analytics</h1>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                {stats.map((stat) => (
                    <IOSCard key={stat.label} className="p-4">
                        <div className="flex justify-between items-start mb-2">
                            <div className={`p-2 rounded-lg bg-ios-background ${stat.color}`}>
                                <stat.icon size={20} />
                            </div>
                            <div className={`flex items-center text-[13px] font-bold ${stat.trend === 'up' ? 'text-green-500' : 'text-red-500'}`}>
                                {stat.change}
                                {stat.trend === 'up' ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
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
                    <select className="bg-ios-background border-none text-[13px] font-bold text-ios-blue focus:ring-0">
                        <option>Last 7 Days</option>
                        <option>Last 30 Days</option>
                    </select>
                </div>

                <div className="h-48 flex items-end gap-2 px-2">
                    {chartData.map((val, i) => (
                        <div key={i} className="flex-1 flex flex-col items-center gap-2">
                            <div
                                className="w-full bg-ios-blue rounded-t-lg transition-all duration-500 ease-out"
                                style={{ height: `${val}%` }}
                            />
                            <span className="text-[10px] text-ios-secondary font-bold">
                                {['M', 'T', 'W', 'T', 'F', 'S', 'S'][i]}
                            </span>
                        </div>
                    ))}
                </div>
            </IOSCard>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <IOSCard className="p-6">
                    <h3 className="text-lg font-bold mb-4">Top Channels</h3>
                    <div className="space-y-4">
                        {[1, 2, 3].map(i => (
                            <div key={i} className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-full bg-ios-background border border-ios-separator" />
                                    <p className="text-[15px] font-medium">Channel {i}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-[15px] font-bold">{(1200 / i).toFixed(0)}</p>
                                    <p className="text-[11px] text-ios-secondary uppercase font-bold">Reach</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </IOSCard>

                <IOSCard className="p-6">
                    <h3 className="text-lg font-bold mb-4">Best Time to Post</h3>
                    <div className="grid grid-cols-4 gap-2">
                        {[9, 12, 15, 18, 21, 0, 3, 6].map(hour => (
                            <div key={hour} className="p-3 bg-ios-background rounded-xl text-center">
                                <p className="text-[13px] font-bold text-ios-blue">{hour}:00</p>
                                <div className="flex justify-center mt-1">
                                    <div className="flex gap-0.5">
                                        {[1, 2, 3].map(d => (
                                            <div key={d} className={`w-1 h-3 rounded-full ${hour === 18 ? 'bg-ios-blue' : 'bg-ios-separator'}`} />
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </IOSCard>
            </div>
        </div>
    );
}
