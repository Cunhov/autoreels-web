export interface Post {
    id: string;
    video_url: string;
    caption: string;
    status: 'published' | 'failed' | 'cancelled' | 'scheduled' | 'processing' | 'processing_upload' | 'processing_children' | 'pending';
    scheduled_at: string;
    error_message?: string;
    failed_reason?: string;
    instagram_media_id?: string;
    channel_id: string;
    planner_id?: string;
    share_to_feed?: boolean;
    location_id?: string;
    title?: string;
    thumbnail_url?: string;
    image_url?: string;
}
