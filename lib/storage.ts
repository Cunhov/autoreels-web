/**
 * Generates a Supabase Storage public URL without requiring the Supabase client.
 * This replaces direct `supabase.storage.from(...).getPublicUrl(...)` calls on the frontend.
 */
export function getPublicUrl(path: string, bucket: string = 'instagram-videos'): string {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) {
        console.warn('NEXT_PUBLIC_SUPABASE_URL is not set');
        return '';
    }
    return `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
}
