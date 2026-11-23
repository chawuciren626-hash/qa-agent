import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/** Adds durable retry state to the already-released task-platform event table. */
export const taskPlatformEventRetry: Migration = {
  name: "2026-11-23-task-platform-event-retry",
  swapSafe: true,
  up(db) {
    ensureColumn(db, "task_platform_events", "process_status", "TEXT NOT NULL DEFAULT 'pending'");
    ensureColumn(db, "task_platform_events", "process_attempts", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "task_platform_events", "process_next_retry_at", "TEXT");
    ensureColumn(db, "task_platform_events", "process_last_error", "TEXT");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tp_events_retry
      ON task_platform_events(process_status, process_next_retry_at)`);
  },
  down(db) {
    db.exec("DROP INDEX IF EXISTS idx_tp_events_retry");
    db.exec("ALTER TABLE task_platform_events DROP COLUMN process_last_error");
    db.exec("ALTER TABLE task_platform_events DROP COLUMN process_next_retry_at");
    db.exec("ALTER TABLE task_platform_events DROP COLUMN process_attempts");
    db.exec("ALTER TABLE task_platform_events DROP COLUMN process_status");
  },
};
