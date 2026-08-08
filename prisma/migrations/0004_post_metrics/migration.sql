-- CreateTable
CREATE TABLE "post_metrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "post_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "plays" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "saved" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "fetched_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "post_metrics_post_id_key" ON "post_metrics"("post_id");

-- CreateIndex
CREATE INDEX "post_metrics_channel_id_fetched_at_idx" ON "post_metrics"("channel_id", "fetched_at");

-- CreateIndex
CREATE INDEX "posts_channel_id_status_published_at_idx" ON "posts"("channel_id", "status", "published_at");

