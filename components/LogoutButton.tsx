'use client';
import { supabase } from '@/lib/supabase';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';

export default function LogoutButton() {
    const router = useRouter();

    const handleLogout = async () => {
        await supabase.auth.signOut();
        router.push('/login');
    };

    return (
        <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-slate-600 hover:text-red-600 transition-colors"
            title="Logout"
        >
            <LogOut size={20} />
            <span className="hidden sm:inline">Logout</span>
        </button>
    );
}
