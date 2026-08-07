import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Check whether the ffmpeg binary is available on this host.
 * Used to return a clean 501 instead of a cryptic exec error when the
 * container was built without ffmpeg (e.g. local dev without the binary).
 */
export function isFfmpegAvailable(): boolean {
    try {
        execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/**
 * Trim a video from `startSec` for `durationSec` seconds, re-encoding to H.264/AAC.
 * Re-encoding (instead of `-c copy`) keeps cuts frame-accurate at the cost of CPU.
 * Rejects on ffmpeg failure; the Error message carries stderr for server logs.
 */
export async function trimVideo(
    inputPath: string,
    outputPath: string,
    startSec: number,
    durationSec: number
): Promise<void> {
    try {
        await execFileAsync(
            "ffmpeg",
            [
                "-y",
                "-ss", String(startSec),
                "-t", String(durationSec),
                "-i", inputPath,
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "23",
                "-c:a", "aac",
                "-movflags", "+faststart",
                outputPath,
            ],
            { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }
        );
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`ffmpeg trim failed: ${detail}`);
    }
}

/**
 * Extract a single JPEG frame at `timeSec` from a video.
 */
export async function extractFrame(
    inputPath: string,
    outputPath: string,
    timeSec: number
): Promise<void> {
    try {
        await execFileAsync(
            "ffmpeg",
            [
                "-y",
                "-ss", String(timeSec),
                "-i", inputPath,
                "-frames:v", "1",
                "-q:v", "3",
                outputPath,
            ],
            { timeout: 2 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }
        );
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`ffmpeg frame extraction failed: ${detail}`);
    }
}

/**
 * Read the total duration (seconds) of a media file via ffprobe.
 */
export async function getVideoDurationSec(inputPath: string): Promise<number> {
    try {
        const { stdout } = await execFileAsync(
            "ffprobe",
            [
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                inputPath,
            ],
            { timeout: 30_000, maxBuffer: 1024 * 1024 }
        );
        const value = parseFloat(String(stdout).trim());
        if (!Number.isFinite(value) || value < 0) {
            throw new Error("Could not read video duration");
        }
        return value;
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`ffprobe failed: ${detail}`);
    }
}
