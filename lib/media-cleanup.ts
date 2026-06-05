import { readdir, stat } from "fs/promises";
import { join, posix } from "path";
import { prisma } from "@/lib/prisma";
import { deleteFileFromDisk, extractUploadPathFromUrl } from "@/lib/deleteFiles";
import { parsePlannerConfig } from "@/lib/planner-runtime";

async function walkFiles(root: string, dir = "", out: Array<{ relativePath: string; mtimeMs: number }> = []) {
    const current = join(root, dir);
    let entries;
    try {
        entries = await readdir(current, { withFileTypes: true });
    } catch (error: any) {
        if (error?.code === 'ENOENT') return out;
        throw error;
    }

    for (const entry of entries) {
        const relative = dir ? posix.join(dir, entry.name) : entry.name;
        const absolute = join(root, relative);

        if (entry.isDirectory()) {
            await walkFiles(root, relative, out);
            continue;
        }

        const info = await stat(absolute);
        out.push({ relativePath: relative.replace(/\\/g, "/"), mtimeMs: info.mtimeMs });
    }

    return out;
}

function addUrlRef(set: Set<string>, url?: string | null) {
    const path = extractUploadPathFromUrl(url);
    if (path) set.add(path);
}

function addChildrenRefs(set: Set<string>, raw: unknown) {
    if (!raw) return;
    if (typeof raw === "string") {
        try {
            addChildrenRefs(set, JSON.parse(raw));
        } catch {
            return;
        }
        return;
    }
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
        if (item && typeof item === "object") {
            addUrlRef(set, (item as any).url);
        }
    }
}

export async function cleanupOrphanUploadFiles(now = new Date(), maxDeletes = 50) {
    const root = join(process.cwd(), "data", "uploads");
    const referenced = new Set<string>();

    const [contentItems, posts, planners] = await Promise.all([
        prisma.contentItem.findMany({
            select: { url: true, thumbnail_url: true, parent_id: true, type: true },
        }),
        prisma.post.findMany({
            select: { video_url: true, image_url: true, thumbnail_url: true, children_urls: true },
        }),
        prisma.planner.findMany({
            select: { config: true },
        }),
    ]);

    for (const item of contentItems) {
        addUrlRef(referenced, item.url);
        addUrlRef(referenced, item.thumbnail_url);
    }

    for (const post of posts) {
        addUrlRef(referenced, post.video_url);
        addUrlRef(referenced, post.image_url);
        addUrlRef(referenced, post.thumbnail_url);
        addChildrenRefs(referenced, post.children_urls);
    }

    for (const planner of planners) {
        const config = parsePlannerConfig(planner.config);
        if (!Array.isArray(config.content)) continue;
        for (const content of config.content) {
            if (!content || typeof content !== "object") continue;
            addUrlRef(referenced, (content as any).url);
            addUrlRef(referenced, (content as any).thumbnail_url);
            addChildrenRefs(referenced, (content as any).children_urls);
            addChildrenRefs(referenced, (content as any).carousel_items);
        }
    }

    const files = await walkFiles(root);
    const nowMs = now.getTime();
    const staleThresholdMs = 14 * 24 * 60 * 60 * 1000;
    const partThresholdMs = 24 * 60 * 60 * 1000;

    let deleted = 0;
    for (const file of files) {
        if (deleted >= maxDeletes) break;
        const isPart = file.relativePath.endsWith(".part");
        const ageMs = nowMs - file.mtimeMs;

        if (isPart && ageMs >= partThresholdMs) {
            await deleteFileFromDisk(file.relativePath);
            deleted++;
            continue;
        }

        if (!referenced.has(file.relativePath) && ageMs >= staleThresholdMs) {
            await deleteFileFromDisk(file.relativePath);
            deleted++;
        }
    }

    return { deleted, scanned: files.length };
}
