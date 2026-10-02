'use client';
import { useState, useEffect, useCallback } from 'react';
import Sidebar from '@/components/Sidebar';
import TabBar from '@/components/TabBar';
import CommandPalette from '@/components/CommandPalette';
import { usePathname } from 'next/navigation';

export default function AppShell({ children }: { children: React.ReactNode }) {
    const [paletteOpen, setPaletteOpen] = useState(false);
    const pathname = usePathname();
    const isPublicPage = ['/login', '/signup', '/termos', '/privacidade'].includes(pathname);

    const openPalette = useCallback(() => setPaletteOpen(true), []);
    const closePalette = useCallback(() => setPaletteOpen(false), []);

    // Global Cmd+K / Ctrl+K listener
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setPaletteOpen(prev => !prev);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);

    if (isPublicPage) {
        return (
            <main className="min-h-screen bg-ios-background text-ios-text">
                {children}
                <footer className="px-4 pb-6 text-center text-xs text-ios-text-secondary">
                    <a href="/termos" className="underline underline-offset-2 hover:text-ios-text">Termos de uso</a>
                    <span className="mx-2" aria-hidden="true">·</span>
                    <a href="/privacidade" className="underline underline-offset-2 hover:text-ios-text">Privacidade</a>
                </footer>
            </main>
        );
    }

    return (
        <div className="flex min-h-screen">
            {/* Desktop Sidebar */}
            <Sidebar onSearchOpen={openPalette} />

            {/* Main content */}
            <div className="flex-1 min-w-0 flex flex-col min-h-screen pb-[calc(83px+env(safe-area-inset-bottom))] md:pb-0">
                <main className="flex-1 p-4 md:p-8 max-w-5xl mx-auto w-full">
                    {children}
                </main>
            </div>

            {/* Mobile Tab Bar */}
            <TabBar onSearchOpen={openPalette} />

            {/* Global Command Palette */}
            <CommandPalette open={paletteOpen} onClose={closePalette} />
        </div>
    );
}
