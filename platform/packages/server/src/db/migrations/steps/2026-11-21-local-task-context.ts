import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/**
 * 平台/本地任务上下文列（T5 扩展 + 总控预分析进行态）。
 *
 * 本地任务（qa_local_tasks）：
 * - `env_name` / `env_base_url`：任务保存时由路由层解析——填了 URL 先按 base_url 精确匹配
 *   项目环境、再按主机名匹配，命中复用其 env 名，未命中才登记新环境；这里存的是关联
 *   结果（env 名 + URL 快照）。NULL/空 = 任务没填环境，开始测试时不做绑定，行为与从前一致。
 * - `account`：登录账号（选填，≤128）。只作为 AI 分析简报与详情展示进入链路；密码明确
 *   不落任务表（凭据只在探索轮次输入，口径同 project_environments）。
 *
 * 两张任务表（qa_local_tasks + platform_task_links）：
 * - `analysis_session_id` / `analysis_state` / `analysis_error`：总控预分析进行态——
 *   analyze 登记 running 并发简报即返回，结论由总控经 analysis-result 异步回写（done）；
 *   派发/回写失败落 failed + analysis_error。NULL = 未发起或走同步模型通道（与状态机解耦）。
 *   注意：这三列 schema.ts 的 CREATE TABLE 已带，但存量库必须靠本迁移补齐——否则升级后
 *   第一次列表查询就 no such column。
 *
 * 全部可空、无 CHECK：正确性由写入方（service）保证，读路径按"未填/未发起"处理。
 */
export const localTaskContext: Migration = {
  name: "2026-11-21-local-task-context",
  swapSafe: true,
  up(db) {
    ensureColumn(db, "qa_local_tasks", "env_name", "TEXT");
    ensureColumn(db, "qa_local_tasks", "env_base_url", "TEXT");
    ensureColumn(db, "qa_local_tasks", "account", "TEXT");
    ensureColumn(db, "qa_local_tasks", "analysis_session_id", "TEXT");
    ensureColumn(db, "qa_local_tasks", "analysis_state", "TEXT");
    ensureColumn(db, "qa_local_tasks", "analysis_error", "TEXT");
    ensureColumn(db, "platform_task_links", "analysis_session_id", "TEXT");
    ensureColumn(db, "platform_task_links", "analysis_state", "TEXT");
    ensureColumn(db, "platform_task_links", "analysis_error", "TEXT");
  },
  down(db) {
    db.exec("ALTER TABLE platform_task_links DROP COLUMN analysis_error");
    db.exec("ALTER TABLE platform_task_links DROP COLUMN analysis_state");
    db.exec("ALTER TABLE platform_task_links DROP COLUMN analysis_session_id");
    db.exec("ALTER TABLE qa_local_tasks DROP COLUMN analysis_error");
    db.exec("ALTER TABLE qa_local_tasks DROP COLUMN analysis_state");
    db.exec("ALTER TABLE qa_local_tasks DROP COLUMN analysis_session_id");
    db.exec("ALTER TABLE qa_local_tasks DROP COLUMN account");
    db.exec("ALTER TABLE qa_local_tasks DROP COLUMN env_base_url");
    db.exec("ALTER TABLE qa_local_tasks DROP COLUMN env_name");
  },
};
