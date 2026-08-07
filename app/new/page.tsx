'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { getPublicUrl } from '@/lib/storage';
import { Upload, X, Radio, Calendar as CalendarIcon } from 'lucide-react';
import { IOSInputRow } from '@/components/IOSComponents';

interface Channel {
    id: string;
    name: string;
    platform: string;
}

export default function NewPost() {
    const router = useRouter();
    const { data: session } = useSession();
    const [channels, setChannels] = useState<Channel[]>([]);
    const [selectedChannel, setSelectedChannel] = useState('');
    const [scheduledAt, setScheduledAt] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [caption, setCaption] = useState('');
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        fetchChannels();
    }, []);

    async function fetchChannels() {
        const res = await fetch('/api/channels');
        if (res.ok) {
            const data = await res.json();
            setChannels(data);
        }
    }

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!file) return;

        setUploading(true);
        setError('');

        try {
            if (!session?.user) throw new Error('You must be logged in to create a post.');
            const userId = (session.user as any).id;

            // 1. Get Signed Upload URL
            const fileExt = file.name.split('.').pop();
            const fileName = `${userId}/${Math.random().toString(36).substring(2)}.${fileExt}`;

            const urlRes = await fetch('/api/upload-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: fileName, bucket: 'instagram-videos' })
            });

            if (!urlRes.ok) {
                const urlErr = await urlRes.json();
                throw new Error(urlErr.error || 'Failed to get upload URL');
            }

            const { signedUrl, token } = await urlRes.json();

            // 2. Upload file to signed URL
            const uploadRes = await fetch(signedUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                body: file
            });

            if (!uploadRes.ok) throw new Error('Failed to upload video');

            // 3. Get Public URL (doesn't require auth)
            const videoUrl = getPublicUrl(fileName);

            // 4. Insert into Database

            const res = await fetch('/api/posts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    video_url: videoUrl,
                    caption: caption,
                    status: 'pending',
                    channel_id: selectedChannel || null,
                    // Convert local datetime string to absolute ISO so the server (UTC)
                    // interprets the user's local wall-clock correctly.
                    scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null
                })
            });

            if (!res.ok) throw new Error('Failed to create post record');

            router.push('/');
        } catch (err: any) {
            console.error(err);
            setError(err.message || 'An error occurred during upload.');
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="max-w-2xl mx-auto pb-20 md:pb-0">
            <h1 className="text-[34px] font-bold tracking-tight text-ios-text mb-6 px-4">New Reel</h1>

            <form onSubmit={handleSubmit} className="space-y-6">

                {/* Visual File Picker */}
                <div className="px-4">
                    <label htmlFor="file-upload" className={`block w-full aspect-[9/16] max-w-[200px] mx-auto rounded-xl border-2 border-dashed transition-all relative overflow-hidden bg-ios-card ${file ? 'border-ios-blue' : 'border-ios-separator hover:border-ios-blue/50'}`}>
                        {file ? (
                            <div className="w-full h-full bg-black flex items-center justify-center relative">
                                <video className="w-full h-full object-cover opacity-80" />
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <span className="text-white text-sm font-medium bg-black/50 px-3 py-1 rounded-full">{file.name}</span>
                                </div>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        setFile(null);
                                    }}
                                    className="absolute top-2 right-2 bg-white/20 backdrop-blur-md p-1 rounded-full text-white"
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center text-ios-text-secondary gap-2 cursor-pointer">
                                <Upload size={32} />
                                <span className="text-sm font-medium">Select Video</span>
                                <span className="text-[10px]">9:16 MP4</span>
                            </div>
                        )}
                        <input id="file-upload" name="file-upload" type="file" className="absolute inset-0 opacity-0 cursor-pointer" accept="video/*" onChange={handleFileChange} required={!file} />
                    </label>
                </div>

                <div className="ios-inset-grouped bg-ios-card divide-y divide-ios-separator">
                    <div className="flex items-center justify-between p-4 bg-ios-card">
                        <label className="text-[17px] text-ios-text font-medium flex items-center gap-2">
                            <Radio size={18} className="text-ios-blue" />
                            Channel
                        </label>
                        <select
                            title="Channel Select"
                            value={selectedChannel}
                            onChange={(e) => setSelectedChannel(e.target.value)}
                            className="bg-transparent text-[17px] text-ios-blue text-right focus:outline-none"
                        >
                            <option value="">Default Account</option>
                            {channels.map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                        </select>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-ios-card">
                        <label className="text-[17px] text-ios-text font-medium flex items-center gap-2">
                            <CalendarIcon size={18} className="text-ios-blue" />
                            Schedule
                        </label>
                        <input
                            title="Schedule At"
                            type="datetime-local"
                            value={scheduledAt}
                            onChange={(e) => setScheduledAt(e.target.value)}
                            className="bg-transparent text-[17px] text-ios-blue text-right focus:outline-none"
                        />
                    </div>

                    <div className="bg-ios-card">
                        <textarea
                            id="caption"
                            rows={4}
                            className="block w-full bg-transparent p-4 text-[17px] text-ios-text placeholder:text-ios-text-secondary focus:outline-none resize-none"
                            placeholder="Write a caption..."
                            value={caption}
                            onChange={(e) => setCaption(e.target.value)}
                        />
                    </div>
                </div>

                {error && (
                    <div className="mx-4 p-3 bg-red-50 dark:bg-red-900/20 text-ios-red text-sm rounded-xl text-center">
                        {error}
                    </div>
                )}

                <div className="px-4">
                    <button
                        type="submit"
                        disabled={!file || uploading}
                        className="ios-btn bg-ios-blue text-white w-full py-3.5 rounded-xl font-semibold text-[17px] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    >
                        {uploading ? 'Uploading...' : 'Share'}
                    </button>
                </div>
            </form>
        </div>
    );
}
