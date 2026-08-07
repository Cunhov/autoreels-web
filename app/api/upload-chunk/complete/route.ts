import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getErrorMessage, getSessionUserId } from "@/lib/api";
import { cleanPathSegment } from "@/lib/upload-path";

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = getSessionUserId(session);
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const formData = await req.formData();
        const filename = formData.get("filename") as string;
        const size = parseInt(formData.get("size") as string);
        const folderPath = formData.get("folderPath") as string;
        const type = formData.get("type") as string;
        const tagsRaw = formData.get("tags") as string | null;
        const tags = tagsRaw || null; // JSON string or null
        const parentId = formData.get("parentId") as string | null;
        const caption = formData.get("caption") as string | null;
        const thumbnailPath = formData.get("thumbnailPath") as string | null;

        if (!filename || isNaN(size) || size < 0) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        const safeFolderPath = cleanPathSegment(folderPath);
        const safeFilename = cleanPathSegment(filename);

        if (safeFolderPath === null || safeFilename === null || safeFilename.includes("/") || safeFilename === ".") {
            return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
        }

        // Validate parent folder ownership (prevent attaching items to another user's folder)
        if (parentId) {
            const parent = await prisma.contentItem.findFirst({
                where: { id: parentId, user_id: userId },
                select: { id: true },
            });
            if (!parent) {
                return NextResponse.json({ error: "Invalid parent folder" }, { status: 400 });
            }
        }

        // Define clean URL for serving
        const finalUrl = `/api/file/${[userId, safeFolderPath, safeFilename].filter(Boolean).join("/")}`;
        const safeThumbnailPath = thumbnailPath ? cleanPathSegment(thumbnailPath) : null;
        const thumbnailUrl = safeThumbnailPath ? `/api/file/${safeThumbnailPath}` : null;

        // Check if an item already exists with this name/path to avoid constraint errors
        const existingItem = await prisma.contentItem.findFirst({
            where: {
                user_id: userId,
                name: safeFilename,
                path: safeFolderPath,
            }
        });

        let savedItem;
        if (existingItem) {
            // Update size/url if re-uploaded
            savedItem = await prisma.contentItem.update({
                where: { id: existingItem.id },
                data: {
                    size,
                    url: finalUrl,
                    type,
                    ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
                    ...(tags ? { tags } : {}),
                    ...(parentId ? { parent_id: parentId } : {}),
                    ...(caption ? { caption } : {}),
                }
            });
        } else {
            savedItem = await prisma.contentItem.create({
                data: {
                    user_id: userId,
                    name: safeFilename,
                    size: size,
                    url: finalUrl,
                    path: safeFolderPath,
                    type: type,
                    ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
                    ...(tags ? { tags } : {}),
                    ...(parentId ? { parent_id: parentId } : {}),
                    ...(caption ? { caption } : {}),
                }
            });
        }

        return NextResponse.json({ success: true, item: savedItem });
    } catch (error: unknown) {
        console.error('Finalizing upload error:', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
