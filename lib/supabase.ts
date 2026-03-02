import { createClient, SupabaseClient } from '@supabase/supabase-js'

let supabaseInstance: SupabaseClient | null = null

function getSupabaseClient(): SupabaseClient {
    if (supabaseInstance) {
        return supabaseInstance
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseKey) {
        throw new Error(
            'Missing Supabase environment variables. Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.'
        )
    }

    supabaseInstance = createClient(supabaseUrl, supabaseKey)
    return supabaseInstance
}

// Export a proxy that lazily initializes the client on first access
// This prevents build-time errors when env vars are not available
export const supabase = new Proxy({} as SupabaseClient, {
    get(_target, prop) {
        const client = getSupabaseClient()
        const value = client[prop as keyof SupabaseClient]
        if (typeof value === 'function') {
            return value.bind(client)
        }
        return value
    },
})

let supabaseAdminInstance: SupabaseClient | null = null;
function getSupabaseAdmin(): SupabaseClient {
    if (supabaseAdminInstance) return supabaseAdminInstance;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing Supabase Service Role Key');
    supabaseAdminInstance = createClient(url, key);
    return supabaseAdminInstance;
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
    get(_target, prop) {
        const client = getSupabaseAdmin();
        const value = client[prop as keyof SupabaseClient];
        if (typeof value === 'function') return value.bind(client);
        return value;
    }
});
