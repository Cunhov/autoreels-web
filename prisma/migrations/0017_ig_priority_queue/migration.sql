-- Fila de prioridade: vídeos novos publicados antes do loop do planner.
-- IF NOT EXISTS: a tabela já foi criada manualmente em produção antes desta
-- migration; o deploy apenas registra a migration e mantém idempotência.
CREATE TABLE IF NOT EXISTS "ig_priority_queue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "content_item_id" TEXT NOT NULL,
    "post_id" TEXT,
    "job_id" TEXT,
    "planner_ids" TEXT,
    "caption" TEXT,
    "scheduled_at" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "loop_added" BOOLEAN NOT NULL DEFAULT false,
    "posted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ig_priority_queue_job_id_key"
    ON "ig_priority_queue"("job_id");

CREATE INDEX IF NOT EXISTS "ig_priority_queue_channel_id_status_idx"
    ON "ig_priority_queue"("channel_id", "status");

CREATE INDEX IF NOT EXISTS "ig_priority_queue_post_id_idx"
    ON "ig_priority_queue"("post_id");

CREATE INDEX IF NOT EXISTS "ig_priority_queue_loop_added_idx"
    ON "ig_priority_queue"("loop_added");
