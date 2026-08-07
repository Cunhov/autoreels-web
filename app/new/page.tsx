'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Upload, X, Radio, Calendar as CalendarIcon } from 'lucide-react';

interface Channel {
    id: string;
    name: string;
    platform: string;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB — must match server-side chunk convention

export default function NewPost() {
    const router = useRouter();
    const { data: session } = useSession();
    const [channels, setChannels] = useState<Channel[]>([]);
    const [selectedChannel, setSelectedChannel] = useState('');
    const [scheduledAt, setScheduledAt] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [caption, setCaption] = useState('');
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        fetchChannels();
    }, []);

    // Release the object URL when the preview changes or the page unmounts
    useEffect(() => {
        return () => {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        };
    }, [previewUrl]);

    async function fetchChannels() {
        try {
            const res = await fetch('/api/channels');
            if (res.ok) {
                const data = await res.json();
                setChannels(data);
            }
        } catch (err) {
            console.error('Failed to load channels:', err);
        }
    }

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files?.[0] || null;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setFile(selected);
        setPreviewUrl(selected ? URL.createObjectURL(selected) : null);
        // Reset so selecting the same file again re-triggers onChange
        e.target.value = '';
    };

    // Upload a file using the chunked local API (/api/upload-chunk) with retries
    const uploadChunked = async (targetPath: string, fileToUpload: File) => {
        const totalChunks = Math.ceil(fileToUpload.size / CHUNK_SIZE);
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, fileToUpload.size);
            const chunk = fileToUpload.slice(start, end);

            let retries = 0;
            let success = false;
            while (!success && retries < 3) {
                try {
                    const uploadRes = await fetch('/api/upload-chunk', {
                        method: 'POST',
                        headers: {
                            'x-chunk-index': chunkIndex.toString(),
                            'x-total-chunks': totalChunks.toString(),
                            'x-file-name': targetPath,
                            'Content-Type': 'application/octet-stream',
                        },
                        body: chunk,
                    });
                    if (!uploadRes.ok) {
                        const err = await uploadRes.json().catch(() => ({})) as { error?: string };
                        throw new Error(err.error || `Failed to upload chunk ${chunkIndex + 1}/${totalChunks}`);
                    }
                    success = true;
                } catch (err) {
                    retries++;
                    if (retries >= 3) throw err;
                    await new Promise(r => setTimeout(r, 1000 * retries));
                }
            }
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!file) return;

        setUploading(true);
        setError('');

        try {
            if (!session?.user) throw new Error('You must be logged in to create a post.');
            const userId = (session.user as { id?: string }).id;
            if (!userId) throw new Error('You must be logged in to create a post.');

            // 1. Upload the file in chunks to the local filesystem (data/uploads)
            const folderPath = 'admin';
            const targetPath = `${folderPath}/${file.name}`;
            await uploadChunked(targetPath, file);

            // 2. Finalize metadata (creates the ContentItem record)
            const formData = new FormData();
            formData.append('filename', file.name);
            formData.append('size', file.size.toString());
            formData.append('path', targetPath);
            formData.append('folderPath', folderPath);
            formData.append('type', 'video');

            const metaRes = await fetch('/api/upload-chunk/complete', {
                method: 'POST',
                body: formData,
            });
            if (!metaRes.ok) {
                const metaErr = await metaRes.json().catch(() => ({})) as { error?: string };
                throw new Error(metaErr.error || 'Failed to save file metadata');
            }
            const metaData = await metaRes.json();
            const videoUrl = metaData?.item?.url || `/api/file/${userId}/${folderPath}/${encodeURIComponent(file.name)}`;

            // 3. Create the post record (scheduled_at as ISO; publish now if empty)
            const res = await fetch('/api/posts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    video_url: videoUrl,
                    caption: caption,
                    media_type: 'REELS',
                    status: 'pending',
                    channel_id: selectedChannel || null,
                    scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : new Date().toISOString()
                })
            });

            if (!res.ok) {
                const postErr = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(postErr.error || 'Failed to create post record');
            }

            router.push('/');
        } catch (err: unknown) {
            const message = (err as { message?: string })?.message || 'An error occurred during upload.';
            console.error(err);
            setError(message);
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
                                <video key={previewUrl || undefined} className="w-full h-full object-cover opacity-80" src={previewUrl || undefined} muted playsInline />
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <span className="text-white text-sm font-medium bg-black/50 px-3 py-1 rounded-full">{file.name}</span>
                                </div>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        if (previewUrl) URL.revokeObjectURL(previewUrl);
                                        setFile(null);
                                        setPreviewUrl(null);
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
