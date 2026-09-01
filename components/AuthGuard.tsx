'use client';
import { useEffect } from 'react';
import { useSession } from "next-auth/react";
import { useRouter, usePathname } from 'next/navigation';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
    const { data: session, status } = useSession();
    const loading = status === "loading";
    const router = useRouter();
    const pathname = usePathname();

    const isPublicPage =
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/termos' ||
    pathname === '/privacidade';

    useEffect(() => {
        if (!loading && !session && !isPublicPage) {
            router.push('/login');
        }
    }, [session, loading, isPublicPage, router]);

    if (loading && !isPublicPage) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
            </div>
        );
    }

    return <>{children}</>;
}
