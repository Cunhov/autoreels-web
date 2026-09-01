-- AlterTable: captions por plataforma na library (youtube.txt / instagram.txt)
ALTER TABLE "content_items" ADD COLUMN "caption_youtube" TEXT;
ALTER TABLE "content_items" ADD COLUMN "caption_instagram" TEXT;
