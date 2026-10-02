'use client';
import Link from 'next/link';
import { Calendar, Folder, Plus, X, MoreHorizontal, Search, LogOut, BarChart2, Radio, Youtube, Bot, Sliders, CloudUpload, Settings } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { useState, useEffect, useRef } from 'react';

interface TabBarProps { onSearchOpen?: () => void; }

export default function TabBar({ onSearchOpen }: TabBarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const [menuOpen, setMenuOpen] = useState(false);
    const [failedCount, setFailedCount] = useState(0);
    const [activePlanners, setActivePlanners] = useState(0);
    const menuRef = useRef<HTMLElement>(null);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const isActive = (path: string) => pathname === path;

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/summary');
                const summary = res.ok ? await res.json() : {};
                setFailedCount(Number(summary.failedPosts || 0));
                setActivePlanners(Number(summary.activePlanners || 0));
            } catch { }
        })();
    }, []);

    useEffect(() => {
        if (!menuOpen) return;
        const focusTimer = window.setTimeout(() => {
            menuRef.current?.querySelector<HTMLElement>('a[href], button')?.focus();
        }, 0);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setMenuOpen(false);
            window.setTimeout(() => menuButtonRef.current?.focus(), 0);
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.clearTimeout(focusTimer);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [menuOpen]);

    const closeMenu = () => {
        setMenuOpen(false);
        window.setTimeout(() => menuButtonRef.current?.focus(), 0);
    };

    const destinations = [
        { name: 'Calendário', path: '/', icon: Calendar, badge: failedCount },
        { name: 'Analytics', path: '/analytics', icon: BarChart2 },
        { name: 'Canais', path: '/channels', icon: Radio },
        { name: 'Comentários YouTube', path: '/youtube/comments', icon: Youtube },
        { name: 'Automações', path: '/automations', icon: Bot },
        { name: 'Planners', path: '/planners', icon: Sliders, badge: activePlanners },
        { name: 'Biblioteca', path: '/content', icon: Folder },
        { name: 'Uploads', path: '/upload', icon: CloudUpload },
        { name: 'Configurações', path: '/settings', icon: Settings },
    ];
    const closeAndGo = (href: string) => { setMenuOpen(false); router.push(href); };

    return (
        <>
            {menuOpen && <button aria-label="Fechar menu" className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={closeMenu} />}
            {menuOpen && <nav ref={menuRef} aria-label="Todas as páginas" className="md:hidden fixed bottom-[calc(72px+env(safe-area-inset-bottom))] right-3 z-[45] w-[min(22rem,calc(100vw-1.5rem))] max-h-[70dvh] overflow-y-auto rounded-2xl border border-ios-separator bg-ios-card p-2 shadow-2xl">
                <button onClick={() => { setMenuOpen(false); onSearchOpen?.(); }} className="w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left text-ios-text hover:bg-ios-gray-6"><Search size={18} /> Buscar páginas e conteúdo</button>
                <div className="my-1 border-t border-ios-separator" />
                <button onClick={() => closeAndGo('/planners?new=1')} className="w-full rounded-xl px-3 py-3 text-left text-sm text-ios-text hover:bg-ios-gray-6">Novo planner</button>
                {destinations.map(({ name, path, icon: Icon, badge }) => <Link key={path} href={path} onClick={() => setMenuOpen(false)} className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm ${isActive(path) ? 'bg-ios-blue/10 text-ios-blue' : 'text-ios-text hover:bg-ios-gray-6'}`}><Icon size={18} /><span className="flex-1">{name}</span>{badge ? <span className="rounded-full bg-ios-red px-2 text-xs font-bold text-white">{badge > 9 ? '9+' : badge}</span> : null}</Link>)}
                <div className="my-1 border-t border-ios-separator" />
                <button onClick={() => signOut()} className="w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left text-ios-red hover:bg-ios-red/10"><LogOut size={18} /> Sair</button>
            </nav>}
            <nav aria-label="Navegação principal" className="md:hidden fixed bottom-0 left-0 right-0 ios-blur border-t border-ios-separator z-30 pb-[env(safe-area-inset-bottom)]">
                <div className="flex h-[60px] items-center px-3">
                    <Link href="/" aria-current={isActive('/') ? 'page' : undefined} className={`flex flex-1 flex-col items-center justify-center gap-1 ${isActive('/') ? 'text-ios-blue' : 'text-ios-text-secondary'}`}><Calendar size={20} /><span className="text-[10px]">Calendário</span>{failedCount > 0 && <span className="absolute top-1 ml-5 rounded-full bg-ios-red px-1 text-[9px] text-white">{failedCount > 9 ? '9+' : failedCount}</span>}</Link>
                    <Link href="/content" aria-current={isActive('/content') ? 'page' : undefined} className={`flex flex-1 flex-col items-center justify-center gap-1 ${isActive('/content') ? 'text-ios-blue' : 'text-ios-text-secondary'}`}><Folder size={20} /><span className="text-[10px]">Biblioteca</span></Link>
                    <button onClick={() => router.push('/new')} aria-label="Criar novo post" className="-mt-5 mx-3 flex h-12 w-12 items-center justify-center rounded-full bg-ios-blue text-white shadow-lg"><Plus size={24} /></button>
                    <button ref={menuButtonRef} onClick={() => setMenuOpen(value => !value)} aria-expanded={menuOpen} aria-label={menuOpen ? 'Fechar menu' : 'Mais páginas e ações'} className={`flex flex-1 flex-col items-center justify-center gap-1 ${menuOpen ? 'text-ios-blue' : 'text-ios-text-secondary'}`}>{menuOpen ? <X size={20} /> : <MoreHorizontal size={20} />}<span className="text-[10px]">Mais</span></button>
                </div>
            </nav>
        </>
    );
}
