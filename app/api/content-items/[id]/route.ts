import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteFileFromDisk, buildDiskPath, extractUploadPathFromUrl } from "@/lib/deleteFiles";

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const item = await prisma.contentItem.findUnique({
            where: { id, user_id: (session.user as any).id },
        });
        if (!item) {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
        return NextResponse.json(item);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const userId = (session.user as any).id;

    try {
        const data = await req.json();
        const result = await prisma.contentItem.updateMany({
            where: { id, user_id: userId },
            data,
        });

        if (result.count === 0) {
            return NextResponse.json({ error: "Item not found or unauthorized" }, { status: 404 });
        }

        const updatedItem = await prisma.contentItem.findFirst({ where: { id, user_id: userId } });
        return NextResponse.json(updatedItem);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const userId = (session.user as any).id;

    try {
        // Fetch the item first so we can clean up its file
        const item = await prisma.contentItem.findFirst({
            where: { id, user_id: userId },
            select: { id: true, name: true, path: true, type: true, thumbnail_url: true },
        });

        if (!item) {
            return NextResponse.json({ error: "Item not found or unauthorized" }, { status: 404 });
        }

        // Collect all files to delete
        const filesToDelete: string[] = [];

        // If the item itself has a file (non-folder types)
        if (item.type !== "carousel_folder" && item.name) {
            filesToDelete.push(buildDiskPath(userId, item.path, item.name));
        }
        const itemThumb = extractUploadPathFromUrl(item.thumbnail_url);
        if (itemThumb) {
            filesToDelete.push(itemThumb);
        }

        // If it's a carousel folder, also collect children's files
        if (item.type === "carousel_folder") {
            const children = await prisma.contentItem.findMany({
                where: { parent_id: item.id },
                select: { name: true, path: true, thumbnail_url: true },
            });
            for (const child of children) {
                if (child.name) {
                    filesToDelete.push(buildDiskPath(userId, child.path, child.name));
                }
                const childThumb = extractUploadPathFromUrl(child.thumbnail_url);
                if (childThumb) {
                    filesToDelete.push(childThumb);
                }
            }
        }

        // Delete from DB (cascade handles children records)
        await prisma.contentItem.deleteMany({
            where: { id, user_id: userId },
        });

        // Best-effort file cleanup
        await Promise.allSettled(
            filesToDelete.map((p) => deleteFileFromDisk(p))
        );

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 400 });
    }
}
