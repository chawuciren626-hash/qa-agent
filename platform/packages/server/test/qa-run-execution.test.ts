/**
 * 执行登记（判据 1 排查线）的单元测试。
 *
 * 断言的重点不是"能进能出"，而是几条一旦写错就会**静默**破坏可追溯性的语义：
 *   - 发起就有一行 `running`，不是"跑完才出现"；
 *   - 同一会话可以有多个 run 并行（产品里没有排队，也没有容量锁）；
 *   - 结束必须来自同一次发起：`facts.run_id` 不一致会经 observeRun 另插一条 run；
 *   - 已结束的 run 不能再次回填（否则旧结果会覆盖新结果）；
 *   - 中断不写库、不自动重跑：只在读时按阈值标 `stalled`。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaTaskRunRegistry, type RunManifestFacts } from "../src/services/qa-task-run-registry.js";
import type { KnowledgeDb } from "../src/services/qa-project-knowledge.js";

let db: DatabaseSync;
let registry: QaTaskRunRegistry;
let clock = 1_700_000_000_000;
let seq = 0;

const STALE = 30 * 60 * 1000;

beforeEach(() => {
  clock = 1_700_000_000_000;
  seq = 0;
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE qa_tasks (
      task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      env TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', owner_user_id TEXT,
      scope_json TEXT NOT NULL DEFAULT '{}', sut_version TEXT, context_snapshot_id TEXT,
      origin TEXT NOT NULL DEFAULT 'created', created_at TEXT NOT NULL,
      created_by TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_qa_tasks_session ON qa_tasks(session_id);
    CREATE TABLE qa_runs (
      run_id TEXT NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
      session_id TEXT NOT NULL, env TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'run',
      status TEXT NOT NULL DEFAULT 'created', run_index INTEGER NOT NULL DEFAULT 0,
      manifest_path TEXT NOT NULL DEFAULT '', manifest_sha256 TEXT NOT NULL DEFAULT '',
      manifest_version INTEGER, sut_version TEXT, baseline_hash TEXT, resource_pool TEXT,
      device_id TEXT, batch_id TEXT, counts_json TEXT NOT NULL DEFAULT '{}',
      dispatch_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL,
      created_by TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, run_id)
    );
    CREATE INDEX idx_qa_runs_running ON qa_runs(project_id, status, started_at);
    CREATE TABLE qa_case_results (
      project_id TEXT NOT NULL, run_id TEXT NOT NULL, case_key TEXT NOT NULL, status TEXT NOT NULL
    );
  `);
  registry = new QaTaskRunRegistry(db as unknown as KnowledgeDb, () => clock, () => `uuid-${++seq}`, STALE);
});

afterEach(() => db.close());

const start = (runId: string, sessionId = "s1", dispatch: Record<string, unknown> = { plan: `plans/${runId}.yaml` }) =>
  registry.startRun({ projectId: "p1", sessionId, userId: "u1", runId, dispatch });

const facts = (runId: string, over: Partial<RunManifestFacts> = {}): RunManifestFacts => ({
  runId,
  status: "completed",
  manifestVersion: 1,
  resourcePool: "web",
  sutVersion: null,
  baselineHash: null,
  ...over,
});

const finish = (runId: string, over: Partial<RunManifestFacts> = {}, counts: Record<string, number> = { passed: 2 }) =>
  registry.finishRun({
    projectId: "p1",
    runId,
    facts: facts(runId, over),
    manifestPath: `output/runs/${runId}/manifest.json`,
    manifestSha256: "sha256:abc",
    counts,
  });

describe("开始（startRun）", () => {
  it("发起即 running，带上发起载荷，run_index 从 1 递增", () => {
    const first = start("run-1");
    const second = start("run-2");
    expect(first.status).toBe("running");
    expect(first.runIndex).toBe(1);
    expect(second.runIndex).toBe(2);
    expect(first.startedAt).not.toBeNull();
    expect(first.finishedAt).toBeNull();
    expect(first.dispatch).toEqual({ plan: "plans/run-1.yaml" });
    expect(first.manifestPath).toBe("");
    expect(first.stalled).toBe(false);
  });

  it("同一 run_id 重复发起直接拒绝，不静默覆盖", () => {
    start("run-1");
    expect(() => start("run-1")).toThrow(/already exists/);
  });

  it("同一会话的多个 run 并行存在，互不干扰", () => {
    start("run-1");
    start("run-2");
    const runs = registry.listRuns("p1", "s1");
    expect(runs.map((run) => run.runId)).toEqual(["run-2", "run-1"]);
    expect(runs.every((run) => run.status === "running")).toBe(true);
  });

  it("不同会话各自编号，但都属于同一项目", () => {
    start("run-1", "s1");
    start("run-2", "s2");
    expect(registry.listRuns("p1", "s1").map((run) => run.runId)).toEqual(["run-1"]);
    expect(registry.listRuns("p1", "s2").map((run) => run.runId)).toEqual(["run-2"]);
  });
});

describe("结束（finishRun）", () => {
  it("写回 manifest 事实与统计，状态收敛", () => {
    start("run-1");
    const run = finish("run-1");
    expect(run.status).toBe("completed");
    expect(run.manifestPath).toBe("output/runs/run-1/manifest.json");
    expect(run.manifestSha256).toBe("sha256:abc");
    expect(run.counts).toEqual({ passed: 2 });
    expect(run.finishedAt).not.toBeNull();
    expect(run.stalled).toBe(false);
  });

  it("没发起过就结束：报错，不凭空造一条记录", () => {
    expect(() => finish("run-9")).toThrow(/not found/);
    expect(registry.run("p1", "run-9")).toBeNull();
  });

  it("facts.run_id 与发起的 run_id 不一致被拒绝，不产生第二条 run", () => {
    start("run-1");
    expect(() => finish("run-1", { runId: "run-other" })).toThrow(/but this run is run-1/);
    expect(registry.run("p1", "run-other")).toBeNull();
    expect(registry.run("p1", "run-1")?.status).toBe("running");
  });

  it("已结束的 run 不能再次回填：旧结果不许覆盖新结果", () => {
    start("run-1");
    finish("run-1", {}, { passed: 2 });
    expect(() => finish("run-1", {}, { passed: 9 })).toThrow(/not running/);
    expect(registry.run("p1", "run-1")?.counts).toEqual({ passed: 2 });
  });

  it("失败的结论也照实登记，不改写成通过", () => {
    start("run-1");
    const run = finish("run-1", { status: "failed" }, { passed: 1, failed: 3 });
    expect(run.status).toBe("failed");
    expect(run.counts).toEqual({ passed: 1, failed: 3 });
  });
});

describe("疑似中断（stalled，读时派生）", () => {
  it("running 超过阈值才标 stalled，且不写库", () => {
    start("run-1");
    clock += STALE + 1;
    const run = registry.run("p1", "run-1")!;
    expect(run.status).toBe("running");
    expect(run.stalled).toBe(true);
    // 状态没被改写：判定留在读侧，下一次读仍按当时的时间算。
    expect(db.prepare("SELECT status FROM qa_runs WHERE run_id = 'run-1'").get()).toEqual({ status: "running" });
  });

  it("阈值内不标 stalled", () => {
    start("run-1");
    clock += STALE - 1000;
    expect(registry.run("p1", "run-1")?.stalled).toBe(false);
  });

  it("已结束的 run 不会因为时间流逝变成 stalled", () => {
    start("run-1");
    finish("run-1");
    clock += STALE * 10;
    expect(registry.run("p1", "run-1")?.stalled).toBe(false);
  });

  it("中断后由人重跑：新 run_id 与旧记录并存，可对比", () => {
    start("run-1");
    clock += STALE + 1;
    expect(registry.run("p1", "run-1")?.stalled).toBe(true);
    start("run-2");
    finish("run-2");
    const runs = registry.listRuns("p1", "s1");
    expect(runs.map((run) => [run.runId, run.status, run.stalled])).toEqual([
      ["run-2", "completed", false],
      ["run-1", "running", true],
    ]);
  });
});
