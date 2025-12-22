'use client';
import { useState, useRef } from 'react';
import { Upload, X, Film, PlayCircle } from 'lucide-react';

interface MediaUploaderProps {
    files: File[];
    onFilesChange: (files: File[]) => void;
}

export default function MediaUploader({ files, onFilesChange }: MediaUploaderProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = useState(false);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const newFiles = Array.from(e.target.files);
            onFilesChange([...files, ...newFiles]);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const newFiles = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('video/'));
            onFilesChange([...files, ...newFiles]);
        }
    };

    const removeFile = (index: number) => {
        const newFiles = [...files];
        newFiles.splice(index, 1);
        onFilesChange(newFiles);
    };

    return (
        <div className="space-y-4">
            <div
                className={`border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center text-center transition-all cursor-pointer ${isDragging ? 'border-ios-blue bg-ios-blue/5' : 'border-ios-separator hover:border-ios-blue/50 hover:bg-ios-card'
                    }`}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
            >
                <div className="w-16 h-16 bg-ios-blue/10 text-ios-blue rounded-full flex items-center justify-center mb-4">
                    <Upload size={32} />
                </div>
                <h3 className="text-lg font-semibold text-ios-text mb-1">Upload Videos</h3>
                <p className="text-ios-secondary text-sm max-w-[200px]">
                    Drag and drop your video files here or click to browse.
                </p>
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="video/*"
                    className="hidden"
                    onChange={handleFileChange}
                />
            </div>

            {files.length > 0 && (
                <div className="bg-ios-card border border-ios-separator rounded-xl overflow-hidden divide-y divide-ios-separator">
                    <div className="p-3 bg-ios-background/50 border-b border-ios-separator flex justify-between items-center">
                        <span className="text-xs font-semibold text-ios-secondary uppercase tracking-wider px-1">
                            Selected Files ({files.length})
                        </span>
                        <button
                            onClick={() => onFilesChange([])}
                            className="text-xs text-red-500 hover:text-red-600 font-medium"
                        >
                            Clear All
                        </button>
                    </div>
                    <div className="max-h-[300px] overflow-y-auto">
                        {files.map((file, idx) => (
                            <div key={`${file.name}-${idx}`} className="flex items-center p-3 hover:bg-black/5 group">
                                <div className="w-10 h-10 bg-ios-background rounded-lg flex items-center justify-center text-ios-blue mr-3 flex-shrink-0">
                                    <Film size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{file.name}</p>
                                    <p className="text-xs text-ios-secondary">
                                        {(file.size / (1024 * 1024)).toFixed(2)} MB
                                    </p>
                                </div>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        removeFile(idx);
                                    }}
                                    className="p-2 text-ios-secondary hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                                >
                                    <X size={18} />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
