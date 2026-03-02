'use client';
import { signOut } from 'next-auth/react';
import { LogOut } from 'lucide-react';

export default function LogoutButton() {
    const handleLogout = async () => {
        await signOut({ callbackUrl: '/login' });
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
