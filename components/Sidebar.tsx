'use client';
import Link from 'next/link';
import { Calendar, BarChart2, Radio, Sliders, PlusSquare, Folder, LogOut, Search } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';

interface NavBadges {
    failedPosts: number;
    activePlanners: number;
}

interface SidebarProps {
    onSearchOpen?: () => void;
}

export default function Sidebar({ onSearchOpen }: SidebarProps) {
    const pathname = usePathname();
    const { data: session } = useSession();
    const [badges, setBadges] = useState<NavBadges>({ failedPosts: 0, activePlanners: 0 });

    const isActive = (path: string) => pathname === path;

    // Fetch badge counts
    useEffect(() => {
        (async () => {
            try {
                const [postsRes, plannersRes] = await Promise.all([
                    fetch('/api/posts'),
                    fetch('/api/planners'),
                ]);
                const posts = postsRes.ok ? await postsRes.json() : [];
                const planners = plannersRes.ok ? await plannersRes.json() : [];
                const failedPosts = Array.isArray(posts) ? posts.filter((p: any) => p.status === 'failed').length : 0;
                const activePlanners = Array.isArray(planners) ? planners.filter((p: any) => p.status === 'active').length : 0;
                setBadges({ failedPosts, activePlanners });
            } catch { }
        })();
    }, []);

    const navItems = [
        { name: 'Calendar', path: '/', icon: Calendar, badge: badges.failedPosts > 0 ? badges.failedPosts : 0, badgeColor: 'bg-ios-red' },
        { name: 'Analytics', path: '/analytics', icon: BarChart2, badge: 0, badgeColor: '' },
        { name: 'Channels', path: '/channels', icon: Radio, badge: 0, badgeColor: '' },
        { name: 'Planners', path: '/planners', icon: Sliders, badge: badges.activePlanners > 0 ? badges.activePlanners : 0, badgeColor: 'bg-ios-green' },
        { name: 'Library', path: '/content', icon: Folder, badge: 0, badgeColor: '' },
    ];

    const userEmail = session?.user?.email ?? '';
    const userInitial = userEmail ? userEmail[0].toUpperCase() : '?';

    return (
        <div className="w-64 flex-shrink-0 h-screen sticky top-0 flex flex-col justify-between p-4 bg-ios-card dark:bg-[#111] border-r border-ios-separator backdrop-blur-xl hidden md:flex">
            <div className="space-y-5">
                {/* App Logo & Title */}
                <div className="px-2 pt-2 pb-1">
                    <h1 className="text-[22px] font-bold tracking-tight text-ios-blue select-none">AutoReels</h1>
                    <p className="text-[11px] text-ios-text-secondary mt-0.5">Instagram Automation</p>
                </div>

                {/* Search shortcut */}
                {onSearchOpen && (
                    <button
                        onClick={onSearchOpen}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-ios-gray-6 text-ios-text-secondary hover:bg-ios-gray-5 transition-colors text-[13px]"
                    >
                        <Search size={14} />
                        <span>Search…</span>
                        <kbd className="ml-auto font-mono text-[11px] bg-ios-separator px-1.5 py-0.5 rounded">⌘K</kbd>
                    </button>
                )}

                {/* Navigation */}
                <nav className="space-y-0.5">
                    {navItems.map((item) => (
                        <Link
                            key={item.path}
                            href={item.path}
                            className={`flex items-center gap-3 px-3 py-2.5 text-[15px] font-medium rounded-xl transition-all ${isActive(item.path)
                                    ? 'bg-ios-blue/10 text-ios-blue'
                                    : 'text-ios-text-secondary hover:bg-ios-gray-6 hover:text-ios-text'
                                }`}
                        >
                            <item.icon size={20} strokeWidth={isActive(item.path) ? 2.5 : 2} />
                            <span className="flex-1">{item.name}</span>
                            {item.badge > 0 && (
                                <span className={`text-white text-[11px] font-bold min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1 ${item.badgeColor}`}>
                                    {item.badge > 9 ? '9+' : item.badge}
                                </span>
                            )}
                        </Link>
                    ))}
                </nav>

                {/* New Post CTA */}
                <Link
                    href="/new"
                    className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-ios-blue text-white text-[15px] font-semibold transition-opacity hover:opacity-90 active:opacity-75"
                >
                    <PlusSquare size={18} />
                    New Post
                </Link>
            </div>

            {/* User info + Logout */}
            <div className="pt-4 border-t border-ios-separator space-y-3">
                <div className="flex items-center gap-3 px-2">
                    <div className="w-8 h-8 rounded-full bg-ios-blue/20 text-ios-blue flex items-center justify-center text-[13px] font-bold shrink-0">
                        {userInitial}
                    </div>
                    <p className="text-[12px] text-ios-text-secondary truncate flex-1">{userEmail || 'Logged in'}</p>
                </div>
                <button
                    onClick={() => signOut()}
                    className="flex items-center gap-2 px-3 py-2 w-full rounded-xl text-ios-red text-[14px] hover:bg-ios-red/10 transition-colors"
                >
                    <LogOut size={16} />
                    Sign out
                </button>
            </div>
        </div>
    );
}
