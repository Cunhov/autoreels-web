'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Upload, X } from 'lucide-react';

export default function NewPost() {
    const router = useRouter();
    const [file, setFile] = useState<File | null>(null);
    const [caption, setCaption] = useState('');
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState('');

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
            // 1. Upload to Storage
            const fileExt = file.name.split('.').pop();
            const fileName = `${Math.random().toString(36).substring(2)}.${fileExt}`;
            const filePath = `${fileName}`;

            const { error: uploadError } = await supabase.storage
                .from('instagram-videos')
                .upload(filePath, file);

            if (uploadError) throw uploadError;

            // 2. Get Public URL
            const { data: publicUrlData } = supabase.storage
                .from('instagram-videos')
                .getPublicUrl(filePath);

            const videoUrl = publicUrlData.publicUrl;

            // 3. Insert into Database
            const { error: insertError } = await supabase
                .from('posts')
                .insert({
                    video_url: videoUrl,
                    caption: caption,
                    status: 'pending'
                });

            if (insertError) throw insertError;

            router.push('/');
        } catch (err: any) {
            console.error(err);
            setError(err.message || 'An error occurred during upload.');
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold text-slate-800 mb-6">Create New Reel</h1>

            <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
                <form onSubmit={handleSubmit} className="space-y-6">

                    {/* File Upload Area */}
                    <div className="space-y-2">
                        <label className="block text-sm font-medium text-slate-700">Video File</label>
                        <div className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${file ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-indigo-400'}`}>

                            {!file ? (
                                <>
                                    <Upload className="mx-auto h-12 w-12 text-slate-400" />
                                    <div className="mt-4 flex text-sm leading-6 text-slate-600 justify-center">
                                        <label htmlFor="file-upload" className="relative cursor-pointer rounded-md bg-white font-semibold text-indigo-600 focus-within:outline-none focus-within:ring-2 focus-within:ring-indigo-600 focus-within:ring-offset-2 hover:text-indigo-500 px-2">
                                            <span>Upload a video</span>
                                            <input id="file-upload" name="file-upload" type="file" className="sr-only" accept="video/*" onChange={handleFileChange} required />
                                        </label>
                                        <p className="pl-1">or drag and drop</p>
                                    </div>
                                    <p className="text-xs leading-5 text-slate-500">MP4, MOV up to 100MB</p>
                                </>
                            ) : (
                                <div className="flex items-center justify-between bg-white p-2 rounded shadow-sm">
                                    <span className="text-sm truncate max-w-[80%]">{file.name}</span>
                                    <button type="button" onClick={() => setFile(null)} className="text-slate-400 hover:text-red-500">
                                        <X size={20} />
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Caption */}
                    <div className="space-y-2">
                        <label htmlFor="caption" className="block text-sm font-medium text-slate-700">Caption</label>
                        <textarea
                            id="caption"
                            rows={4}
                            className="block w-full rounded-md border-0 py-1.5 text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6 p-3"
                            placeholder="Write a catchy caption for your Reel..."
                            value={caption}
                            onChange={(e) => setCaption(e.target.value)}
                        />
                    </div>

                    {error && (
                        <div className="p-3 bg-red-50 text-red-700 text-sm rounded-md">
                            {error}
                        </div>
                    )}

                    <div className="flex justify-end pt-4">
                        <button
                            type="submit"
                            disabled={!file || uploading}
                            className="px-6 py-2 bg-indigo-600 text-white font-medium rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                        >
                            {uploading ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                    Uploading...
                                </>
                            ) : (
                                'Create Post'
                            )}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
