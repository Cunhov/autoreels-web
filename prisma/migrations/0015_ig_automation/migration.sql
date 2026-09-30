-- CreateTable
CREATE TABLE "ig_automations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "trigger" TEXT NOT NULL DEFAULT 'comment',
    "keywords" TEXT NOT NULL,
    "match_mode" TEXT NOT NULL DEFAULT 'any',
    "match_type" TEXT NOT NULL DEFAULT 'contains',
    "negative_keywords" TEXT,
    "media_ids" TEXT,
    "first_interaction_only" BOOLEAN NOT NULL DEFAULT false,
    "cooldown_hours" INTEGER,
    "daily_limit" INTEGER,
    "quiet_hours" TEXT,
    "settings" TEXT,
    "stats_sent" INTEGER NOT NULL DEFAULT 0,
    "stats_matched" INTEGER NOT NULL DEFAULT 0,
    "stats_failed" INTEGER NOT NULL DEFAULT 0,
    "stats_clicks" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ig_automations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_automations_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ig_automation_actions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "automation_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL,
    "delay_seconds" INTEGER NOT NULL DEFAULT 0,
    "text_variants" TEXT,
    "buttons" TEXT,
    "quick_replies" TEXT,
    "media_url" TEXT,
    "tag" TEXT,
    "sequence_id" TEXT,
    "webhook_id" TEXT,
    "ai_prompt" TEXT,
    "config" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ig_automation_actions_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "ig_automations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ig_substances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT,
    "keyword" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "url" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ig_contacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "ig_user_id" TEXT NOT NULL,
    "username" TEXT,
    "name" TEXT,
    "profile_picture" TEXT,
    "tags" TEXT,
    "notes" TEXT,
    "custom_fields" TEXT,
    "bot_paused_until" DATETIME,
    "last_message_at" DATETIME,
    "last_comment_at" DATETIME,
    "interactions_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ig_contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_contacts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ig_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "automation_id" TEXT,
    "contact_id" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'in',
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "ig_event_id" TEXT,
    "media_id" TEXT,
    "text" TEXT,
    "username" TEXT,
    "from_ig_id" TEXT,
    "payload" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ig_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_events_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_events_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "ig_automations" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ig_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "ig_contacts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ig_action_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "automation_id" TEXT,
    "contact_id" TEXT,
    "event_id" TEXT,
    "action_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "request" TEXT,
    "response" TEXT,
    "error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ig_action_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_action_logs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_action_logs_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "ig_automations" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ig_action_logs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "ig_contacts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ig_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "type" TEXT NOT NULL,
    "run_at" DATETIME NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "locked_at" DATETIME,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ig_sequences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "steps" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ig_sequences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_sequences_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ig_sequence_enrollments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sequence_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "next_run_at" DATETIME,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ig_sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "ig_sequences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_sequence_enrollments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "ig_contacts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_sequence_enrollments_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ig_channel_state" (
    "channel_id" TEXT NOT NULL PRIMARY KEY,
    "subscribed_fields" TEXT,
    "last_checked_at" DATETIME,
    "last_event_at" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "last_error" TEXT,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ig_channel_state_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ig_clicks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "automation_id" TEXT,
    "contact_id" TEXT,
    "slug" TEXT NOT NULL,
    "target_url" TEXT NOT NULL,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_click_at" DATETIME,
    CONSTRAINT "ig_clicks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ig_clicks_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ig_clicks_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "ig_automations" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ig_outbound_webhooks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "events" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ig_outbound_webhooks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ig_automations_user_id_channel_id_idx" ON "ig_automations"("user_id", "channel_id");

-- CreateIndex
CREATE INDEX "ig_automations_channel_id_enabled_priority_idx" ON "ig_automations"("channel_id", "enabled", "priority");

-- CreateIndex
CREATE INDEX "ig_automation_actions_automation_id_position_idx" ON "ig_automation_actions"("automation_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ig_substances_keyword_key" ON "ig_substances"("keyword");

-- CreateIndex
CREATE INDEX "ig_contacts_user_id_channel_id_idx" ON "ig_contacts"("user_id", "channel_id");

-- CreateIndex
CREATE INDEX "ig_contacts_username_idx" ON "ig_contacts"("username");

-- CreateIndex
CREATE UNIQUE INDEX "ig_contacts_channel_id_ig_user_id_key" ON "ig_contacts"("channel_id", "ig_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ig_events_dedupe_key_key" ON "ig_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "ig_events_channel_id_created_at_idx" ON "ig_events"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "ig_events_automation_id_created_at_idx" ON "ig_events"("automation_id", "created_at");

-- CreateIndex
CREATE INDEX "ig_events_contact_id_created_at_idx" ON "ig_events"("contact_id", "created_at");

-- CreateIndex
CREATE INDEX "ig_events_user_id_direction_created_at_idx" ON "ig_events"("user_id", "direction", "created_at");

-- CreateIndex
CREATE INDEX "ig_action_logs_channel_id_created_at_idx" ON "ig_action_logs"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "ig_action_logs_automation_id_created_at_idx" ON "ig_action_logs"("automation_id", "created_at");

-- CreateIndex
CREATE INDEX "ig_jobs_status_run_at_idx" ON "ig_jobs"("status", "run_at");

-- CreateIndex
CREATE INDEX "ig_jobs_channel_id_idx" ON "ig_jobs"("channel_id");

-- CreateIndex
CREATE INDEX "ig_sequences_user_id_channel_id_idx" ON "ig_sequences"("user_id", "channel_id");

-- CreateIndex
CREATE INDEX "ig_sequence_enrollments_status_next_run_at_idx" ON "ig_sequence_enrollments"("status", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "ig_sequence_enrollments_sequence_id_contact_id_key" ON "ig_sequence_enrollments"("sequence_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "ig_clicks_slug_key" ON "ig_clicks"("slug");

-- CreateIndex
CREATE INDEX "ig_clicks_automation_id_created_at_idx" ON "ig_clicks"("automation_id", "created_at");

-- CreateIndex
CREATE INDEX "ig_outbound_webhooks_user_id_idx" ON "ig_outbound_webhooks"("user_id");

