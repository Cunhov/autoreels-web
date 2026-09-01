-- AlterTable: caption TikTok na library (tiktok.txt)
-- Idempotente p/ db-migrate.sh (mesmo padrão 0009/0010).
ALTER TABLE "content_items" ADD COLUMN "caption_tiktok" TEXT;
