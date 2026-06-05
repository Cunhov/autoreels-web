type PlannerContentItem = {
    type?: string;
    id?: string;
    url?: string;
    media_type?: string;
    caption?: string;
    caption_fallback?: string;
    title_fallback?: string;
    location_id?: string | null;
    share_to_feed?: boolean;
    thumbnail_url?: string;
    children_urls?: { url: string; type: string; thumbnail_url?: string }[];
    carousel_items?: { url: string; type: string; thumbnail_url?: string }[];
    collaborators?: string | null;
    audio_configuration?: { audio_id: string; audio_volume?: number; video_volume?: number } | null;
    user_tags?: string | null;
};

type PlannerConfig = {
    frequency?: { value?: number; unit?: string };
    timezone?: string;
    start_time?: string;
    sleep_schedule?: { start?: string; end?: string } | null;
    sort_order?: 'random_loop' | 'old_to_new' | 'new_to_old' | string;
    content?: PlannerContentItem[];
    state?: Record<string, any>;
};

type ChannelLike = {
    id: string;
    name?: string | null;
    status?: string | null;
    access_token?: string | null;
    token_source?: string | null;
    token_expires_at?: Date | string | null;
    token_refreshed_at?: Date | string | null;
};

type PrismaLike = {
    contentItem: {
        findUnique: (args: any) => Promise<any>;
        findMany: (args: any) => Promise<any[]>;
    };
};

export function parsePlannerConfig(rawConfig: unknown): PlannerConfig {
    if (!rawConfig) return {};
    if (typeof rawConfig === 'object') return rawConfig as PlannerConfig;

    try {
        const first = JSON.parse(String(rawConfig));
        return typeof first === 'string' ? JSON.parse(first) : first;
    } catch {
        return {};
    }
}

function cloneState(state: Record<string, any> | undefined): Record<string, any> {
    return state ? JSON.parse(JSON.stringify(state)) : {};
}

function selectContentIndex(contentList: PlannerContentItem[], sortOrder: string, state: Record<string, any>) {
    if (contentList.length === 0) {
        return { selectedIndex: -1, nextState: state };
    }

    let selectedIndex = -1;
    const nextState = cloneState(state);

    if (sortOrder === 'random_loop') {
        const published = Array.isArray(nextState.published_indexes) ? nextState.published_indexes : [];
        const available = contentList.map((_, i) => i).filter(i => !published.includes(i));

        if (available.length === 0) {
            const lastIndex = published.length > 0 ? published[published.length - 1] : -1;
            let candidates = contentList.map((_, i) => i);
            if (contentList.length > 1 && lastIndex !== -1) {
                candidates = candidates.filter(i => i !== lastIndex);
            }
            selectedIndex = candidates[Math.floor(Math.random() * candidates.length)];
            nextState.published_indexes = [selectedIndex];
        } else {
            selectedIndex = available[Math.floor(Math.random() * available.length)];
            nextState.published_indexes = [...published, selectedIndex];
        }
    } else if (sortOrder === 'new_to_old') {
        const last = nextState.last_index !== undefined ? nextState.last_index : contentList.length;
        selectedIndex = last - 1 < 0 ? contentList.length - 1 : last - 1;
        nextState.last_index = selectedIndex;
    } else {
        const last = nextState.last_index !== undefined ? nextState.last_index : -1;
        selectedIndex = (last + 1) % contentList.length;
        nextState.last_index = selectedIndex;
    }

    return { selectedIndex, nextState };
}

export function getChannelHealth(channel: ChannelLike, now = new Date()) {
    const issues: string[] = [];
    const warnings: string[] = [];
    const hasToken = Boolean(channel.access_token);

    if ((channel.status || '').toLowerCase() !== 'active') {
        issues.push('inactive');
    }

    if (!hasToken) {
        issues.push('missing_token');
    }

    if (channel.token_source !== 'redis' && channel.token_expires_at) {
        const expiresAt = new Date(channel.token_expires_at);
        const daysLeft = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        if (daysLeft < 0) issues.push('expired');
        else if (daysLeft < 14) warnings.push('expiring_soon');
    }

    if (channel.token_source === 'redis') {
        warnings.push('legacy_redis_token');
    }

    return {
        ok: issues.length === 0,
        issues,
        warnings,
        hasToken,
    };
}

export function describeChannelHealth(channel: ChannelLike, now = new Date()) {
    const health = getChannelHealth(channel, now);
    const readableIssues: Record<string, string> = {
        inactive: 'Channel is paused',
        missing_token: 'Token missing',
        expired: 'Token expired',
    };
    const readableWarnings: Record<string, string> = {
        expiring_soon: 'Token expiring soon',
        legacy_redis_token: 'Legacy Redis token',
    };

    return {
        ...health,
        label: health.ok ? (health.warnings.includes('expiring_soon') ? 'Token expiring' : 'Ready') : 'Blocked',
        issues: health.issues.map(item => readableIssues[item] || item),
        warnings: health.warnings.map(item => readableWarnings[item] || item),
    };
}

export async function resolvePlannerRuntime(prisma: PrismaLike, planner: any, now = new Date()) {
    const config = parsePlannerConfig(planner.config);
    const contentList: PlannerContentItem[] = Array.isArray(config.content) ? config.content : [];
    const sortOrder = config.sort_order || 'random_loop';
    const state = cloneState(config.state);
    const { selectedIndex, nextState } = selectContentIndex(contentList, sortOrder, state);
    const selectedContent = contentList[selectedIndex];

    const warnings: string[] = [];

    if (!selectedContent) {
        return {
            ok: false,
            errors: ['Could not select content item'],
            warnings,
            selectedIndex,
            nextState,
        };
    }

    let mediaUrl = selectedContent.url || '';
    let mediaType = selectedContent.media_type || 'REELS';
    let caption = selectedContent.caption || '';
    const locationId = selectedContent.location_id || null;
    const shareToFeed = selectedContent.share_to_feed !== false;
    let thumbnailUrl = selectedContent.thumbnail_url || null;
    let children: { url: string; type: string; thumbnail_url?: string }[] = selectedContent.children_urls || selectedContent.carousel_items || [];
    const collaborators = selectedContent.collaborators || null;
    const audioConfiguration = selectedContent.audio_configuration || null;
    const userTags = selectedContent.user_tags || null;

    if (selectedContent.type === 'library_item' || (selectedContent.type === 'config' && selectedContent.id) || (!selectedContent.type && selectedContent.id)) {
        const libItem = await prisma.contentItem.findUnique({ where: { id: selectedContent.id } });
        if (libItem) {
            mediaUrl = libItem.url || '';
            thumbnailUrl = libItem.thumbnail_url || thumbnailUrl;
            mediaType = libItem.type === 'video'
                ? 'REELS'
                : libItem.type === 'image'
                    ? 'IMAGE'
                    : libItem.type === 'carousel_folder'
                        ? 'CAROUSEL'
                        : mediaType;

            if (libItem.type === 'carousel_folder') {
                const subItems = await prisma.contentItem.findMany({
                    where: { parent_id: libItem.id },
                    orderBy: { created_at: 'asc' },
                });
                children = subItems.map((c: any) => {
                    const urlStr = c.url || '';
                    const isVideo = c.type === 'video' || (urlStr && /\.(mp4|mov)(\?.*)?$/i.test(urlStr));
                    return {
                        url: urlStr,
                        type: isVideo ? 'video' : 'image',
                        thumbnail_url: c.thumbnail_url || null,
                    };
                }).slice(0, 10);

                if (subItems.length > 10) {
                    warnings.push('Carousel limited to 10 items for Instagram');
                }
                if (!thumbnailUrl && children.length > 0) {
                    thumbnailUrl = children[0].url;
                }
            }

            const itemTitle = libItem.title || selectedContent.title_fallback || '';
            const itemCaption = libItem.caption || selectedContent.caption_fallback || '';

            caption = (caption || '')
                .replace(/{post_title}/g, itemTitle)
                .replace(/{post_caption}/g, itemCaption);
        } else {
            warnings.push(`Library item not found: ${selectedContent.id}`);
        }
    }

    if (!thumbnailUrl && children.length > 0) {
        thumbnailUrl = children[0].thumbnail_url || children[0].url;
    }

    const errors: string[] = [];
    if (mediaType === 'CAROUSEL' && children.length === 0) {
        errors.push('Carousel item has no children');
    }
    if (!mediaUrl && children.length === 0) {
        errors.push('Media URL missing');
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        selectedIndex,
        selectedContent,
        nextState,
        mediaUrl,
        mediaType,
        caption,
        locationId,
        shareToFeed,
        thumbnailUrl,
        children,
        collaborators,
        audioConfiguration,
        userTags,
        preview: {
            mediaUrl,
            mediaType,
            caption,
            locationId,
            shareToFeed,
            thumbnailUrl,
            children,
            collaborators,
            audioConfiguration,
            userTags,
        },
        config,
    };
}
