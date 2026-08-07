'use client';

import { Suspense } from 'react';
import ContentLibrary from '@/components/ContentLibrary';

export default function ContentPage() {
    return (
        <div className="h-full bg-ios-background">
            <Suspense fallback={<div className="flex justify-center p-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
            </div>}>
                <ContentLibrary mode="manage" />
            </Suspense>
        </div>
    );
}
