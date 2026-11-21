import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/**
 * 端维度建模（B1-7）：项目 = 产品，端是项目内维度。
 *
 * - `project_environments.end_type`：环境所属端。一个产品多端（前台/后台/App/小程序/桌面）
 *   共存于一个项目，环境按端 × 环境名区分；''= 未指定（存量环境保持可达，不强制回填）。
 *   枚举校验在 service 层（END_TYPES），表层不加 CHECK——端清单会演进，迁移是冻结 DDL。
 * - `qa_local_tasks.ends_json` / `platform_task_links.ends_json`：任务声明的涉及端集合
 *   （JSON 字符串数组）。本地任务由创建/编辑表单选择；平台任务的端来自上游任务详情，
 *   产品线 → 端归一化映射配置在后续批次接入，这里先预留列。
 *
 * 全部可空/带缺省、无 CHECK：正确性由写入方保证，读路径按"未指定"处理。
 */
export const endDimensions: Migration = {
  name: "2026-11-21-end-dimensions",
  swapSafe: true,
  up(db) {
    ensureColumn(db, "project_environments", "end_type", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "qa_local_tasks", "ends_json", "TEXT");
    ensureColumn(db, "platform_task_links", "ends_json", "TEXT");
  },
  down(db) {
    db.exec("ALTER TABLE platform_task_links DROP COLUMN ends_json");
    db.exec("ALTER TABLE qa_local_tasks DROP COLUMN ends_json");
    db.exec("ALTER TABLE project_environments DROP COLUMN end_type");
  },
};
