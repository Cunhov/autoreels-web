-- CreateTable
CREATE TABLE "cron_locks" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "locked_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "owner" TEXT
);
