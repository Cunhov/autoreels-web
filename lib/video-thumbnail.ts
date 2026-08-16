function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export async function createVideoThumbnailFile(
	file: File,
): Promise<File | null> {
	const video = document.createElement("video");
	const objectUrl = URL.createObjectURL(file);
	video.preload = "metadata";
	video.muted = true;
	video.playsInline = true;
	video.src = objectUrl;

	try {
		await withTimeout(
			new Promise<void>((resolve, reject) => {
				video.onloadedmetadata = () => resolve();
				video.onerror = () =>
					reject(new Error("Failed to load video metadata"));
			}),
			15_000,
			"thumbnail metadata",
		);

		const seekTime = Math.min(0.5, Math.max(0.05, (video.duration || 1) * 0.1));
		video.currentTime = seekTime;

		await withTimeout(
			new Promise<void>((resolve, reject) => {
				video.onseeked = () => resolve();
				video.onerror = () => reject(new Error("Failed to seek video"));
			}),
			15_000,
			"thumbnail seek",
		);

		const width = 480;
		const height =
			Math.round((video.videoHeight / video.videoWidth) * width) || 270;
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;

		ctx.drawImage(video, 0, 0, width, height);

		const blob = await withTimeout(
			new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, "image/webp", 0.82),
			),
			5_000,
			"thumbnail encode",
		);
		if (!blob) return null;

		return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.webp`, {
			type: "image/webp",
		});
	} catch (error) {
		// Non-fatal: upload proceeds WITHOUT a thumbnail (the queue must never
		// stall because a video's metadata/seek event never fired).
		console.warn(
			"Video thumbnail generation failed (skipping):",
			error instanceof Error ? error.message : error,
		);
		return null;
	} finally {
		// Always release the object URL, on both success and error paths.
		URL.revokeObjectURL(objectUrl);
	}
}
