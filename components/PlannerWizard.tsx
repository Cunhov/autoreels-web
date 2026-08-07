'use client';
import { useState, useEffect, useMemo } from 'react';
import { getPublicUrl } from '@/lib/storage';
import { createVideoThumbnailFile } from '@/lib/video-thumbnail';
import { useSession } from 'next-auth/react';
import { X, ChevronRight, ChevronLeft, Calendar, Clock, Instagram, Layers, ArrowUpDown, Check, Image as ImageIcon, Film } from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import MediaUploader from './MediaUploader';
import ContentLibrary from './ContentLibrary';

interface Channel {
    id: string;
    name: string;
    account_id: string;
}

interface PlannerWizardProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    initialData?: any;
}

const STEPS = [
    { id: 'basics', title: 'Basics' },
    { id: 'accounts', title: 'Accounts' },
    { id: 'content', title: 'Content' },
    { id: 'schedule', title: 'Schedule' },
    { id: 'sorting', title: 'Sorting' }
];

// Shape of an entry in planner config.content (library items, legacy uploads, carousels).
interface ContentEntry {
    type?: string;
    id?: string;
    folder_id?: string;
    url?: string;
    children_urls?: Array<{ url?: string; id?: string; type?: string }>;
    media_type?: string;
    [key: string]: unknown;
}

export default function PlannerWizard({ isOpen, onClose, onSuccess, initialData }: PlannerWizardProps) {
    const [step, setStep] = useState(0);
    const [loading, setLoading] = useState(false);
    const { data: session } = useSession();
    const [uploading, setUploading] = useState(false);
    const [channels, setChannels] = useState<Channel[]>([]);

    // Form State
    const [name, setName] = useState('');
    const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
    const [files, setFiles] = useState<File[]>([]);
    const [selectedContentIds, setSelectedContentIds] = useState<string[]>([]);
    const [contentTab, setContentTab] = useState<'upload' | 'library'>('upload');
    const [frequencyValue, setFrequencyValue] = useState(1);
    const [frequencyUnit, setFrequencyUnit] = useState('hours'); // minutes, hours, days
    const [timezone, setTimezone] = useState('America/Sao_Paulo');
    const [startTime, setStartTime] = useState('');
    const [sleepEnabled, setSleepEnabled] = useState(false);
    const [sleepStart, setSleepStart] = useState('00:00');
    const [sleepEnd, setSleepEnd] = useState('06:00');
    const [sortOrder, setSortOrder] = useState('random_loop'); // random_loop, old_to_new, new_to_old

    // Advanced Content Settings
    const [mediaType, setMediaType] = useState<'REELS' | 'STORIES' | 'IMAGE' | 'CAROUSEL'>('REELS');
    const [shareToFeed, setShareToFeed] = useState(true);
    const [isCarousel, setIsCarousel] = useState(false);
    const [caption, setCaption] = useState('');
    const [location, setLocation] = useState('');
    const [captionFallback, setCaptionFallback] = useState('');
    const [titleFallback, setTitleFallback] = useState('');
    const [collaborators, setCollaborators] = useState('');
    const [userTags, setUserTags] = useState('');
    const [audioId, setAudioId] = useState('');
    const [audioVolume, setAudioVolume] = useState(80);
    const [videoVolume, setVideoVolume] = useState(20);
    const [formError, setFormError] = useState('');
    // Count of existing content items that the UI cannot represent (legacy direct
    // uploads). They are preserved as-is on save so editing a planner never loses them.
    const [preservedCount, setPreservedCount] = useState(0);

    const selectedChannelNames = useMemo(() => {
        return selectedChannels
            .map(id => channels.find(channel => channel.id === id)?.name)
            .filter(Boolean) as string[];
    }, [channels, selectedChannels]);

    const scheduleSummary = useMemo(() => {
        const frequency = `${frequencyValue} ${frequencyUnit}`;
        const sleep = sleepEnabled ? `${sleepStart} - ${sleepEnd}` : 'off';
        const start = startTime ? new Date(startTime).toLocaleString() : 'immediately';
        const contentCount = files.length + selectedContentIds.length + preservedCount;
        return {
            frequency,
            sleep,
            start,
            contentCount,
            channels: selectedChannelNames.length,
        };
    }, [frequencyValue, frequencyUnit, sleepEnabled, sleepStart, sleepEnd, startTime, files.length, selectedContentIds.length, preservedCount, selectedChannelNames.length]);

    useEffect(() => {
        if (isOpen) {
            fetchChannels();
            setStep(0);

            if (initialData) {
                setName(initialData.name || '');
                setSelectedChannels(initialData.channel_ids || []);

                // Defensive parse: config may arrive as a (double) JSON string from the API.
                let config = initialData.config || {};
                if (typeof config === 'string') {
                    try {
                        config = JSON.parse(config);
                        if (typeof config === 'string') config = JSON.parse(config);
                    } catch {
                        config = {};
                    }
                }
                setFrequencyValue(config.frequency?.value || 1);
                setFrequencyUnit(config.frequency?.unit || 'hours');
                setTimezone(config.timezone || 'America/Sao_Paulo');
                setStartTime(config.start_time || '');
                setSortOrder(config.sort_order || 'random_loop');

                if (config.sleep_schedule) {
                    setSleepEnabled(true);
                    setSleepStart(config.sleep_schedule.start || '00:00');
                    setSleepEnd(config.sleep_schedule.end || '06:00');
                } else {
                    setSleepEnabled(false);
                    setSleepStart('00:00');
                    setSleepEnd('06:00');
                }

                // Load existing content
                const content = config.content || [];
                if (content.length > 0) {
                    // Items the UI can represent: library items and folder-based carousels.
                    // Everything else (legacy direct uploads, type:'config') is preserved as-is.
                    const libIds: string[] = [];
                    let legacyCount = 0;
                    for (const c of content) {
                        if (c.type === 'library_item' || c.folder_id) {
                            libIds.push(c.id || c.folder_id);
                        } else {
                            legacyCount++;
                        }
                    }
                    setSelectedContentIds(libIds);
                    setFiles([]);
                    setPreservedCount(legacyCount);
                    setContentTab(libIds.length > 0 ? 'library' : 'upload');

                    if (content[0]?.media_type === 'CAROUSEL') {
                        setIsCarousel(true);
                        setMediaType('CAROUSEL');
                        setShareToFeed(true);
                    } else {
                        setIsCarousel(false);
                        setMediaType(content[0]?.media_type || 'REELS');
                        setShareToFeed(content[0]?.share_to_feed !== false);
                    }
                    setCaption(content[0]?.caption || '');
                    setCaptionFallback(content[0]?.caption_fallback || '');
                    setTitleFallback(content[0]?.title_fallback || '');
                    setLocation(content[0]?.location_id || '');
                    // collaborators/user_tags may be stored as arrays (comma input => array of usernames)
                    const storedCollabs = content[0]?.collaborators;
                    setCollaborators(Array.isArray(storedCollabs) ? storedCollabs.join(', ') : (storedCollabs || ''));
                    const storedTags = content[0]?.user_tags;
                    setUserTags(Array.isArray(storedTags) ? storedTags.join(', ') : (storedTags || ''));
                    const audioConfig = content[0]?.audio_configuration || {};
                    setAudioId(audioConfig.audio_id || '');
                    setAudioVolume(audioConfig.audio_volume !== undefined ? audioConfig.audio_volume : 80);
                    setVideoVolume(audioConfig.video_volume !== undefined ? audioConfig.video_volume : 20);
                } else {
                    setSelectedContentIds([]);
                    setFiles([]);
                    setPreservedCount(0);
                    setContentTab('upload');
                    setIsCarousel(false);
                    setMediaType('REELS');
                    setShareToFeed(true);
                    setCaption('');
                    setLocation('');
                    setCollaborators('');
                    setUserTags('');
                    setAudioId('');
                    setAudioVolume(80);
                    setVideoVolume(20);
                }
            } else {
                // Full reset for new planner
                setName('');
                setSelectedChannels([]);
                setSelectedContentIds([]);
                setFiles([]);
                setPreservedCount(0);
                setFrequencyValue(1);
                setFrequencyUnit('hours');
                setTimezone('America/Sao_Paulo');
                setStartTime('');
                setSleepEnabled(false);
                setSleepStart('00:00');
                setSleepEnd('06:00');
                setSortOrder('random_loop');
                setCaption('');
                setIsCarousel(false);
                setMediaType('REELS');
                setShareToFeed(true);
                setLocation('');
                setCollaborators('');
                setUserTags('');
                setAudioId('');
                setAudioVolume(80);
                setVideoVolume(20);
                setContentTab('upload');
            }
        }
    }, [isOpen, initialData]);

    // When files change, auto-detect media type if simple
    useEffect(() => {
        if (files.length > 0) {
            const hasVideo = files.some(f => f.type.startsWith('video/'));
            const hasImage = files.some(f => f.type.startsWith('image/'));

            if (hasVideo && !hasImage) setMediaType('REELS');
            else if (!hasVideo && hasImage) setMediaType('IMAGE');

            if (files.length > 1) {
                // Propose Carousel if multiple images, but user must confirm
            }
        }
    }, [files]);

    async function fetchChannels() {
        const res = await fetch('/api/channels');
        const data = await res.json();
        setChannels(Array.isArray(data) ? data.filter((c: any) => c.platform === 'instagram' && c.status === 'active') : []);
    }

    const handleNext = () => {
        if (step < STEPS.length - 1) setStep(step + 1);
    };

    const handleBack = () => {
        if (step > 0) setStep(step - 1);
    };

    const toggleChannel = (id: string) => {
        if (selectedChannels.includes(id)) {
            setSelectedChannels(selectedChannels.filter(c => c !== id));
        } else {
            setSelectedChannels([...selectedChannels, id]);
        }
    };

    const uploadFiles = async (userId: string) => {
        const uploadedItems: { url: string, type: string, thumbnail_url?: string | null }[] = [];

        for (const file of files) {
            try {
                const fileExt = file.name.split('.').pop();
                const fileName = `${userId}/${Math.random().toString(36).substring(2)}.${fileExt}`;
                const fileType = file.type.startsWith('image/') ? 'image' : 'video';

                // Upload via chunked local API
                const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB chunks
                const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

                for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                    const start = chunkIndex * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, file.size);
                    const chunk = file.slice(start, end);

                    let retries = 0;
                    let success = false;

                    while (!success && retries < 3) {
                        try {
                            const uploadRes = await fetch('/api/upload-chunk', {
                                method: 'POST',
                                headers: {
                                    'x-chunk-index': chunkIndex.toString(),
                                    'x-total-chunks': totalChunks.toString(),
                                    'x-file-name': fileName
                                },
                                body: chunk,
                            });

                            if (!uploadRes.ok) {
                                const err = await uploadRes.json().catch(() => ({}));
                                throw new Error((err as any).error || `Failed to upload chunk ${chunkIndex} for ${file.name}`);
                            }
                            success = true;
                        } catch (err) {
                            retries++;
                            if (retries >= 3) throw err;
                            await new Promise(r => setTimeout(r, 1000 * retries));
                        }
                    }
                }

                const publicUrl = getPublicUrl(fileName);
                let thumbnailUrl: string | null = null;

                if (fileType === 'video') {
                    const thumbnailFile = await createVideoThumbnailFile(file);
                    if (thumbnailFile) {
                        const thumbnailPath = `${userId}/thumbnails/${thumbnailFile.name}`;
                        const thumbnailForm = new FormData();
                        thumbnailForm.append('file', thumbnailFile);
                        thumbnailForm.append('path', thumbnailPath);

                        const thumbRes = await fetch('/api/upload', {
                            method: 'POST',
                            body: thumbnailForm,
                        });

                        if (thumbRes.ok) {
                            thumbnailUrl = getPublicUrl(thumbnailPath);
                        }
                    }
                }

                uploadedItems.push({ url: publicUrl, type: fileType, thumbnail_url: thumbnailUrl });
            } catch (err) {
                console.error(`Error processing ${file.name}:`, err);
            }
        }
        return uploadedItems;
    };

    const handleSubmit = async () => {
        setFormError('');

        // Validate sleep schedule: a zero-length window silently disables the timer.
        if (sleepEnabled && sleepStart === sleepEnd) {
            setFormError('Sleep start and end must be different times.');
            return;
        }

        // Validate frequency: NaN/0/negative would spam or silently kill the planner.
        const freqValue = Number.isFinite(frequencyValue) && frequencyValue >= 1 ? frequencyValue : 10;
        if (freqValue !== frequencyValue) {
            setFormError('Invalid posting interval — using 10.');
        }

        setLoading(true);
        setUploading(true);
        try {
            if (!session?.user) throw new Error('Not authenticated');

            // 1. Upload New Files
            const uploadedItems = await uploadFiles((session.user as any).id);

            // Comma-separated usernames => array of username strings (the cron
            // converts this to the Instagram Graph API object format).
            const collaboratorsList = collaborators
                ? collaborators.split(',').map(s => s.trim()).filter(Boolean)
                : null;
            const userTagsList = userTags
                ? userTags.split(',').map(s => s.trim()).filter(Boolean)
                : null;

            // 2. Prepare Content Array
            let content: ContentEntry[] = [];

            if (isCarousel && selectedContentIds.length > 0) {
                // Carousel from folders: Each folder becomes its own carousel post
                for (const folderId of selectedContentIds) {
                    content.push({
                        type: 'library_item',
                        id: folderId,
                        media_type: 'CAROUSEL',
                        caption,
                        caption_fallback: captionFallback,
                        title_fallback: titleFallback,
                        location_id: location,
                        collaborators: collaboratorsList,
                        user_tags: userTagsList
                    });
                }

                // If we also have direct uploads that form a carousel
                if (uploadedItems.length >= 2) {
                    content.push({
                        type: 'config',
                        media_type: 'CAROUSEL',
                        children_urls: uploadedItems,
                        caption,
                        caption_fallback: captionFallback,
                        title_fallback: titleFallback,
                        location_id: location,
                        collaborators: collaboratorsList,
                        user_tags: userTagsList
                    });
                }
            } else if (isCarousel && uploadedItems.length >= 2) {
                // Carousel from direct uploads
                content = [{
                    type: 'config',
                    media_type: 'CAROUSEL',
                    children_urls: uploadedItems,
                    caption,
                    caption_fallback: captionFallback,
                    title_fallback: titleFallback,
                    location_id: location,
                    collaborators: collaboratorsList,
                    user_tags: userTagsList
                }];
            } else {
                // Separate Posts (Reels, Images, etc)
                const audioConfig = mediaType === 'REELS' && audioId ? {
                    audio_id: audioId,
                    audio_volume: audioVolume,
                    video_volume: videoVolume
                } : null;

                content = [
                    ...uploadedItems.map(item => ({
                        ...item,
                        media_type: mediaType,
                        share_to_feed: shareToFeed,
                        caption,
                        caption_fallback: captionFallback,
                        title_fallback: titleFallback,
                        location_id: location,
                        collaborators: collaboratorsList,
                        user_tags: mediaType === 'IMAGE' ? userTagsList : null,
                        audio_configuration: audioConfig
                    })),
                    ...selectedContentIds.map(id => ({
                        type: 'library_item',
                        id,
                        media_type: mediaType,
                        share_to_feed: shareToFeed,
                        caption,
                        caption_fallback: captionFallback,
                        title_fallback: titleFallback,
                        location_id: location,
                        collaborators: collaboratorsList,
                        user_tags: mediaType === 'IMAGE' ? userTagsList : null,
                        audio_configuration: audioConfig
                    }))
                ];
            }

            // Preserve existing content items that the UI cannot represent (legacy
            // direct uploads / type:'config'). Without this, editing a planner
            // silently dropped those items from the posting queue.
            const existingContentRaw = initialData?.config?.content || [];
            let existingContent = existingContentRaw;
            if (typeof existingContent === 'string') {
                try { existingContent = JSON.parse(existingContent); } catch { /* ignore */ }
            }
            const legacyItems = (Array.isArray(existingContent) ? existingContent : []).filter((c: ContentEntry) => {
                if (c.type === 'library_item') return false;      // represented via selection
                if (c.folder_id) return false;                     // represented via folder selection
                return true;                                       // legacy upload/config: preserve
            });
            content = [...legacyItems, ...content];

            // 3. Prepare Config in JSON
            // Compare CONTENT IDENTITY (which items, not settings like caption) —
            // state (published_indexes/last_index) only needs resetting when the
            // item composition actually changes. Editing a name/caption alone now
            // preserves the planner's progress.
            const contentIdentity = (list: ContentEntry[]) => list.map((c) => {
                if (c.type === 'library_item') return `lib:${c.id}`;
                if (c.folder_id) return `lib:${c.folder_id}`;
                if (c.url) return `url:${c.url}`;
                if (c.children_urls) return `carousel:${c.children_urls.map((u) => u.url || u.id).join('|')}`;
                return JSON.stringify(c);
            });
            const existingContentList = Array.isArray(existingContent) ? existingContent : [];
            const contentChanged =
                JSON.stringify(contentIdentity(content)) !== JSON.stringify(contentIdentity(existingContentList));
            const existingState = initialData?.config?.state || {};

            // Reset state if content changed
            const preservedState = contentChanged ? {} : existingState;

            const plannerConfig = {
                frequency: {
                    value: freqValue,
                    unit: frequencyUnit
                },
                timezone,
                // Convert local datetime string to an absolute ISO timestamp so the
                // server (UTC) interprets the user's local wall-clock correctly.
                start_time: startTime ? new Date(startTime).toISOString() : '',
                sleep_schedule: sleepEnabled ? { start: sleepStart, end: sleepEnd } : null,
                sort_order: sortOrder,
                content,
                state: preservedState
            };

            // 4. Update or Insert Planner
            const plannerId = initialData?.id;
            const res = await fetch(plannerId ? `/api/planners/${plannerId}` : '/api/planners', {
                method: plannerId ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    channel_ids: selectedChannels,
                    config: plannerConfig,
                    ...(plannerId ? {} : { status: 'active' })
                }),
            });

            if (!res.ok) throw new Error('Failed to save planner');

            onSuccess();
            onClose();
        } catch (error) {
            console.error(error);
            alert('Failed to create planner');
        } finally {
            setLoading(false);
            setUploading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-ios-card w-full max-w-2xl rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[95vh]">
                {/* Header */}
                <div className="px-6 py-4 border-b border-ios-separator flex items-center justify-between bg-ios-background">
                    <div>
                        <h2 className="text-[17px] font-semibold text-ios-text">New Planner</h2>
                        <div className="flex items-center gap-2 text-xs text-ios-secondary mt-1">
                            {STEPS.map((s, idx) => (
                                <div key={s.id} className={`flex items-center gap-1 ${step === idx ? 'text-ios-blue font-bold' : ''}`}>
                                    <span className={`w-4 h-4 rounded-full flex items-center justify-center ${step === idx ? 'bg-ios-blue text-white' : step > idx ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                                        {step > idx ? <Check size={10} /> : idx + 1}
                                    </span>
                                    {s.title}
                                </div>
                            ))}
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1 rounded-full hover:bg-black/5 text-ios-secondary transition-colors">
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 bg-ios-background/50">

                    {/* Step 0: Basics */}
                    {step === 0 && (
                        <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
                            <label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide">Planner Name</label>
                            <input
                                type="text"
                                autoFocus
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="My Awesome Scheduler"
                                className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue"
                            />
                            <label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide mt-4">Start When?</label>
                            <input
                                type="datetime-local"
                                value={startTime}
                                onChange={(e) => setStartTime(e.target.value)}
                                className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue"
                            />
                        </div>
                    )}

                    {/* Step 1: Accounts */}
                    {step === 1 && (
                        <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
                            <div className="grid grid-cols-1 gap-3">
                                {channels.map(channel => (
                                    <div
                                        key={channel.id}
                                        onClick={() => toggleChannel(channel.id)}
                                        className={`p-4 rounded-xl border flex items-center gap-4 cursor-pointer transition-all ${selectedChannels.includes(channel.id)
                                            ? 'bg-ios-blue/10 border-ios-blue'
                                            : 'bg-ios-card border-ios-separator hover:border-ios-blue/30'
                                            }`}
                                    >
                                        <div className={`w-6 h-6 rounded-full border flex items-center justify-center ${selectedChannels.includes(channel.id)
                                            ? 'bg-ios-blue border-ios-blue text-white'
                                            : 'bg-transparent border-gray-300'
                                            }`}>
                                            {selectedChannels.includes(channel.id) && <Check size={14} />}
                                        </div>
                                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-yellow-400 via-red-500 to-purple-500 p-[2px]">
                                            <div className="w-full h-full rounded-full bg-white flex items-center justify-center">
                                                <Instagram size={20} className="text-black" />
                                            </div>
                                        </div>
                                        <div>
                                            <h4 className="font-semibold text-ios-text">{channel.name}</h4>
                                            <p className="text-xs text-ios-secondary font-mono">{channel.account_id}</p>
                                        </div>
                                    </div>
                                ))}
                                {channels.length === 0 && (
                                    <div className="text-center py-10 text-ios-secondary">
                                        No Instagram channels found. Please add a channel first.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Step 2: Content */}
                    {step === 2 && (
                        <div className="animate-in fade-in slide-in-from-right-4 duration-300 flex flex-col h-full space-y-4">

                            {/* Tabs */}
                            <div className="flex gap-2 p-1 bg-ios-separator/50 rounded-lg shrink-0">
                                <button
                                    onClick={() => setContentTab('upload')}
                                    className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-all ${contentTab === 'upload' ? 'bg-white shadow-sm text-ios-text' : 'text-ios-secondary hover:text-ios-text'
                                        }`}
                                >
                                    Upload New
                                </button>
                                <button
                                    onClick={() => setContentTab('library')}
                                    className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-all ${contentTab === 'library' ? 'bg-white shadow-sm text-ios-text' : 'text-ios-secondary hover:text-ios-text'
                                        }`}
                                >
                                    From Library
                                </button>
                            </div>

                            {/* Uploader / Library */}
                            <div className="flex-1 overflow-hidden min-h-[300px]">
                                {contentTab === 'upload' ? (
                                    <MediaUploader files={files} onFilesChange={setFiles} />
                                ) : (
                                    <div className="h-full border border-ios-separator rounded-xl overflow-hidden min-h-[300px]">
                                        {isCarousel && mediaType === 'IMAGE' && (
                                            <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-xs p-2 border-b border-blue-100 dark:border-blue-900/30">
                                                📂 Select a folder to post as carousel. Images will be posted in alphabetical/numerical order.
                                            </div>
                                        )}
                                        <ContentLibrary
                                            mode="select"
                                            initialSelection={selectedContentIds}
                                            onSelectionChange={setSelectedContentIds}
                                            allowedTypes={isCarousel && mediaType === 'IMAGE' ? ['carousel_folder'] : ['video', 'image', 'carousel_folder']}
                                            disableUrlNavigation={true}
                                        />
                                    </div>
                                )}
                            </div>

                            <p className="text-xs text-ios-secondary">
                                {isCarousel && mediaType === 'IMAGE'
                                    ? `${selectedContentIds.length} folder(s) selected for carousel.`
                                    : `${files.length} new files, ${selectedContentIds.length} library items selected.`
                                }
                                {preservedCount > 0 && (
                                    <span className="text-amber-600 dark:text-amber-400">
                                        {' '}· {preservedCount} legacy upload item(s) will be preserved on save.
                                    </span>
                                )}
                            </p>

                            {/* Post Configuration */}
                            <div className="bg-ios-card border border-ios-separator rounded-xl p-4 space-y-4 shadow-sm">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-[13px] font-bold text-ios-secondary uppercase tracking-wide">Post Configuration</h3>
                                    {(files.length + selectedContentIds.length > 1) && (
                                        <div
                                            onClick={() => {
                                                const next = !isCarousel;
                                                setIsCarousel(next);
                                                setMediaType(next ? 'CAROUSEL' : 'REELS');
                                            }}
                                            className="flex items-center gap-2 cursor-pointer"
                                        >
                                            <div className={`w-8 h-5 rounded-full relative transition-colors ${isCarousel ? 'bg-ios-blue' : 'bg-gray-300'}`}>
                                                <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-transform ${isCarousel ? 'translate-x-[14px]' : 'translate-x-1'}`} />
                                            </div>
                                            <span className="text-xs text-ios-text font-medium">Group as Carousel</span>
                                        </div>
                                    )}
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div className={mediaType === 'REELS' ? '' : 'col-span-2'}>
                                        <label className="text-xs font-medium text-ios-text mb-1.5 block">Media Type</label>
                                        <select
                                            value={mediaType}
                                            onChange={(e) => {
                                                const v = e.target.value as typeof mediaType;
                                                setMediaType(v);
                                                setIsCarousel(v === 'CAROUSEL');
                                            }}
                                            className="w-full bg-ios-background border border-ios-separator rounded-lg px-2 py-2 text-sm focus:border-ios-blue outline-none"
                                        >
                                            <option value="REELS">Reels</option>
                                            <option value="IMAGE">Post / Image</option>
                                            <option value="CAROUSEL">Carousel</option>
                                            <option value="STORIES">Story</option>
                                        </select>
                                    </div>
                                    {(mediaType === 'REELS' && !isCarousel) && (
                                        <div className="flex flex-col justify-center">
                                            <label className="text-xs font-medium text-ios-text mb-1.5 block">Options</label>
                                            <div
                                                onClick={() => setShareToFeed(!shareToFeed)}
                                                className="flex items-center gap-2 cursor-pointer"
                                            >
                                                <div className={`w-4 h-4 border rounded flex items-center justify-center ${shareToFeed ? 'bg-ios-blue border-ios-blue' : 'border-gray-300'}`}>
                                                    {shareToFeed && <Check size={10} className="text-white" />}
                                                </div>
                                                <span className="text-sm text-ios-text">Share to Feed</span>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div>
                                    <div className="flex justify-between items-center mb-1.5">
                                        <label className="text-xs font-medium text-ios-text block">Caption</label>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setCaption(prev => prev + ' {post_title}')}
                                                className="text-[10px] bg-ios-blue/10 text-ios-blue px-2 py-0.5 rounded-full hover:bg-ios-blue/20 transition-colors"
                                            >
                                                + Title
                                            </button>
                                            <button
                                                onClick={() => setCaption(prev => prev + ' {post_caption}')}
                                                className="text-[10px] bg-ios-blue/10 text-ios-blue px-2 py-0.5 rounded-full hover:bg-ios-blue/20 transition-colors"
                                            >
                                                + Caption
                                            </button>
                                        </div>
                                    </div>
                                    <textarea
                                        value={caption}
                                        onChange={(e) => setCaption(e.target.value)}
                                        className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm h-24 resize-none focus:border-ios-blue outline-none placeholder:text-gray-400 font-mono"
                                        placeholder="Write a caption... Use tags for dynamic content."
                                    />
                                </div>

                                <div className="space-y-4 pt-4 border-t border-ios-separator">
                                    <div>
                                        <label className="text-xs font-medium text-ios-text mb-1.5 block">Fallback Title</label>
                                        <p className="text-[11px] text-gray-400 mb-2">Used if the selected content has an empty title and {"{post_title}"} is used.</p>
                                        <input
                                            value={titleFallback}
                                            onChange={(e) => setTitleFallback(e.target.value)}
                                            className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
                                            placeholder="Example: AutoReels Magic"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-medium text-ios-text mb-1.5 block">Fallback Caption</label>
                                        <p className="text-[11px] text-gray-400 mb-2">Used if the selected content has an empty caption and {"{post_caption}"} is used.</p>
                                        <textarea
                                            value={captionFallback}
                                            onChange={(e) => setCaptionFallback(e.target.value)}
                                            className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm h-16 resize-none focus:border-ios-blue outline-none placeholder:text-gray-400"
                                            placeholder="Example: Check out this amazing content!"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <div>
                                        <label className="text-xs font-medium text-ios-text mb-1.5 block">Location ID (Optional)</label>
                                        <input
                                            value={location}
                                            onChange={(e) => setLocation(e.target.value)}
                                            className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
                                            placeholder="Instagram Location ID"
                                        />
                                    </div>

                                    {mediaType !== 'STORIES' && (
                                        <div>
                                            <label className="text-xs font-medium text-ios-text mb-1.5 block">Collaborators (Optional)</label>
                                            <input
                                                value={collaborators}
                                                onChange={(e) => setCollaborators(e.target.value)}
                                                className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
                                                placeholder="e.g. user1, user2"
                                            />
                                            <p className="text-[10px] text-gray-400 mt-1">Comma-separated Instagram usernames to invite as collaborators.</p>
                                        </div>
                                    )}

                                    {(mediaType === 'IMAGE' || mediaType === 'CAROUSEL') && (
                                        <div>
                                            <label className="text-xs font-medium text-ios-text mb-1.5 block">User Tags (Optional)</label>
                                            <input
                                                value={userTags}
                                                onChange={(e) => setUserTags(e.target.value)}
                                                className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
                                                placeholder="e.g. user1, user2"
                                            />
                                            <p className="text-[10px] text-gray-400 mt-1">Comma-separated Instagram usernames to tag on the image.</p>
                                        </div>
                                    )}

                                    {mediaType === 'REELS' && (
                                        <div className="space-y-3 p-3 bg-ios-gray-6 rounded-xl border border-ios-separator">
                                            <span className="text-xs font-semibold text-ios-text block">Meta Audio Settings (Optional)</span>
                                            <div>
                                                <label className="text-[11px] font-medium text-ios-text mb-1 block">Audio ID</label>
                                                <input
                                                    value={audioId}
                                                    onChange={(e) => setAudioId(e.target.value)}
                                                    className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-xs focus:border-ios-blue outline-none placeholder:text-gray-400"
                                                    placeholder="Meta Audio Track ID"
                                                />
                                            </div>
                                            {audioId && (
                                                <div className="grid grid-cols-2 gap-3">
                                                    <div>
                                                        <label className="text-[10px] font-medium text-ios-text mb-1 block">Music Volume ({audioVolume}%)</label>
                                                        <input
                                                            type="range"
                                                            min="0"
                                                            max="100"
                                                            value={audioVolume}
                                                            onChange={(e) => setAudioVolume(parseInt(e.target.value))}
                                                            className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-ios-blue"
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-[10px] font-medium text-ios-text mb-1 block">Video Volume ({videoVolume}%)</label>
                                                        <input
                                                            type="range"
                                                            min="0"
                                                            max="100"
                                                            value={videoVolume}
                                                            onChange={(e) => setVideoVolume(parseInt(e.target.value))}
                                                            className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-ios-blue"
                                                        />
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Step 3: Schedule */}
                    {step === 3 && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                            {/* ... Configs ... */}
                            <div>
                                <label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide mb-2">Posting Interval</label>
                                <div className="flex gap-4">
                                    <input
                                        type="number"
                                        min="1"
                                        value={frequencyValue}
                                        onChange={(e) => {
                                            const v = parseInt(e.target.value, 10);
                                            // Clamp: NaN / < 1 would silently break or spam the planner.
                                            setFrequencyValue(Number.isFinite(v) && v >= 1 ? v : 1);
                                        }}
                                        className="w-24 bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue"
                                    />
                                    <select
                                        value={frequencyUnit}
                                        onChange={(e) => setFrequencyUnit(e.target.value)}
                                        className="flex-1 bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue"
                                    >
                                        <option value="minutes">Minutes</option>
                                        <option value="hours">Hours</option>
                                        <option value="days">Days</option>
                                        <option value="weeks">Weeks</option>
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide mb-2">Timezone</label>
                                <select
                                    value={timezone}
                                    onChange={(e) => setTimezone(e.target.value)}
                                    className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue"
                                >
                                    {Intl.supportedValuesOf('timeZone').map(tz => (
                                        <option key={tz} value={tz}>{tz}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="pt-4 border-t border-ios-separator">
                                <div className="flex items-center justify-between mb-4">
                                    <label className="text-[17px] font-medium text-ios-text flex items-center gap-2">
                                        <Clock size={18} className="text-ios-blue" />
                                        Sleep Timer
                                    </label>
                                    <div
                                        onClick={() => setSleepEnabled(!sleepEnabled)}
                                        className={`w-12 h-7 rounded-full transition-colors cursor-pointer relative ${sleepEnabled ? 'bg-green-500' : 'bg-gray-300'}`}
                                    >
                                        <div className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform shadow-sm ${sleepEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </div>
                                </div>

                                {sleepEnabled && (
                                    <div className="grid grid-cols-2 gap-4 animate-in slide-in-from-top-2">
                                        <div>
                                            <span className="text-xs text-ios-secondary mb-1 block">From</span>
                                            <input
                                                type="time"
                                                value={sleepStart}
                                                onChange={(e) => { setSleepStart(e.target.value); setFormError(''); }}
                                                className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-2"
                                            />
                                        </div>
                                        <div>
                                            <span className="text-xs text-ios-secondary mb-1 block">To</span>
                                            <input
                                                type="time"
                                                value={sleepEnd}
                                                onChange={(e) => { setSleepEnd(e.target.value); setFormError(''); }}
                                                className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-2"
                                            />
                                        </div>
                                        {sleepEnabled && sleepStart === sleepEnd && (
                                            <p className="col-span-2 text-xs text-ios-red">
                                                Sleep start and end must be different times.
                                            </p>
                                        )}
                                    </div>
                                )}

                                {formError && (
                                    <p className="text-xs text-ios-red mt-2">{formError}</p>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Step 4: Sorting */}
                    {step === 4 && (
                        <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                            <label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide mb-3">Sort Order</label>
                            <div className="grid grid-cols-1 gap-2">
                                {[
                                    { id: 'random_loop', label: 'Infinite Random', desc: 'Posts randomly without duplicates. Repeats automatically once all items are posted.' },
                                    { id: 'old_to_new', label: 'Oldest to Newest', desc: 'Posts items in chronological order. Repeats once the end is reached.' },
                                    { id: 'new_to_old', label: 'Newest to Oldest', desc: 'Posts items in reverse chronological order. Repeats once the end is reached.' },
                                ].map(option => (
                                    <div
                                        key={option.id}
                                        onClick={() => setSortOrder(option.id)}
                                        className={`p-4 rounded-xl border cursor-pointer transition-all ${sortOrder === option.id
                                            ? 'bg-ios-blue/10 border-ios-blue ring-1 ring-ios-blue'
                                            : 'bg-ios-card border-ios-separator hover:border-ios-blue/30'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between mb-1">
                                            <span className="font-semibold text-ios-text">{option.label}</span>
                                            {sortOrder === option.id && <Check size={18} className="text-ios-blue" />}
                                        </div>
                                        <p className="text-xs text-ios-secondary">{option.desc}</p>
                                    </div>
                                ))}
                            </div>

                            <div className="mt-6 bg-ios-card border border-ios-separator rounded-xl p-4 space-y-3">
                                <h3 className="text-[13px] font-bold text-ios-secondary uppercase tracking-wide">Preview</h3>
                                <div className="grid gap-2 text-sm text-ios-text">
                                    <div className="flex items-center justify-between gap-4">
                                        <span className="text-ios-secondary">Name</span>
                                        <span className="font-medium truncate text-right">{name || 'Untitled planner'}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <span className="text-ios-secondary">Channels</span>
                                        <span className="font-medium text-right">{selectedChannelNames.length > 0 ? selectedChannelNames.join(', ') : `${scheduleSummary.channels} selected`}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <span className="text-ios-secondary">Content</span>
                                        <span className="font-medium text-right">{scheduleSummary.contentCount} item(s)</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <span className="text-ios-secondary">Frequency</span>
                                        <span className="font-medium text-right">Every {scheduleSummary.frequency}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <span className="text-ios-secondary">Start</span>
                                        <span className="font-medium text-right">{scheduleSummary.start}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <span className="text-ios-secondary">Sleep</span>
                                        <span className="font-medium text-right">{scheduleSummary.sleep}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-4">
                                        <span className="text-ios-secondary">Media</span>
                                        <span className="font-medium text-right">{isCarousel ? 'Carousel' : mediaType === 'REELS' ? 'Reels' : mediaType === 'STORIES' ? 'Story' : 'Image'}{mediaType === 'REELS' && !shareToFeed ? ' - feed off' : ''}</span>
                                    </div>
                                </div>
                                {location ? (
                                    <p className="text-[11px] text-ios-secondary">Location ID configured.</p>
                                ) : null}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer Buttons */}
                <div className="p-4 border-t border-ios-separator bg-ios-background flex justify-between items-center">
                    <IOSButton
                        variant="secondary"
                        onClick={handleBack}
                        disabled={step === 0 || loading}
                        className={step === 0 ? 'invisible' : ''}
                    >
                        <ChevronLeft size={18} className="mr-1" /> Back
                    </IOSButton>

                    {step === STEPS.length - 1 ? (
                        <IOSButton
                            variant="primary"
                            onClick={handleSubmit}
                            disabled={loading}
                            className="bg-green-600 hover:bg-green-700 min-w-[120px] justify-center"
                        >
                            {loading ? (uploading ? 'Uploading...' : 'Creating...') : 'Finish'}
                        </IOSButton>
                    ) : (
                        <IOSButton
                            variant="primary"
                            onClick={handleNext}
                            className="min-w-[120px] justify-center"
                            disabled={
                                (step === 0 && !name) ||
                                (step === 1 && selectedChannels.length === 0) ||
                                (step === 2 && files.length === 0 && selectedContentIds.length === 0 && preservedCount === 0) ||
                                (step === 3 && sleepEnabled && sleepStart === sleepEnd)
                            }
                        >
                            Next <ChevronRight size={18} className="ml-1" />
                        </IOSButton>
                    )}
                </div>
            </div>
        </div>
    );
}
