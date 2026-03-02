import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const url = new URL(req.url);
        const path = url.searchParams.get("path");
        const bucket = url.searchParams.get("bucket") || 'instagram-videos';

        if (!path) {
            return NextResponse.json({ error: "No path provided" }, { status: 400 });
        }

        // Security check: ensure path starts with user_id to prevent deleting others' files.
        const userId = (session.user as any).id;
        if (!path.startsWith(`${userId}/`)) {
            return NextResponse.json({ error: "Permission denied" }, { status: 403 });
        }

        const { error } = await supabaseAdmin.storage
            .from(bucket)
            .remove([path]);

        if (error) {
            console.error('Supabase delete error:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
