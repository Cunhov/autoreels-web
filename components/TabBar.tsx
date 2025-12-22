'use client';
import Link from 'next/link';
import { Calendar, BarChart2, Radio, Sliders, PlusSquare, Folder } from 'lucide-react';
import { usePathname } from 'next/navigation';

export default function TabBar() {
    const pathname = usePathname();
    const isActive = (path: string) => pathname === path;

    const navItems = [
        { name: 'Calendar', path: '/', icon: Calendar },
        { name: 'Analytics', path: '/analytics', icon: BarChart2 },
        { name: 'Channels', path: '/channels', icon: Radio },
        { name: 'Planners', path: '/planners', icon: Sliders },
        { name: 'Library', path: '/content', icon: Folder },
        { name: 'Post', path: '/new', icon: PlusSquare },
    ];

    return (
        <div className="md:hidden fixed bottom-0 left-0 right-0 ios-blur border-t border-ios-separator z-50 flex justify-around items-center h-[83px] pb-[20px]">
            {navItems.map((item) => (
                <Link
                    key={item.path}
                    href={item.path}
                    className={`flex flex-col items-center justify-center w-full h-full space-y-1 ${isActive(item.path) ? 'text-ios-blue' : 'text-gray-400'
                        }`}
                >
                    <item.icon size={24} strokeWidth={isActive(item.path) ? 2.5 : 2} />
                    <span className="text-[10px] font-medium">{item.name}</span>
                </Link>
            ))}
        </div>
    );
}
