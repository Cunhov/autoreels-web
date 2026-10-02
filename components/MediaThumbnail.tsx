"use client";

import { useState } from "react";
import { ImageOff, Video } from "lucide-react";

/** Keep calendar tiles readable when a remote thumbnail is missing or expired. */
export default function MediaThumbnail({ src, alt, video = false, className = "" }: {
    src?: string | null;
    alt: string;
    video?: boolean;
    className?: string;
}) {
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    return (
        <div className={`w-full h-full bg-ios-gray-5 ${className}`}>
            {src && failedSrc !== src ? (
                <img src={src} alt={alt} loading="lazy" decoding="async" className="w-full h-full object-cover" onError={() => setFailedSrc(src)} />
            ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-ios-text-secondary text-[10px]" aria-label={alt}>
                    {video ? <Video size={18} /> : <ImageOff size={18} />}
                    <span>{video ? "Vídeo" : "Sem prévia"}</span>
                </div>
            )}
        </div>
    );
}
