import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/**
 * P2 承载对象：把「任务」和「运行」从会话与工作区目录里解放出来。
 *
 * 在此之前，任务就是 session（路由是 /qa/project/tasks/:sessionId），运行就是一个
 * output/runs/<run_id>/ 目录加一份 manifest.json。两者都没有数据库行，于是：
 *   - 环境、范围、负责人、被测版本无处可落（G7/G8/G3）；
 *   - 一个任务下的多次运行无法列举，更无法"这次和上次比"（G2）；
 *   - 报告回答不了"这结果是哪个环境的"（报告行连 env 列都没有）。
 *
 * ## qa_runs 是 manifest 的索引，不是第二个真源
 *
 * run 的身份仍由工作区 `output/runs/<run_id>/manifest.json` 定义——`assertNewRun`
 * 与 `assertReportRun` 已经在核 run_id、manifest_version 和 directory_context.session_id。
 * 这张表只把"已经核过的 manifest"登记成一行可查询的记录，字段全部派生自 manifest 与
 * 调用现场，不允许任何写入方绕过 manifest 自行编造 run。删掉整张表不损失事实，只损失
 * 可查询性——这是索引应有的性质。
 *
 * ## task 与 session 目前 1:1，但 task_id 是独立身份
 *
 * 现在一个会话就是一个任务，所以 session_id 上有唯一索引。**task_id 不取 session_id**：
 * 一旦以后一个任务能横跨多个会话（换会话继续跑、把任务转交他人），只需要去掉唯一索引
 * 并把 session 关系搬进关联表，task_id 全程不变；若现在让两者同值，那次改动就要重写
 * 主键，牵连所有 run 与报告引用。
 *
 * ## 回填只覆盖有 QA 痕迹的会话
 *
 * 不按"所有 sessions"回填：闲聊会话、CLI 会话不该凭空长出一个测试任务。判定标准是
 * 该 session 在任一张 QA 事实表里出现过。回填的 task 标 origin='backfill'，与用户真实
 * 创建的任务区分得开；run 回填标 kind='legacy'、run_index=0（0 = 未编号，不是"第 0 次"），
 * 因为历史 run 的真实先后顺序没有记录，编一个序号等于伪造可比性。
 */
export const qaTaskRun: Migration = {
  name: "2026-11-19-qa-task-run",
  // 纯新增表与列：旧平台继续按 session + manifest 工作，读不到也不会写坏这两张表。
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS qa_tasks (
  task_id        TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL,             -- 当前 1:1；未来一任务多会话时改为关联表
  env            TEXT NOT NULL DEFAULT '',  -- 归属环境；'' = 未指定（不假装是某个环境）
  title          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK(status IN ('draft','active','blocked','done','archived')),
  owner_user_id  TEXT,                      -- 任务负责人；确认卡点权限的依据（P2 只记录）
  scope_json     TEXT NOT NULL DEFAULT '{}',-- 范围：模块 / 需求点 / 环境白名单
  sut_version    TEXT,                      -- 被测系统版本；NULL = 未知，绝不写 ''
  context_snapshot_id TEXT,                 -- 启动时 pin 的 qa_task_context_snapshots 行
  origin         TEXT NOT NULL DEFAULT 'created' CHECK(origin IN ('created','backfill')),
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_tasks_session ON qa_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_qa_tasks_project ON qa_tasks(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS qa_runs (
  run_id           TEXT NOT NULL,           -- run 身份来自 manifest；run_id 只在项目内唯一
  task_id          TEXT NOT NULL REFERENCES qa_tasks(task_id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  env              TEXT NOT NULL DEFAULT '', -- 与 task.env 分开存：run 可以跑在非默认环境
  kind             TEXT NOT NULL DEFAULT 'run'
                   CHECK(kind IN ('run','design','execution','regression','retest','legacy')),
  status           TEXT NOT NULL DEFAULT 'created',
  run_index        INTEGER NOT NULL DEFAULT 0, -- 同任务内第几次；0 = 回填未编号
  manifest_path    TEXT NOT NULL DEFAULT '',   -- 相对工作区；空 = 未见 manifest（回填）
  manifest_sha256  TEXT NOT NULL DEFAULT '',   -- manifest 变了能看出来
  manifest_version INTEGER,
  sut_version      TEXT,                       -- 本次运行测的是哪一版
  baseline_hash    TEXT,                       -- 环境基线指纹（P3 填）
  resource_pool    TEXT,                       -- web|api|android|miniprogram
  device_id        TEXT,                       -- 设备 / 浏览器实例；容量约束的落点
  batch_id         TEXT,                       -- 设计批次；run 先于批次时留空
  counts_json      TEXT NOT NULL DEFAULT '{}', -- {passed,failed,skipped,blocked}
  started_at       TEXT,
  finished_at      TEXT,
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- run_id 的语义域是项目：两个项目的测试工作区各自持有一个 run-1，互不相干。
  PRIMARY KEY (project_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_qa_runs_task ON qa_runs(task_id, run_index);
CREATE INDEX IF NOT EXISTS idx_qa_runs_session ON qa_runs(project_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_runs_env ON qa_runs(project_id, env, created_at DESC);

-- 执行资源池租约：一台机器上浏览器/设备/小程序实例的数量是硬上限，超了就会出现
-- "偶发失败"——那不是产品质量问题，是抢同一个设备。租约把"谁在用"显式化：
-- 一个 (pool, slot) 同时只归一个 run，到期自动可被抢占（进程崩了也不会永久占着）。
CREATE TABLE IF NOT EXISTS qa_pool_leases (
  pool         TEXT NOT NULL CHECK(pool IN ('web','api','android','miniprogram')),
  slot         INTEGER NOT NULL,           -- 0..capacity-1
  project_id   TEXT NOT NULL,
  holder_run_id TEXT NOT NULL,
  lease_until  TEXT NOT NULL,              -- ISO；过期即可被其他 run 抢占
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (pool, slot)
);
CREATE INDEX IF NOT EXISTS idx_qa_pool_leases_holder ON qa_pool_leases(project_id, holder_run_id);
`);
    // 报告行是快照：发布时把 env 冻结在行上，不靠 join qa_runs 反查（run 可能先被清理）。
    ensureColumn(db, "qa_report_indexes", "env", "TEXT NOT NULL DEFAULT ''");
    // 缺陷跨环境复现是有价值的事实：首次在哪个环境见到、最后一次又在哪个环境见到。
    ensureColumn(db, "qa_defects", "first_seen_env", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "qa_defects", "last_seen_env", "TEXT NOT NULL DEFAULT ''");

    // 1) 任务回填：只给在 QA 事实表里出现过的会话建档。
    db.exec(`
INSERT OR IGNORE INTO qa_tasks
  (task_id, project_id, session_id, env, title, status, owner_user_id, scope_json,
   origin, created_at, created_by, updated_at)
SELECT
  'task_' || lower(hex(randomblob(10))),
  s.project_id,
  s.session_id,
  COALESCE((SELECT pe.env FROM project_environments pe
             WHERE pe.project_id = s.project_id AND pe.is_default = 1 LIMIT 1), ''),
  COALESCE(s.title, ''),
  'active',
  s.owner_user_id,
  '{}',
  'backfill',
  COALESCE(s.created_at, datetime('now')),
  COALESCE(s.owner_user_id, 'backfill'),
  COALESCE(s.created_at, datetime('now'))
FROM sessions s
WHERE EXISTS (SELECT 1 FROM qa_design_batches b WHERE b.session_id = s.session_id)
   OR EXISTS (SELECT 1 FROM qa_case_results r WHERE r.session_id = s.session_id)
   OR EXISTS (SELECT 1 FROM qa_report_indexes i WHERE i.session_id = s.session_id)
   OR EXISTS (SELECT 1 FROM qa_task_context_snapshots t WHERE t.session_id = s.session_id)
`);
    // 2) 运行回填：从散落在四张事实表里的 run_id 反推运行清单。
    db.exec(`
WITH legacy(project_id, session_id, run_id, seen_at) AS (
  SELECT project_id, session_id, run_id, MIN(created_at) FROM (
    SELECT project_id, session_id, run_id, created_at FROM qa_design_batches
    UNION ALL SELECT project_id, session_id, run_id, created_at FROM qa_case_results
    UNION ALL SELECT project_id, session_id, run_id, created_at FROM qa_report_indexes
    UNION ALL SELECT project_id, session_id, run_id, created_at FROM qa_retests
  )
  WHERE run_id IS NOT NULL AND run_id <> ''
  GROUP BY project_id, session_id, run_id
)
INSERT OR IGNORE INTO qa_runs
  (run_id, task_id, project_id, session_id, env, kind, status, run_index, counts_json,
   started_at, finished_at, created_at, created_by, updated_at)
SELECT l.run_id, t.task_id, l.project_id, l.session_id, t.env, 'legacy', 'legacy', 0, '{}',
       NULL, NULL, COALESCE(l.seen_at, t.created_at), 'backfill', COALESCE(l.seen_at, t.created_at)
FROM legacy l JOIN qa_tasks t ON t.session_id = l.session_id
`);
    // 3) 已有报告与缺陷补 env（能对上 run 的才补，对不上保持 ''，不猜）。
    db.exec(`
UPDATE qa_report_indexes
   SET env = COALESCE((SELECT r.env FROM qa_runs r WHERE r.run_id = qa_report_indexes.run_id), '')
 WHERE env = '';
UPDATE qa_defects
   SET first_seen_env = COALESCE((SELECT r.env FROM qa_runs r WHERE r.run_id = qa_defects.origin_run_id), '')
 WHERE first_seen_env = '';
UPDATE qa_defects
   SET last_seen_env = COALESCE(
         (SELECT r.env FROM qa_defect_occurrences o
            JOIN qa_runs r ON r.run_id = o.run_id
           WHERE o.defect_id = qa_defects.defect_id
           ORDER BY o.observed_at DESC LIMIT 1),
         -- 没有 occurrence 行的老缺陷：它至少在自己的 origin run 里出现过一次。
         (SELECT r.env FROM qa_runs r WHERE r.run_id = qa_defects.origin_run_id),
         '')
 WHERE last_seen_env = '';
`);
  },
  // 回滚丢掉的是"可查询性"，不是事实：run 仍在各自工作区的 manifest 里，任务字段
  // （env/scope/owner）则是本表独有的用户输入，所以这里保留表、只说明后果。
  down() {},
};
