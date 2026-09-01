-- Migration 0011_add_tiktok_channel_fields
-- TikTok integration uses Channel.settings JSON (tiktok_open_id, tiktok_access_token, tiktok_refresh_token, tiktok_expires_at, etc.)
-- and existing proxy_url/proxy_enabled columns. Channel.platform is String, no enum to alter.
-- No DDL required for A1; this migration is intentionally idempotent/no-op to keep db-migrate.sh compatible.
-- If a future schema introduces a provider enum, add 'tiktok' to it there (ALTER TYPE / recreate).
SELECT 1;
