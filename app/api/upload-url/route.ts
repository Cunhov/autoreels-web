import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { path, bucket } = await req.json();

        if (!path) {
            return NextResponse.json({ error: "No path provided" }, { status: 400 });
        }

        // Security: enforce that the path starts with the user's ID
        const userId = (session.user as any).id;
        if (!path.startsWith(`${userId}/`)) {
            return NextResponse.json({ error: "Forbidden path" }, { status: 403 });
        }

        const storageBucket = bucket || 'instagram-videos';

        const { data, error } = await supabaseAdmin.storage
            .from(storageBucket)
            .createSignedUploadUrl(path);

        if (error) {
            console.error('Supabase signed URL error:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
