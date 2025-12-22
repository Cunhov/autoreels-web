'use client';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
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

export default function PlannerWizard({ isOpen, onClose, onSuccess, initialData }: PlannerWizardProps) {
    const [step, setStep] = useState(0);
    const [loading, setLoading] = useState(false);
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
    const [mediaType, setMediaType] = useState<'REELS' | 'STORIES' | 'IMAGE' | 'CAROUSEL' | 'VIDEO'>('REELS');
    const [shareToFeed, setShareToFeed] = useState(true);
    const [isCarousel, setIsCarousel] = useState(false);
    const [caption, setCaption] = useState('');
    const [location, setLocation] = useState('');

    useEffect(() => {
        if (isOpen) {
            fetchChannels();
            setStep(0);

            if (initialData) {
                setName(initialData.name || '');
                setSelectedChannels(initialData.channel_ids || []);

                const config = initialData.config || {};
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
                }

                // Load existing content (we only show IDs for library items if possible)
                const content = config.content || [];
                if (content.length > 0) {
                    const libIds = content.filter((c: any) => c.type === 'library_item').map((c: any) => c.id);
                    setSelectedContentIds(libIds);
                    setContentTab('library');

                    // Detect if it was a carousel
                    if (content[0]?.media_type === 'CAROUSEL') {
                        setIsCarousel(true);
                        setMediaType('CAROUSEL');
                        setCaption(content[0].caption || '');
                        setLocation(content[0].location_id || '');
                    } else {
                        setMediaType(content[0]?.media_type || 'REELS');
                        setShareToFeed(content[0]?.share_to_feed !== false);
                        setCaption(content[0]?.caption || '');
                        setLocation(content[0]?.location_id || '');
                    }
                }
            } else {
                // Reset for new
                setName('');
                setSelectedChannels([]);
                setSelectedContentIds([]);
                setFiles([]);
                setFrequencyValue(1);
                setFrequencyUnit('hours');
                setStartTime('');
                setCaption('');
                setIsCarousel(false);
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
        const { data } = await supabase
            .from('channels')
            .select('*')
            .eq('platform', 'instagram')
            .eq('status', 'active');
        setChannels(data || []);
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
        const uploadedItems: { url: string, type: string }[] = [];

        for (const file of files) {
            const fileExt = file.name.split('.').pop();
            const fileName = `${userId}/${Math.random().toString(36).substring(2)}.${fileExt}`;
            const fileType = file.type.startsWith('image/') ? 'image' : 'video';

            const { error: uploadError } = await supabase.storage
                .from('instagram-videos') // Keeping existing bucket name for now
                .upload(fileName, file);

            if (uploadError) {
                console.error(`Error uploading ${file.name}:`, uploadError);
                continue;
            }

            const { data } = supabase.storage
                .from('instagram-videos')
                .getPublicUrl(fileName);

            uploadedItems.push({ url: data.publicUrl, type: fileType });
        }
        return uploadedItems;
    };

    const handleSubmit = async () => {
        setLoading(true);
        setUploading(true);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error('Not authenticated');

            // 1. Upload New Files
            const uploadedItems = await uploadFiles(session.user.id);

            // 2. Prepare Content Array
            let content;

            if (isCarousel && mediaType === 'IMAGE' && selectedContentIds.length > 0) {
                // Carousel from folder: Fetch folder children ordered by name
                const folderId = selectedContentIds[0]; // Only one folder should be selected

                // Fetch children ordered by name (alphabetical/numerical)
                const { data: folderChildren, error: childrenError } = await supabase
                    .from('content_items')
                    .select('id, name, url, type')
                    .eq('parent_id', folderId)
                    .order('name', { ascending: true });

                if (childrenError) throw childrenError;

                if (!folderChildren || folderChildren.length < 2) {
                    throw new Error('Carousel folder must contain at least 2 items');
                }

                // Build carousel_item_ids array with items in correct order
                const carouselItems = folderChildren.map(item => ({
                    url: item.url,
                    type: item.type === 'video' ? 'video' : 'image'
                }));

                content = [{
                    type: 'config',
                    media_type: 'CAROUSEL',
                    carousel_items: carouselItems,
                    carousel_item_ids: folderChildren.map(item => item.id),
                    folder_id: folderId,
                    caption,
                    location_id: location
                }];
            } else if (isCarousel) {
                // Legacy carousel from uploads
                content = [{
                    type: 'config',
                    media_type: 'CAROUSEL',
                    children_urls: [
                        ...uploadedItems,
                        ...selectedContentIds.map(id => ({ type: 'library_item', id }))
                    ],
                    caption,
                    location_id: location
                }];
            } else {
                // Separate Posts
                content = [
                    ...uploadedItems.map(item => ({
                        ...item,
                        media_type: mediaType,
                        share_to_feed: shareToFeed,
                        caption,
                        location_id: location
                    })),
                    ...selectedContentIds.map(id => ({
                        type: 'library_item',
                        id,
                        media_type: mediaType,
                        share_to_feed: shareToFeed,
                        caption,
                        location_id: location
                    }))
                ];
            }

            // 3. Prepare Config in JSON
            // Check if content has changed - if so, reset state to prevent incorrect indexing
            const existingContent = initialData?.config?.content || [];
            const contentChanged = JSON.stringify(content) !== JSON.stringify(existingContent);
            const existingState = initialData?.config?.state || {};

            // Reset state if content changed
            const preservedState = contentChanged ? {} : existingState;

            const plannerConfig = {
                frequency: {
                    value: frequencyValue,
                    unit: frequencyUnit
                },
                timezone,
                start_time: startTime,
                sleep_schedule: sleepEnabled ? { start: sleepStart, end: sleepEnd } : null,
                sort_order: sortOrder,
                content,
                state: preservedState
            };

            // 4. Update or Insert Planner
            if (initialData?.id) {
                const { error } = await supabase.from('planners').update({
                    name,
                    channel_ids: selectedChannels,
                    config: plannerConfig,
                }).eq('id', initialData.id);
                if (error) throw error;
            } else {
                const { error } = await supabase.from('planners').insert({
                    user_id: session.user.id,
                    name,
                    channel_ids: selectedChannels,
                    config: plannerConfig,
                    status: 'active'
                });
                if (error) throw error;
            }

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
                                        />
                                    </div>
                                )}
                            </div>

                            <p className="text-xs text-ios-secondary">
                                {isCarousel && mediaType === 'IMAGE'
                                    ? `${selectedContentIds.length} folder(s) selected for carousel.`
                                    : `${files.length} new files, ${selectedContentIds.length} library items selected.`
                                }
                            </p>

                            {/* Post Configuration */}
                            <div className="bg-ios-card border border-ios-separator rounded-xl p-4 space-y-4 shadow-sm">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-[13px] font-bold text-ios-secondary uppercase tracking-wide">Post Configuration</h3>
                                    {(files.length + selectedContentIds.length > 1) && (
                                        <div
                                            onClick={() => setIsCarousel(!isCarousel)}
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
                                    <div>
                                        <label className="text-xs font-medium text-ios-text mb-1.5 block">Media Type</label>
                                        <select
                                            value={mediaType}
                                            onChange={(e) => setMediaType(e.target.value as any)}
                                            className="w-full bg-ios-background border border-ios-separator rounded-lg px-2 py-2 text-sm focus:border-ios-blue outline-none"
                                            disabled={isCarousel} // Forced to CAROUSEL if isCarousel
                                        >
                                            <option value="REELS">Reels</option>
                                            <option value="IMAGE">Post / Image</option>
                                            <option value="STORIES">Story</option>
                                            <option value="VIDEO">Video</option>
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

                                <div>
                                    <label className="text-xs font-medium text-ios-text mb-1.5 block">Location ID (Optional)</label>
                                    <input
                                        value={location}
                                        onChange={(e) => setLocation(e.target.value)}
                                        className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
                                        placeholder="Instagram Location ID"
                                    />
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
                                        onChange={(e) => setFrequencyValue(parseInt(e.target.value))}
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
                                                onChange={(e) => setSleepStart(e.target.value)}
                                                className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-2"
                                            />
                                        </div>
                                        <div>
                                            <span className="text-xs text-ios-secondary mb-1 block">To</span>
                                            <input
                                                type="time"
                                                value={sleepEnd}
                                                onChange={(e) => setSleepEnd(e.target.value)}
                                                className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-2"
                                            />
                                        </div>
                                    </div>
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
                                (step === 2 && files.length === 0 && selectedContentIds.length === 0)
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
