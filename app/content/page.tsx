'use client';

import ContentLibrary from '@/components/ContentLibrary';

export default function ContentPage() {
    return (
        <div className="h-full bg-ios-background">
            <ContentLibrary mode="manage" />
        </div>
    );
}
