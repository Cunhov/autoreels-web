'use client';
import Link from 'next/link';
import { Home, PlusSquare, Settings, LogOut } from 'lucide-react';
import { usePathname } from 'next/navigation';

export default function Sidebar() {
    const pathname = usePathname();

    const isActive = (path: string) => pathname === path;

    const navItems = [
        { name: 'Dashboard', path: '/', icon: Home },
        { name: 'New Post', path: '/new', icon: PlusSquare },
        { name: 'Settings', path: '/settings', icon: Settings },
    ];

    return (
        <div className="w-full md:w-64 md:flex-shrink-0 md:h-screen sticky top-0 md:flex md:flex-col justify-between p-4 bg-gray-50/50 md:bg-gray-100/50 dark:bg-black/20 border-r border-gray-200 dark:border-gray-800 backdrop-blur-xl hidden">

            <div className="space-y-6">
                {/* App Title */}
                <div className="px-4 py-2">
                    <h1 className="text-2xl font-bold tracking-tight text-ios-blue">AutoReels</h1>
                </div>

                {/* Navigation Links */}
                <nav className="space-y-1">
                    {navItems.map((item) => (
                        <Link
                            key={item.path}
                            href={item.path}
                            className={`flex items-center gap-3 px-4 py-3 text-[17px] font-medium rounded-xl transition-all ${isActive(item.path)
                                    ? 'bg-ios-blue/10 text-ios-blue'
                                    : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                                }`}
                        >
                            <item.icon size={22} strokeWidth={isActive(item.path) ? 2.5 : 2} />
                            {item.name}
                        </Link>
                    ))}
                </nav>
            </div>

            {/* Logout (Bottom of Sidebar on Desktop) */}
            <div className="pt-4 border-t border-gray-200 dark:border-gray-800">
                {/* We need to use the LogoutButton component functionality here directly or wrap it. 
                    For now, creating a styled link that matches. */}
                {/* Note: The actual functionality is imported if we reuse the component, 
                    but sidebar usually needs custom styling. Let's keep it simple. */}
            </div>
        </div>
    );
}
