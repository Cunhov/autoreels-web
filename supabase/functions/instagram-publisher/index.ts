import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Redis } from 'https://esm.sh/@upstash/redis'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

let redis: Redis | null = null;
async function getRedisClient() {
  if (redis) return redis;
  let url = Deno.env.get('REDIS_URL');
  let token = Deno.env.get('REDIS_TOKEN') || '';
  if (!url) {
    const { data } = await supabase.from('app_config').select('value').eq('key', 'REDIS_URL').single();
    if (data?.value) url = data.value;
  }
  if (!url) return null;
  if (url.startsWith('rediss://')) {
    try {
      const match = url.match(/rediss:\/\/[^:]+:([^@]+)@([^:]+)/);
      if (match) { token = match[1]; url = `https://${match[2]}`; }
    } catch (e) { }
  }
  redis = new Redis({ url, token });
  return redis;
}

async function resolveAccessToken(tokenOrKey: string, plannerId: string | null = null): Promise<string> {
  if (!tokenOrKey) return '';
  if (tokenOrKey.startsWith('token_')) {
    try {
      const redisClient = await getRedisClient();
      if (!redisClient) return tokenOrKey;
      let resolved: string | null = null;
      try {
        const val = await redisClient.get(tokenOrKey);
        if (val && typeof val === 'string') resolved = val;
      } catch (e) { }
      if (!resolved) {
        try {
          const listVal = await redisClient.lindex(tokenOrKey, 0);
          if (listVal && typeof listVal === 'string') resolved = listVal;
        } catch (e) { }
      }
      if (resolved) return resolved.trim().replace(/^["']|["']$/g, '');
    } catch (e) { }
  }
  return tokenOrKey;
}

const GRAPH_API_VERSION = 'v22.0';

function getBaseUrl(token: string) {
  return token.startsWith('IG') ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-auth',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const cronAuth = req.headers.get('x-cron-auth')
    if (cronAuth !== 'autoreels-cron-secret-123') {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const results = { pending: 0, processing: 0, published: 0, errors: 0 }
    const now = new Date()
    const log = async (plannerId: string, message: string, level: 'info' | 'error' = 'info', details: any = {}) => {
      await supabase.from('planner_logs').insert({ planner_id: plannerId, message, level, details })
    }

    // 0. Planner Processing
    const { data: planners } = await supabase.from('planners').select('*').eq('status', 'active');
    for (const planner of planners || []) {
      try {
        const config = planner.config;
        const lastRun = planner.last_run ? new Date(planner.last_run) : null;
        const freqVal = config.frequency?.value || 10;
        const freqUnit = config.frequency?.unit || 'minutes';
        let intervalMs = freqVal * 60 * 1000;
        if (freqUnit === 'hours') intervalMs = freqVal * 60 * 60 * 1000;
        else if (freqUnit === 'days') intervalMs = freqVal * 24 * 60 * 60 * 1000;

        let isDue = !lastRun || (now.getTime() >= lastRun.getTime() + intervalMs - 15000);
        if (isDue) {
          if (config.start_time && now < new Date(config.start_time)) continue;
          const contentList = config.content || [];
          if (contentList.length === 0) continue;

          let selectedIndex = -1;
          const sortOrder = config.sort_order || 'random_loop';
          const state = config.state || {};
          if (sortOrder === 'random_loop') {
            const published = state.published_indexes || [];
            const available = contentList.map((_: any, i: number) => i).filter((i: number) => !published.includes(i));
            selectedIndex = available.length === 0 ? Math.floor(Math.random() * contentList.length) : available[Math.floor(Math.random() * available.length)];
            state.published_indexes = available.length === 0 ? [selectedIndex] : [...published, selectedIndex];
          } else {
            const last = state.last_index !== undefined ? state.last_index : -1;
            selectedIndex = (last + 1) % contentList.length;
            state.last_index = selectedIndex;
          }

          const selectedContent = contentList[selectedIndex];
          if (!selectedContent) continue;

          let mediaUrl = selectedContent.url, mediaType = selectedContent.media_type || 'REELS', caption = selectedContent.caption || '', children = selectedContent.children_urls || [];
          if (selectedContent.type === 'library_item') {
            const { data: libItem } = await supabase.from('content_items').select('*').eq('id', selectedContent.id).single();
            if (libItem) {
              mediaUrl = libItem.url;
              mediaType = libItem.type === 'video' ? 'REELS' : (libItem.type === 'image' ? 'IMAGE' : (libItem.type === 'carousel_folder' ? 'CAROUSEL' : mediaType));
              if (libItem.type === 'carousel_folder') {
                const { data: subItems } = await supabase.from('content_items').select('url, type').eq('parent_id', libItem.id).order('created_at', { ascending: true });
                children = (subItems || []).map(c => ({ url: c.url, type: c.type === 'video' ? 'video' : 'image' }));
              }
              caption = (caption || '').replace(/{post_title}/g, libItem.title || '').replace(/{post_caption}/g, libItem.caption || '');
            }
          }

          for (const channelId of planner.channel_ids || []) {
            await supabase.from('posts').insert({
              user_id: planner.user_id, channel_id: channelId, status: 'pending', media_type: mediaType,
              video_url: (mediaType === 'REELS' || mediaType === 'VIDEO') ? mediaUrl : null,
              image_url: (mediaType === 'IMAGE') ? mediaUrl : (mediaType === 'STORIES' && !mediaUrl.includes('.mp4') ? mediaUrl : null),
              children_urls: children.length > 0 ? children : null,
              caption, scheduled_at: now.toISOString(),
              planner_id: planner.id
            });
          }
          await supabase.from('planners').update({ last_run: now.toISOString(), config: { ...config, state: state } }).eq('id', planner.id);
        }
      } catch (err: any) { await log(planner.id, `Planner Error: ${err.message}`, 'error'); }
    }

    // 1. Pending -> Processing
    const { data: pendingPosts } = await supabase.from('posts').select('*, channels(*)').eq('status', 'pending').lte('scheduled_at', now.toISOString()).limit(5);

    for (const post of pendingPosts || []) {
      const plannerId = post.planner_id || '8725ea26-6fbe-418a-a52b-eaaca3b6db4e';
      try {
        const accessToken = await resolveAccessToken(post.channels?.access_token, plannerId);
        const accountId = (post.channels?.account_id || '').trim();
        if (!accessToken || !accountId) throw new Error(`Missing credentials`);

        const baseUrl = getBaseUrl(accessToken);
        const mediaType = post.media_type || 'REELS';

        let bodyParams = new URLSearchParams();
        if (mediaType === 'CAROUSEL') {
          const childIds = [];
          for (const child of post.children_urls || []) {
            const childParams = new URLSearchParams({
              is_carousel_item: 'true',
              [child.type === 'video' ? 'video_url' : 'image_url']: child.url
            });
            if (child.type === 'video') childParams.append('media_type', 'VIDEO');

            const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              body: childParams.toString()
            });
            const data = await res.json();
            if (data.id) childIds.push(data.id);
          }
          if (childIds.length > 0) {
            await supabase.from('posts').update({ status: 'processing_children', instagram_child_ids: childIds }).eq('id', post.id);
            results.pending++;
          }
          continue;
        } else if (mediaType === 'IMAGE') {
          bodyParams.append('image_url', post.image_url || '');
          bodyParams.append('caption', post.caption || '');
        } else {
          bodyParams.append('media_type', mediaType === 'STORIES' ? 'STORIES' : 'REELS');
          bodyParams.append('video_url', post.video_url || post.image_url || '');
          bodyParams.append('caption', post.caption || '');
          if (mediaType === 'REELS') {
            bodyParams.append('share_to_feed', 'false');
            bodyParams.append('audio_name', 'Me segue @corpoultra');
          }
        }

        const apiRes = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${accountId}/media`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: bodyParams.toString()
        });

        const data = await apiRes.json();
        if (data.id) {
          await supabase.from('posts').update({ status: 'processing_upload', instagram_container_id: data.id }).eq('id', post.id);
          results.pending++;
        } else {
          await log(plannerId, `Media Creation Failed for post ${post.id}`, 'error', data);
          throw new Error(data.error?.message || "Media Creation Failed");
        }
      } catch (e: any) {
        await log(plannerId, `Phase 1 Error for post ${post.id}: ${e.message}`, 'error', e);
        await supabase.from('posts').update({ status: 'failed', error_message: e.message, failed_reason: "Initialization Failed" }).eq('id', post.id);
        results.errors++;
      }
    }

    // 2. Processing -> Ready
    const { data: processingPosts } = await supabase.from('posts').select('*, channels(*)').in('status', ['processing_upload', 'processing_children']).limit(10);
    for (const post of processingPosts || []) {
      try {
        const accessToken = await resolveAccessToken(post.channels?.access_token);
        const baseUrl = getBaseUrl(accessToken);

        if (post.status === 'processing_children') {
          const childIds = post.instagram_child_ids || [];
          let allFinished = true;
          for (const cid of childIds) {
            const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${cid}?fields=status_code&access_token=${accessToken}`);
            const data = await res.json();
            if (data.status_code !== 'FINISHED') { allFinished = false; break; }
          }
          if (allFinished) {
            const body = new URLSearchParams({
              media_type: 'CAROUSEL',
              children: childIds.join(','),
              caption: post.caption || ''
            });
            const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${post.channels.account_id}/media`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              body: body.toString()
            });
            const data = await res.json();
            if (data.id) await supabase.from('posts').update({ status: 'processing_upload', instagram_container_id: data.id }).eq('id', post.id);
          }
        } else {
          const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${post.instagram_container_id}?fields=status_code&access_token=${accessToken}`);
          const data = await res.json();
          if (data.status_code === 'FINISHED') await supabase.from('posts').update({ status: 'ready_to_publish' }).eq('id', post.id);
          else if (data.status_code === 'ERROR') {
            const msg = `IG Processing Error: ${data.status_code}`;
            await log(post.planner_id, msg, 'error', data);
            await supabase.from('posts').update({ status: 'failed', error_message: msg, failed_reason: "Processing Failed" }).eq('id', post.id);
          }
        }
      } catch (e: any) {
        await log(post.planner_id, `Phase 2 Error for post ${post.id}`, 'error', e);
        await supabase.from('posts').update({ status: 'failed', error_message: e.message, failed_reason: "Processing Exception" }).eq('id', post.id);
      }
    }

    // 3. Ready -> Published
    const { data: readyPosts } = await supabase.from('posts').select('*, channels(*)').eq('status', 'ready_to_publish').limit(5);
    for (const post of readyPosts || []) {
      try {
        const accessToken = await resolveAccessToken(post.channels?.access_token);
        const baseUrl = getBaseUrl(accessToken);
        const res = await fetch(`${baseUrl}/${GRAPH_API_VERSION}/${post.channels.account_id}/media_publish`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ creation_id: post.instagram_container_id }).toString()
        });
        const data = await res.json();
        if (data.id) {
          await supabase.from('posts').update({ status: 'published', published_at: new Date().toISOString() }).eq('id', post.id);
          results.published++;
        } else {
          const msg = data.error?.message || "Publishing Failed";
          await log(post.planner_id, `Phase 3 Error for post ${post.id}: ${msg}`, 'error', data);
          await supabase.from('posts').update({ status: 'failed', error_message: msg, failed_reason: "Publishing Failed" }).eq('id', post.id);
        }
      } catch (e: any) {
        await log(post.planner_id, `Phase 3 Exception for post ${post.id}`, 'error', e);
        await supabase.from('posts').update({ status: 'failed', error_message: e.message, failed_reason: "Publishing Exception" }).eq('id', post.id);
      }
    }

    return new Response(JSON.stringify(results), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders })
  }
})
