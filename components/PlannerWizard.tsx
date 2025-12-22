'use client';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { X, ChevronRight, ChevronLeft, Calendar, Clock, Instagram, Layers, ArrowUpDown, Check } from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import MediaUploader from './MediaUploader';

interface Channel {
    id: string;
    name: string;
    account_id: string;
}

interface PlannerWizardProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

const STEPS = [
    { id: 'basics', title: 'Basics' },
    { id: 'accounts', title: 'Accounts' },
    { id: 'content', title: 'Content' },
    { id: 'schedule', title: 'Schedule' },
    { id: 'sorting', title: 'Sorting' }
];

export default function PlannerWizard({ isOpen, onClose, onSuccess }: PlannerWizardProps) {
    const [step, setStep] = useState(0);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [channels, setChannels] = useState<Channel[]>([]);

    // Form State
    const [name, setName] = useState('');
    const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
    const [files, setFiles] = useState<File[]>([]);
    const [frequencyValue, setFrequencyValue] = useState(1);
    const [frequencyUnit, setFrequencyUnit] = useState('hours'); // minutes, hours, days
    const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const [startTime, setStartTime] = useState('');
    const [sleepEnabled, setSleepEnabled] = useState(false);
    const [sleepStart, setSleepStart] = useState('00:00');
    const [sleepEnd, setSleepEnd] = useState('06:00');
    const [sortOrder, setSortOrder] = useState('random'); // random, repeat, new_to_old, old_to_new

    useEffect(() => {
        if (isOpen) {
            fetchChannels();
            // Reset state slightly
            setStep(0);
        }
    }, [isOpen]);

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
        const uploadedUrls: string[] = [];

        for (const file of files) {
            const fileExt = file.name.split('.').pop();
            const fileName = `${userId}/${Math.random().toString(36).substring(2)}.${fileExt}`;

            const { error: uploadError } = await supabase.storage
                .from('instagram-videos')
                .upload(fileName, file);

            if (uploadError) {
                console.error(`Error uploading ${file.name}:`, uploadError);
                continue;
            }

            const { data } = supabase.storage
                .from('instagram-videos')
                .getPublicUrl(fileName);

            uploadedUrls.push(data.publicUrl);
        }
        return uploadedUrls;
    };

    const handleSubmit = async () => {
        setLoading(true);
        setUploading(true);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error('Not authenticated');

            // 1. Upload Files
            const uploadedUrls = await uploadFiles(session.user.id);

            // 2. Prepare Config in JSON
            const plannerConfig = {
                frequency: {
                    value: frequencyValue,
                    unit: frequencyUnit
                },
                timezone,
                start_time: startTime,
                sleep_schedule: sleepEnabled ? { start: sleepStart, end: sleepEnd } : null,
                sort_order: sortOrder,
                content: uploadedUrls.map(url => ({ type: 'video', url })) // Basic content structure
            };

            // 3. Insert Planner
            const { error } = await supabase.from('planners').insert({
                user_id: session.user.id,
                name,
                channel_ids: selectedChannels,
                config: plannerConfig,
                status: 'active'
            });

            if (error) throw error;

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
            <div className="bg-ios-card w-full max-w-2xl rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
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
                        <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                            <MediaUploader files={files} onFilesChange={setFiles} />
                        </div>
                    )}

                    {/* Step 3: Schedule */}
                    {step === 3 && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
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
                                    { id: 'random', label: 'Random', desc: 'Schedule will share posts in random order without duplicates.' },
                                    { id: 'repeat', label: 'Repeat Planner', desc: 'Planner repeats after verified content is finished.' },
                                    { id: 'new_to_old', label: 'From New to Old', desc: 'Schedule will sort posts from last uploaded to first.' },
                                    { id: 'old_to_new', label: 'From Old to New', desc: 'Schedule will sort posts from old to new. Waits for new posts.' },
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
                                (step === 2 && files.length === 0)
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
