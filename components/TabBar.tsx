'use client';
import Link from 'next/link';
import { Calendar, BarChart2, Radio, Sliders, Folder, Plus, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

interface TabBarProps {
    onSearchOpen?: () => void;
}

export default function TabBar({ onSearchOpen }: TabBarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const [fabOpen, setFabOpen] = useState(false);
    const [failedCount, setFailedCount] = useState(0);
    const [activePlanners, setActivePlanners] = useState(0);

    const isActive = (path: string) => pathname === path;

    useEffect(() => {
        (async () => {
            try {
                const [postsRes, plannersRes] = await Promise.all([
                    fetch('/api/posts'),
                    fetch('/api/planners'),
                ]);
                const posts = postsRes.ok ? await postsRes.json() : [];
                const planners = plannersRes.ok ? await plannersRes.json() : [];
                setFailedCount(Array.isArray(posts) ? posts.filter((p: any) => p.status === 'failed').length : 0);
                setActivePlanners(Array.isArray(planners) ? planners.filter((p: any) => p.status === 'active').length : 0);
            } catch { }
        })();
    }, []);

    const navItems = [
        { name: 'Calendar', path: '/', icon: Calendar, badge: failedCount > 0 ? failedCount : 0, badgeColor: 'bg-ios-red' },
        { name: 'Analytics', path: '/analytics', icon: BarChart2, badge: 0, badgeColor: '' },
        { name: 'Channels', path: '/channels', icon: Radio, badge: 0, badgeColor: '' },
        { name: 'Planners', path: '/planners', icon: Sliders, badge: activePlanners > 0 ? activePlanners : 0, badgeColor: 'bg-ios-green' },
        { name: 'Library', path: '/content', icon: Folder, badge: 0, badgeColor: '' },
    ];

    const fabActions = [
        { label: 'New Post', href: '/new', color: 'bg-ios-blue' },
        { label: 'New Planner', href: '/planners', color: 'bg-purple-600' },
    ];

    return (
        <>
            {/* FAB Overlay */}
            {fabOpen && (
                <div
                    className="md:hidden fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm fade-in"
                    onClick={() => setFabOpen(false)}
                />
            )}

            {/* FAB Actions */}
            {fabOpen && (
                <div className="md:hidden fixed bottom-[90px] right-4 z-[70] flex flex-col gap-2 items-end slide-up">
                    {fabActions.map((action, i) => (
                        <button
                            key={action.label}
                            onClick={() => { setFabOpen(false); router.push(action.href); }}
                            className={`flex items-center gap-2 px-4 py-2.5 rounded-full text-white text-[14px] font-semibold shadow-lg ${action.color}`}
                            style={{ animationDelay: `${i * 40}ms` }}
                        >
                            {action.label}
                        </button>
                    ))}
                </div>
            )}

            {/* Tab Bar */}
            <div className="md:hidden fixed bottom-0 left-0 right-0 ios-blur border-t border-ios-separator z-50">
                <div className="flex justify-around items-center h-[60px] pb-safe">
                    {navItems.map((item) => (
                        <Link
                            key={item.path}
                            href={item.path}
                            className={`relative flex flex-col items-center justify-center flex-1 h-full gap-0.5 transition-colors ${isActive(item.path) ? 'text-ios-blue' : 'text-ios-text-secondary'
                                }`}
                        >
                            <div className="relative">
                                <item.icon size={22} strokeWidth={isActive(item.path) ? 2.5 : 2} />
                                {item.badge > 0 && (
                                    <span className={`absolute -top-1.5 -right-1.5 text-white text-[9px] font-bold min-w-[14px] h-[14px] flex items-center justify-center rounded-full px-0.5 ${item.badgeColor}`}>
                                        {item.badge > 9 ? '9+' : item.badge}
                                    </span>
                                )}
                            </div>
                            <span className="text-[9px] font-medium">{item.name}</span>
                        </Link>
                    ))}

                    {/* FAB Button (center-ish) */}
                    <button
                        onClick={() => setFabOpen(f => !f)}
                        aria-label="Quick actions"
                        className={`flex flex-col items-center justify-center flex-1 h-full gap-0.5 transition-colors ${fabOpen ? 'text-ios-red' : 'text-ios-blue'}`}
                    >
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${fabOpen ? 'bg-ios-red text-white rotate-45' : 'bg-ios-blue text-white'
                            }`}>
                            {fabOpen ? <X size={18} /> : <Plus size={20} />}
                        </div>
                        <span className="text-[9px] font-medium">{fabOpen ? 'Close' : 'New'}</span>
                    </button>
                </div>
            </div>
        </>
    );
}
