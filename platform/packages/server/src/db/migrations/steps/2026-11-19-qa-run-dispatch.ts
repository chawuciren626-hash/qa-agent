import { ensureColumn } from "../../database.js";
import type { Migration } from "../migration.js";

/**
 * 判据 1 的执行侧：让 run 先"被派发"、再"被领取"、最后"被回填"。
 *
 * 在此之前 run 只有一个来源——执行器已经把 manifest 写完，调用方再调 `observeRun`
 * 把结果登记进来。数据流是单向的"结果 → 索引"，所以服务端从来没有"待执行的 run"，
 * `run_id` 也就无法从派发一路追到报告：派发那一刻还没有任何行，报告那一刻行才出现，
 * 中间这段只能靠人去比对目录名。
 *
 * 这一层不改变"manifest 才是事实真源"的性质：
 *   - `dispatch_json` 只存**派发意图**（要跑哪份计划、哪个环境、期望的幂等键），
 *     不存执行结果；
 *   - 回填仍走 `observeRun`（校验 manifest 指纹后才登记），本表不接收任何自报结果；
 *   - `claimed_by/lease_until` 是**租约**不是所有权：执行器崩溃后租约过期，另一个
 *     执行器可以重领，`attempts` 记下重领次数。没有租约，一个挂掉的执行器会让任务
 *     永远停在"执行中"，且没人能判断是真的在跑还是已经死了。
 *
 * 为什么要 status 索引：领取是"找最老的一条可领 run"。没有这条索引，每次领取都扫全表；
 * 更重要的是加了索引之后这个查询的代价与待办数量无关，本地执行器的轮询才敢跑成秒级。
 */
export const qaRunDispatch: Migration = {
  name: "2026-11-19-qa-run-dispatch",
  // 纯新增列与索引：旧构建读不到这些列也不会写坏（SELECT * 后按名字取）。
  swapSafe: true,
  up(db) {
    ensureColumn(db, "qa_runs", "dispatch_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn(db, "qa_runs", "claimed_by", "TEXT");
    ensureColumn(db, "qa_runs", "claimed_at", "TEXT");
    ensureColumn(db, "qa_runs", "lease_until", "TEXT");
    ensureColumn(db, "qa_runs", "attempts", "INTEGER NOT NULL DEFAULT 0");
    db.exec("CREATE INDEX IF NOT EXISTS idx_qa_runs_claim ON qa_runs(project_id, status, lease_until)");
  },
  // 回滚只丢租约与派发意图；run 行本身与 manifest 索引保留（它们不依赖这几列）。
  down(db) {
    for (const column of ["dispatch_json", "claimed_by", "claimed_at", "lease_until", "attempts"]) {
      db.exec(`ALTER TABLE qa_runs DROP COLUMN ${column}`);
    }
  },
};
