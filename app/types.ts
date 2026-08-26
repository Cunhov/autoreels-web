export interface Post {
    id: string;
    video_url: string;
    caption: string;
    status: 'published' | 'failed' | 'cancelled' | 'scheduled' | 'processing' | 'processing_upload' | 'processing_children' | 'pending';
    scheduled_at: string | null;
    error_message?: string;
    failed_reason?: string;
    instagram_media_id?: string;
    instagram_container_id?: string;
    instagram_child_ids?: string;
    channel_id: string;
    planner_id?: string;
    /** Planner relation name, when the calendar feed includes it (posts created by a planner). */
    planner?: { name?: string | null } | null;
    share_to_feed?: boolean;
    location_id?: string;
    title?: string;
    thumbnail_url?: string;
    image_url?: string;
    media_type?: string;
    children_urls?: string;
    collaborators?: string;
    user_tags?: string;
    audio_configuration?: string;
    attempts?: number;
    // ── YouTube ──
    /** "short" | "community" — presente apenas em posts de canais YouTube. */
    youtube_type?: string | null;
    /** ID do vídeo publicado (Shorts). Preenchido pelo publisher. */
    youtube_video_id?: string | null;
    /** ID remoto do post na Comunidade. Preenchido pelo publisher. */
    youtube_post_id?: string | null;
    /** JSON com as opções do Short (ver YoutubeShortOptions). */
    youtube_options: string | null;
}

/** Tipo de conteúdo YouTube suportado na v1. */
export type YoutubeContentType = 'short' | 'community';

/** Opções de publicação de um Short do YouTube (espelha lib/youtube.ts). */
export interface YoutubeShortOptions {
    title?: string;
    description?: string;
    privacy?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
    made_for_kids?: boolean;
    category_id?: number;
    monetize_with_ads?: boolean;
    pinned_comment_text?: string;
}

/**
 * Rotas de primeira classe da navegação (Sidebar/TabBar/CommandPalette).
 * '/youtube/comments' é a página de gestão de comentários do YouTube.
 */
export type AppPage =
    | '/'
    | '/analytics'
    | '/channels'
    | '/planners'
    | '/content'
    | '/upload'
    | '/youtube/comments'
    | '/settings';
