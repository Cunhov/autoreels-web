-- AlterTable
ALTER TABLE "posts" ADD COLUMN "youtube_type" TEXT;
ALTER TABLE "posts" ADD COLUMN "youtube_video_id" TEXT;
ALTER TABLE "posts" ADD COLUMN "youtube_post_id" TEXT;
ALTER TABLE "posts" ADD COLUMN "youtube_options" TEXT;

-- CreateIndex
CREATE INDEX "posts_youtube_video_id_idx" ON "posts" ("youtube_video_id");
