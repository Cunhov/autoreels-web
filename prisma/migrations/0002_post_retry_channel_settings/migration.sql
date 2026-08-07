-- AlterTable
ALTER TABLE "channels" ADD COLUMN "settings" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_posts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "planner_id" TEXT,
    "video_url" TEXT,
    "image_url" TEXT,
    "thumbnail_url" TEXT,
    "caption" TEXT,
    "media_type" TEXT,
    "children_urls" TEXT,
    "share_to_feed" BOOLEAN NOT NULL DEFAULT true,
    "location_id" TEXT,
    "collaborators" TEXT,
    "audio_configuration" TEXT,
    "user_tags" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scheduled_at" DATETIME,
    "published_at" DATETIME,
    "error_message" TEXT,
    "failed_reason" TEXT,
    "instagram_media_id" TEXT,
    "instagram_container_id" TEXT,
    "instagram_child_ids" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" DATETIME,
    "container_created_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "posts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "posts_planner_id_fkey" FOREIGN KEY ("planner_id") REFERENCES "planners" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_posts" ("audio_configuration", "caption", "channel_id", "children_urls", "collaborators", "created_at", "error_message", "failed_reason", "id", "image_url", "instagram_child_ids", "instagram_container_id", "instagram_media_id", "location_id", "media_type", "planner_id", "published_at", "scheduled_at", "share_to_feed", "status", "thumbnail_url", "user_id", "user_tags", "video_url") SELECT "audio_configuration", "caption", "channel_id", "children_urls", "collaborators", "created_at", "error_message", "failed_reason", "id", "image_url", "instagram_child_ids", "instagram_container_id", "instagram_media_id", "location_id", "media_type", "planner_id", "published_at", "scheduled_at", "share_to_feed", "status", "thumbnail_url", "user_id", "user_tags", "video_url" FROM "posts";
DROP TABLE "posts";
ALTER TABLE "new_posts" RENAME TO "posts";
CREATE INDEX "posts_user_id_status_idx" ON "posts"("user_id", "status");
CREATE INDEX "posts_user_id_scheduled_at_idx" ON "posts"("user_id", "scheduled_at");
CREATE INDEX "posts_user_id_created_at_idx" ON "posts"("user_id", "created_at");
CREATE INDEX "posts_status_scheduled_at_idx" ON "posts"("status", "scheduled_at");
CREATE INDEX "posts_channel_id_idx" ON "posts"("channel_id");
CREATE INDEX "posts_planner_id_idx" ON "posts"("planner_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

