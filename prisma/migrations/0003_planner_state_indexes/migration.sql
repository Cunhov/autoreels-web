-- AlterTable
ALTER TABLE "planners" ADD COLUMN "state" TEXT;

-- CreateIndex
CREATE INDEX "planner_logs_created_at_idx" ON "planner_logs" ("created_at");

-- CreateIndex
CREATE INDEX "planners_status_idx" ON "planners" ("status");

-- CreateIndex
CREATE INDEX "posts_status_created_at_idx" ON "posts" ("status", "created_at");

-- CreateIndex
CREATE INDEX "posts_planner_id_status_idx" ON "posts" ("planner_id", "status");
