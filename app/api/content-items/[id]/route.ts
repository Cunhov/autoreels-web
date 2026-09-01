import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { deleteFileFromDisk, collectItemFiles } from "@/lib/deleteFiles";
import { cleanPathSegment } from "@/lib/upload-path";
import { normalizeTags } from "../shared";
import { escapeHtml, sanitizeCaption, sanitizeFirstComment } from "@/lib/sanitize";

// Fields a client may update. Server-owned fields (id, user_id, created_at,
// path) are excluded to prevent mass assignment / arbitrary file deletion.
const PATCH_ALLOWED_FIELDS = [
    "name", "title", "caption", "caption_youtube", "caption_instagram", "caption_tiktok",
    "youtube_products", "first_comment",
    "tags", "type", "size", "duration",
    "parent_id", "thumbnail_url", "url",
] as const;

// Hard safety cap for recursive descendant collection (prevents runaway scans)
const MAX_COLLECT_ITEMS = 10_000;

// Max parent-chain depth for the folder cycle guard (protects against corrupt
// circular trees — a valid tree is far shallower).
const MAX_PARENT_DEPTH = 100;

/**
 * Recursively collect an item plus ALL descendants (any depth) with the
 * fields needed for disk cleanup. Returns [] if the root is missing.
 */
async function collectWithDescendants(
    root: { id: string; url?: string | null; thumbnail_url?: string | null; name?: string | null; path?: string | null }
) {
    const collected: Array<{ url: string | null; thumbnail_url: string | null; name: string | null; path: string | null }> = [
        {
            url: root.url ?? null,
            thumbnail_url: root.thumbnail_url ?? null,
            name: root.name ?? null,
            path: root.path ?? null,
        },
    ];

    let currentLevel: string[] = [root.id];
    let guard = 0;

    while (currentLevel.length > 0 && guard < 20) {
        const level = await prisma.contentItem.findMany({
            where: { parent_id: { in: currentLevel } },
            select: {
                id: true,
                url: true,
                thumbnail_url: true,
                name: true,
                path: true,
            },
        });
        if (level.length === 0) break;

        collected.push(...level.map((c) => ({
            url: c.url ?? null,
            thumbnail_url: c.thumbnail_url ?? null,
            name: c.name ?? null,
            path: c.path ?? null,
        })));

        if (collected.length > MAX_COLLECT_ITEMS) {
            console.warn(`[cleanup] Descendant collection exceeded ${MAX_COLLECT_ITEMS} items; truncating.`);
            break;
        }

        currentLevel = level.map((c) => c.id);
        guard++;
    }

    return collected;
}

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const item = await prisma.contentItem.findUnique({
            where: { id, user_id: userId },
        });
        if (!item) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
        return NextResponse.json(item);
    } catch (error: unknown) {
        console.error('Get content item error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const data = await req.json();

        // Whitelist: drop any field not in the allowed list (prevents mass assignment)
        const payload: Record<string, unknown> = {};
        for (const field of PATCH_ALLOWED_FIELDS) {
            if (data[field] !== undefined) payload[field] = data[field];
        }

        // Nothing to update (e.g. client sent only server-owned fields)
        if (Object.keys(payload).length === 0) {
            return NextResponse.json({ error: "No fields to update" }, { status: 400 });
        }

        // BK-11 trim check antes de salvar — rejeita só espaços
        if (payload.name !== undefined) {
            const rawName = String(payload.name);
            if (!rawName.trim()) {
                return NextResponse.json({ error: "Invalid name" }, { status: 400 });
            }
            const cleanName = cleanPathSegment(rawName.trim());
            if (cleanName === null || cleanName.includes("/") || cleanName === "." || cleanName === "") {
                return NextResponse.json({ error: "Invalid name" }, { status: 400 });
            }
            payload.name = escapeHtml(cleanName).slice(0, 200);
        }
        // BK-07/BK-14 sanitização caption/title com limite — captions por
        // plataforma (F4+TikTok triple captions) usam a MESMA sanitizeCaption (trim +
        // slice 2200 + escape). NUNCA gravar caption_* sem sanitize.
        if (payload.caption !== undefined && payload.caption !== null) {
            payload.caption = sanitizeCaption(payload.caption);
        }
        if (payload.caption_youtube !== undefined && payload.caption_youtube !== null) {
            payload.caption_youtube = sanitizeCaption(payload.caption_youtube);
        }
        if (payload.caption_instagram !== undefined && payload.caption_instagram !== null) {
            payload.caption_instagram = sanitizeCaption(payload.caption_instagram);
        }
        if (payload.caption_tiktok !== undefined && payload.caption_tiktok !== null) {
            payload.caption_tiktok = sanitizeCaption(payload.caption_tiktok);
        }
        // F4: primeiro comentário — mesmo tratamento do POST: trim + limite 500
        // + vazio→null (vazio num PATCH individual limpa o campo; ver modal).
        if (payload.first_comment !== undefined) {
            payload.first_comment = sanitizeFirstComment(payload.first_comment);
        }
        // Produtos afiliados por vídeo (decisão do dono): CSV de NOMES no item.
        // Mesma regra do POST: trim + limite 5000; vírgula separa itens; nomes
        // não passam por escapeHtml (termo do catálogo, não texto de post).
        if (payload.youtube_products !== undefined && payload.youtube_products !== null) {
            let p = String(payload.youtube_products).trim();
            if (p.length > 5000) p = p.slice(0, 5000);
            payload.youtube_products = p || null;
        }
        if (payload.title !== undefined && payload.title !== null) {
            let t = String(payload.title).trim();
            if (!t) return NextResponse.json({ error: "Invalid title" }, { status: 400 });
            if (t.length > 200) t = t.slice(0, 200);
            if (t.includes("<") || t.includes(">")) t = escapeHtml(t);
            payload.title = t;
        }

        // Validate url (used by "replace original" from the image editor): must
        // be our own /api/file/{userId}/... path, without traversal. Never accept
        // `path` (disk layout is server-owned).
        if (payload.url !== undefined) {
            const url = payload.url as string | null;
            if (url && (!url.startsWith(`/api/file/${userId}/`) || url.includes(".."))) {
                return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
            }
            payload.url = url;
        }

        // Validate size (replacement metadata): non-negative integer
        if (payload.size !== undefined) {
            const size = Number(payload.size);
            if (!Number.isInteger(size) || size < 0) {
                return NextResponse.json({ error: "Invalid size" }, { status: 400 });
            }
            payload.size = size;
        }

        // Sanitize thumbnail_url (must be our own /api/file/ path or http(s))
        if (payload.thumbnail_url !== undefined) {
            const thumb = payload.thumbnail_url as string | null;
            if (thumb && !thumb.startsWith("/api/file/") && !/^https?:\/\//.test(thumb)) {
                return NextResponse.json({ error: "Invalid thumbnail URL" }, { status: 400 });
            }
            if (thumb && thumb.startsWith("/api/file/")) {
                const rest = thumb.slice("/api/file/".length);
                if (cleanPathSegment(rest) === null) {
                    return NextResponse.json({ error: "Invalid thumbnail URL" }, { status: 400 });
                }
            }
        }

        // Validate parent folder (parent_id: null → root is allowed):
        //   1. must exist and belong to the same user
        //   2. must be a folder-like item (folder / carousel_folder)
        //   3. must not be inside the moved item's own subtree (cycle guard)
        if (payload.parent_id !== undefined && payload.parent_id !== null) {
            const parent = await prisma.contentItem.findFirst({
                where: { id: String(payload.parent_id), user_id: userId },
                select: { id: true, type: true },
            });
            if (!parent) {
                return NextResponse.json({ error: "Invalid parent folder" }, { status: 400 });
            }
            if (parent.type !== "folder" && parent.type !== "carousel_folder") {
                return NextResponse.json({ error: "Parent is not a folder" }, { status: 400 });
            }
            // Cycle guard: the new parent must not be a descendant of the item
            // being moved. Walk the parent chain up, bounded against corrupt data.
            let cursor: string | null = parent.id;
            const seen = new Set<string>([id]);
            let depth = 0;
            while (cursor && depth < MAX_PARENT_DEPTH) {
                if (cursor === id || seen.has(cursor)) {
                    return NextResponse.json(
                        { error: "Cannot move a folder into its own descendant" },
                        { status: 400 }
                    );
                }
                seen.add(cursor);
                const up: { parent_id: string | null } | null =
                    await prisma.contentItem.findFirst({
                        where: { id: cursor, user_id: userId },
                        select: { parent_id: true },
                    });
                cursor = up?.parent_id ?? null;
                depth++;
            }
        }

        // Tags: always store as a JSON array string (normalized)
        if (payload.tags !== undefined) {
            payload.tags = normalizeTags(payload.tags);
        }

        const result = await prisma.contentItem.updateMany({
            where: { id, user_id: userId },
            data: payload,
        });

        if (result.count === 0) {
            return NextResponse.json({ error: "Item not found or unauthorized" }, { status: 404 });
        }

        const updatedItem = await prisma.contentItem.findFirst({ where: { id, user_id: userId } });
        return NextResponse.json(updatedItem);
    } catch (error: unknown) {
        console.error('Update content item error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        // Fetch the item first so we can clean up its files
        const item = await prisma.contentItem.findFirst({
            where: { id, user_id: userId },
            select: {
                id: true,
                name: true,
                path: true,
                type: true,
                thumbnail_url: true,
                url: true,
            },
        });

        if (!item) {
            return NextResponse.json({ error: "Item not found or unauthorized" }, { status: 404 });
        }

        // Recursively collect this item + every descendant (any depth)
        const allItems = await collectWithDescendants(item);

        // Resolve every file (URL is the source of truth; legacy fallback to path+name)
        const filesToDelete = allItems.flatMap((c) => collectItemFiles(userId, c));

        // Delete from DB first (cascade handles descendant records)
        await prisma.contentItem.deleteMany({
            where: { id, user_id: userId },
        });

        // Best-effort file cleanup — never let disk failures block the DB delete
        await Promise.allSettled(
            filesToDelete.map((p) => deleteFileFromDisk(p))
        );

        return NextResponse.json({ success: true, files_cleaned: filesToDelete.length });
    } catch (error: unknown) {
        console.error('Delete content item error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
}
