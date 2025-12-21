'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter, usePathname } from 'next/navigation';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
    const [loading, setLoading] = useState(true);
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        const checkUser = async () => {
            const { data: { session } } = await supabase.auth.getSession();

            if (!session && pathname !== '/login' && pathname !== '/signup') {
                router.push('/login');
            } else {
                setLoading(false);
            }
        };

        checkUser();

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            if (!session && pathname !== '/login' && pathname !== '/signup') {
                router.push('/login');
            }
        });

        return () => subscription.unsubscribe();
    }, [pathname, router]);

    if (loading && pathname !== '/login' && pathname !== '/signup') {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
            </div>
        );
    }

    return <>{children}</>;
}
