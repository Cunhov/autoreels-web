-- CreateTable
CREATE TABLE "youtube_sessions" (
    "remote_id" TEXT NOT NULL PRIMARY KEY,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
