-- AlterTable: campos TikTok no Post (v1 — apenas vídeo)
-- Gap S3: schema.prisma declara tiktok_type/tiktok_post_id/tiktok_publish_id/
-- tiktok_options/tiktok_status + índice desde A2/A4, mas 0011/0012 só cobriram
-- content_items.caption_tiktok. DB fresco criado por `migrate deploy` ficava sem
-- as colunas → "no such column: posts.tiktok_*" no runtime (publisher/planner).
-- Mesmo padrão aditivo de 0005 (youtube_post_fields). Idempotente: colunas
-- novas, sem transformação; db-migrate.sh aplica via journal (uma única vez).
ALTER TABLE "posts" ADD COLUMN "tiktok_type" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_post_id" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_publish_id" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_options" TEXT;
ALTER TABLE "posts" ADD COLUMN "tiktok_status" TEXT;

-- CreateIndex (naming espelha posts_youtube_video_id_idx)
CREATE INDEX "posts_tiktok_post_id_idx" ON "posts" ("tiktok_post_id");