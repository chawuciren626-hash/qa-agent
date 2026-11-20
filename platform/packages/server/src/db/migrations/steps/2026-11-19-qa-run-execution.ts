import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/**
 * 判据 1 的排查线：run 从"跑完才第一次出现"变成"发起时就有一行"。
 *
 * 在此之前 run 只有一个入口——执行完、写好 manifest，调用方再调 `observeRun` 把结果
 * 登记进来。于是"发起执行"这个动作在库里没有任何痕迹：执行器没启动、浏览器崩了、
 * 会话被关掉，三者在数据上长得一模一样，都是"什么都没有"。排查只能去那台机器上翻
 * `output/runs/` 目录。
 *
 * **没有队列。** 产品模型是"用户发起会话，会话里就跑起来"，多个会话天然并行；不存在
 * "等待被某个执行器领走"的任务池。所以这里只有 `dispatch_json` 一列（记下要跑哪份计划、
 * 哪个环境），没有 claimed_by / lease_until / attempts——那套是任务池的语义，加进来
 * 只会让一个不存在的调度问题看起来像是被解决了。
 *
 * 中断怎么表达：`status='running'` 而 `started_at` 长期不推进。读的时候由 registry
 * 按阈值标 `stalled`（疑似中断），**不自动重跑**——真机上有写操作（建用户、注销），
 * 自动续跑等于重复执行。人重跑会产生新的 run_id，两次记录都在，可对比。
 */
export const qaRunExecution: Migration = {
  name: "2026-11-19-qa-run-execution",
  // 纯新增列与索引：旧构建读不到也不会写坏（SELECT * 后按名字取）。
  swapSafe: true,
  up(db) {
    ensureColumn(db, "qa_runs", "dispatch_json", "TEXT NOT NULL DEFAULT '{}'");
    // 疑似中断的判定要按"正在跑 + 开始时间"筛，没有这条索引就退化成全表扫。
    db.exec("CREATE INDEX IF NOT EXISTS idx_qa_runs_running ON qa_runs(project_id, status, started_at)");
  },
  // 回滚只丢发起时的意图；run 行与 manifest 索引保留（它们不依赖这一列）。
  down(db) {
    db.exec("ALTER TABLE qa_runs DROP COLUMN dispatch_json");
  },
};
