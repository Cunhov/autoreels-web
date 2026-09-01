// Shim de "@/lib/ffmpeg": sem ffprobe no teste — duration vira null
// (non-fatal no complete route).
export function isFfmpegAvailable() {
  return false;
}
export async function getVideoDurationSec() {
  return null;
}