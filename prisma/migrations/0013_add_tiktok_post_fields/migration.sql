-- Migration 0013_add_tiktok_post_fields — versão consolidadA (S2 ∧ S3 ∧ S4)
-- Post.tiktok_* columns were declared in schema.prisma (A4) WITHOUT a migration:
-- 0011 is a no-op and 0012 only adds content_items.caption_tiktok. Production
-- `migrate deploy` therefore leaves `posts` without tiktok_type/tiktok_options/
-- tiktok_post_id/tiktok_publish_id/tiktok_status, and EVERY planner post create
-- (buildPostData sets tiktok_type/tiktok_options/tiktok_post_id explicitly, even
-- NULL for non-TikTok channels) fails on SQLite with
-- "table posts has no column named tiktok_type".
-- Style: additive, mirrors 0005_youtube_post_fields. Idempotente p/ db-migrate.sh
-- (legacy DBs pass by `db push` alignment antes do migrate deploy; managed/fresh
-- rodam esta migration uma única vez).
--
-- A UNIÃO das 3 propostas (S2/S3/S4) é idêntica: as 3 variações adicionam
-- exatamente as mesmas 5 colunas + mesmo índice — a divergência era só de
-- comentários, não de DDL. Nada de campo foi perdido na fusão.
ALTER TABLE "posts" ADD COLUMN "tiktok_type" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_post_id" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_publish_id" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_options" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_status" TEXT;

-- CreateIndex (naming espelha posts_youtube_video_id_idx)
CREATE INDEX "posts_tiktok_post_id_idx" ON "posts" ("tiktok_post_id");