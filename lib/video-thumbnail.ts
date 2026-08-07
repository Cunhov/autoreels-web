export async function createVideoThumbnailFile(file: File): Promise<File | null> {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error('Failed to load video metadata'));
        });

        const seekTime = Math.min(0.5, Math.max(0.05, (video.duration || 1) * 0.1));
        video.currentTime = seekTime;

        await new Promise<void>((resolve, reject) => {
            video.onseeked = () => resolve();
            video.onerror = () => reject(new Error('Failed to seek video'));
        });

        const width = 480;
        const height = Math.round((video.videoHeight / video.videoWidth) * width) || 270;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.drawImage(video, 0, 0, width, height);

        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.82));
        if (!blob) return null;

        return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.webp`, { type: 'image/webp' });
    } catch (error) {
        console.warn('Video thumbnail generation failed:', error);
        return null;
    } finally {
        // Always release the object URL, on both success and error paths.
        URL.revokeObjectURL(objectUrl);
    }
}
