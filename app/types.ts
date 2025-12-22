export interface Post {
    id: string;
    video_url: string;
    caption: string;
    status: 'published' | 'failed' | 'scheduled' | 'processing';
    scheduled_at: string;
    error_message?: string;
    failed_reason?: string;
    instagram_media_id?: string;
    channel_id: string;
    title?: string;
    thumbnail_url?: string;
}
