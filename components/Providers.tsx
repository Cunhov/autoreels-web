'use client';

import { SessionProvider } from "next-auth/react";
import { UploadProvider } from "@/contexts/UploadContext";

export default function Providers({ children }: { children: React.ReactNode }) {
    return (
        <SessionProvider>
            <UploadProvider>
                {children}
            </UploadProvider>
        </SessionProvider>
    );
}
