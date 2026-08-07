-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" DATETIME,
    "image" TEXT,
    "password" TEXT
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "app_config" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "access_token" TEXT,
    "token_source" TEXT DEFAULT 'manual',
    "token_expires_at" DATETIME,
    "token_refreshed_at" DATETIME,
    "account_id" TEXT,
    "username" TEXT,
    "profile_picture_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "planners" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_run" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "planners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "planner_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planner_id" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "details" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "planner_logs_planner_id_fkey" FOREIGN KEY ("planner_id") REFERENCES "planners" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "type" TEXT NOT NULL,
    "url" TEXT,
    "thumbnail_url" TEXT,
    "path" TEXT,
    "name" TEXT,
    "title" TEXT,
    "tags" TEXT,
    "size" INTEGER,
    "duration" REAL,
    "caption" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "content_items_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "content_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "posts" (
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
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "posts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "posts_planner_id_fkey" FOREIGN KEY ("planner_id") REFERENCES "planners" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_ChannelToPlanner" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_ChannelToPlanner_A_fkey" FOREIGN KEY ("A") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_ChannelToPlanner_B_fkey" FOREIGN KEY ("B") REFERENCES "planners" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE INDEX "channels_user_id_status_idx" ON "channels"("user_id", "status");

-- CreateIndex
CREATE INDEX "channels_platform_status_idx" ON "channels"("platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channels_user_id_account_id_key" ON "channels"("user_id", "account_id");

-- CreateIndex
CREATE INDEX "planners_user_id_status_idx" ON "planners"("user_id", "status");

-- CreateIndex
CREATE INDEX "planners_user_id_created_at_idx" ON "planners"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "planner_logs_planner_id_created_at_idx" ON "planner_logs"("planner_id", "created_at");

-- CreateIndex
CREATE INDEX "content_items_parent_id_idx" ON "content_items"("parent_id");

-- CreateIndex
CREATE INDEX "content_items_user_id_parent_id_name_idx" ON "content_items"("user_id", "parent_id", "name");

-- CreateIndex
CREATE INDEX "content_items_user_id_parent_id_created_at_idx" ON "content_items"("user_id", "parent_id", "created_at");

-- CreateIndex
CREATE INDEX "content_items_user_id_type_idx" ON "content_items"("user_id", "type");

-- CreateIndex
CREATE INDEX "posts_user_id_status_idx" ON "posts"("user_id", "status");

-- CreateIndex
CREATE INDEX "posts_user_id_scheduled_at_idx" ON "posts"("user_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "posts_user_id_created_at_idx" ON "posts"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "posts_status_scheduled_at_idx" ON "posts"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "posts_channel_id_idx" ON "posts"("channel_id");

-- CreateIndex
CREATE INDEX "posts_planner_id_idx" ON "posts"("planner_id");

-- CreateIndex
CREATE UNIQUE INDEX "_ChannelToPlanner_AB_unique" ON "_ChannelToPlanner"("A", "B");

-- CreateIndex
CREATE INDEX "_ChannelToPlanner_B_index" ON "_ChannelToPlanner"("B");

