import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
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

        if (!filename || isNaN(size)) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        const userId = (session.user as any).id;

        // Define clean URL for serving
        const finalUrl = `/api/file/${userId}/${folderPath}/${filename}`.replace(/\/+/g, '/');

        // Check if an item already exists with this name/path to avoid constraint errors
        const existingItem = await prisma.contentItem.findFirst({
            where: {
                user_id: userId,
                name: filename,
                path: folderPath,
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
                    ...(tags ? { tags } : {}),
                    ...(parentId ? { parent_id: parentId } : {}),
                    ...(caption ? { caption } : {}),
                }
            });
        } else {
            savedItem = await prisma.contentItem.create({
                data: {
                    user_id: userId,
                    name: filename,
                    size: size,
                    url: finalUrl,
                    path: folderPath,
                    type: type,
                    ...(tags ? { tags } : {}),
                    ...(parentId ? { parent_id: parentId } : {}),
                    ...(caption ? { caption } : {}),
                }
            });
        }

        return NextResponse.json({ success: true, item: savedItem });
    } catch (error: any) {
        console.error('Finalizing upload error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
