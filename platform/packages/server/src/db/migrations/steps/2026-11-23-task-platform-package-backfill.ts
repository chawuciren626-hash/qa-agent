import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/**
 * 存量回填标记（P1-B）：资料字段（需求基准/自测摘要等）晚于首轮同步上线，
 * 部署升级后按 backfilled_at 幂等补齐已接收包。
 * 独立迁移的原因：base 迁移（2026-11-20-task-platform-integration）已在本机数据库
 * 的迁移账本中入账，修改它不会让旧库重跑——新列必须以新迁移下发。
 */
export const taskPlatformPackageBackfill: Migration = {
  name: "2026-11-23-task-platform-package-backfill",
  swapSafe: true,
  up(db) {
    ensureColumn(db, "task_platform_packages", "backfilled_at", "TEXT");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tp_packages_backfill
      ON task_platform_packages(backfilled_at, task_link_id)`);
  },
  down(db) {
    db.exec("DROP INDEX IF EXISTS idx_tp_packages_backfill");
    db.exec("ALTER TABLE task_platform_packages DROP COLUMN backfilled_at");
  },
};
