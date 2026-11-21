import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/**
 * 变更分析输入通道（B7-1）：任务可关联实现分支 / MR 标识。
 * change_source 是"变更分析"的证据指针（diff 从这里拉取），本轮只落字段与简报注入；
 * diff 内容的拉取与装配在后续批次（需先定 MR API 拉取 vs 本地导出形态）。
 */
export const changeSource: Migration = {
  name: "2026-11-22-change-source",
  swapSafe: true,
  up(db) {
    ensureColumn(db, "qa_local_tasks", "change_source", "TEXT");
    ensureColumn(db, "platform_task_links", "change_source", "TEXT");
  },
  down(db) {
    db.exec("ALTER TABLE platform_task_links DROP COLUMN change_source");
    db.exec("ALTER TABLE qa_local_tasks DROP COLUMN change_source");
  },
};
