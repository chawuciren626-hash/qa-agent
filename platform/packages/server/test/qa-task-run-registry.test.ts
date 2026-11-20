/**
 * 任务/运行登记簿的单元测试（P2）。
 *
 * 断言的重点不是"能存能取"，而是几条容易写错的语义：
 *   - 重复 ensureTask 不许覆盖用户填的 env；
 *   - 同一个 run_id 永远是同一次运行（重复登记只刷新派生字段，不换号）；
 *   - 回填行占 0 号，新运行从 1 起，两者不互相污染；
 *   - 环境或被测版本不同的两次运行，对比结果仍给出，但标 comparable=false 并说明原因；
 *   - manifest 字段缺失时派生为 null，不抛错、不猜。
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { QaTaskRunRegistry, readRunFacts } from "../src/services/qa-task-run-registry.js";
import type { KnowledgeDb } from "../src/services/qa-project-knowledge.js";

let db: DatabaseSync;
let registry: QaTaskRunRegistry;
let clock = 1_700_000_000_000;
let seq = 0;

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
      started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL,
      created_by TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, run_id)
    );
    CREATE TABLE qa_case_results (
      project_id TEXT NOT NULL, run_id TEXT NOT NULL, case_key TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE qa_pool_leases (
      pool TEXT NOT NULL, slot INTEGER NOT NULL, project_id TEXT NOT NULL,
      holder_run_id TEXT NOT NULL, lease_until TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (pool, slot)
    );
  `);
  registry = new QaTaskRunRegistry(db as unknown as KnowledgeDb, () => clock, () => `uuid-${++seq}`);
});

afterEach(() => db.close());

const facts = (over: Partial<ReturnType<typeof readRunFacts>> = {}) => ({
  runId: "run-1",
  manifestVersion: 3,
  status: "in_progress",
  resourcePool: "web" as string | null,
  sutVersion: null as string | null,
  baselineHash: null as string | null,
  ...over,
});

describe("readRunFacts", () => {
  it("把执行平台映射成资源池，接口执行优先归 api 池", () => {
    expect(readRunFacts({ run_id: "run-a", manifest_version: 3, status: "created", orchestration: { plan: { execution_platform: "web" } } }).resourcePool).toBe("web");
    expect(readRunFacts({ run_id: "run-a", manifest_version: 3, orchestration: { plan: { execution_platform: "web", execution_branches: ["api_execution"] } } }).resourcePool).toBe("api");
    expect(readRunFacts({ run_id: "run-a", manifest_version: 3, orchestration: { plan: { execution_platform: "android" } } }).resourcePool).toBe("android");
  });

  it("字段缺失时降级为 null / unknown，不抛错也不猜成 web", () => {
    const parsed = readRunFacts({});
    expect(parsed.manifestVersion).toBe(null);
    expect(parsed.status).toBe("unknown");
    expect(parsed.resourcePool).toBe(null);
    expect(parsed.sutVersion).toBe(null);
  });

  it("manifest_version 不是整数时视为未知", () => {
    expect(readRunFacts({ manifest_version: "3" }).manifestVersion).toBe(null);
  });
});

describe("ensureTask", () => {
  it("重复调用不覆盖用户填的 env，也不产生第二行", () => {
    const first = registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    const second = registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "prod" });
    expect(second.taskId).toBe(first.taskId);
    expect(second.env).toBe("staging");
    const count = db.prepare("SELECT COUNT(*) AS n FROM qa_tasks").get() as { n: number };
    expect(Number(count.n)).toBe(1);
  });

  it("同一 session 在不同项目下不会串行（唯一索引按 session 而不是项目）", () => {
    registry.ensureTask({ projectId: "p1", sessionId: "s1", userId: "u1" });
    // 唯一索引只约束 session_id：跨项目复用同一 session 时读到的是原来那条，
    // 因此 task() 必须按 (project, session) 过滤，不能只按 session。
    expect(registry.task("p2", "s1")).toBe(null);
    expect(registry.task("p1", "s1")?.projectId).toBe("p1");
  });
});

describe("updateTask", () => {
  it("空串 env 是一次有效赋值（未指定），不是'没传'", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    const updated = registry.updateTask("p", "s1", { env: "" }, "u1");
    expect(updated.env).toBe("");
  });

  it("sut_version 可以显式置 null，不退化成空串", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1" });
    registry.updateTask("p", "s1", { sutVersion: "v1.2.3" }, "u1");
    const cleared = registry.updateTask("p", "s1", { sutVersion: null }, "u1");
    expect(cleared.sutVersion).toBe(null);
  });
});

describe("observeRun", () => {
  it("新运行从 1 号开始，继承任务环境，并留下 manifest 指纹", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    const run = registry.observeRun({
      projectId: "p", sessionId: "s1", userId: "u1",
      facts: facts(), manifestPath: "output/runs/run-1/manifest.json", manifestSha256: "sha256:abc",
    });
    expect(run.runIndex).toBe(1);
    expect(run.env).toBe("staging");
    expect(run.manifestSha256).toBe("sha256:abc");
    expect(run.resourcePool).toBe("web");
  });

  it("同一 run 重复登记只刷新状态，不换号也不新增行", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts(), manifestPath: "m1", manifestSha256: "sha256:1" });
    clock += 1000;
    const again = registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ status: "completed" }), manifestPath: "m1", manifestSha256: "sha256:2" });
    expect(again.runIndex).toBe(1);
    expect(again.status).toBe("completed");
    expect(again.manifestSha256).toBe("sha256:2");
    const count = db.prepare("SELECT COUNT(*) AS n FROM qa_runs").get() as { n: number };
    expect(Number(count.n)).toBe(1);
  });

  it("run 可显式跑在非默认环境，不被 task.env 覆盖掉", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    const run = registry.observeRun({
      projectId: "p", sessionId: "s1", userId: "u1", facts: facts(),
      manifestPath: "m", manifestSha256: "s", env: "prod",
    });
    expect(run.env).toBe("prod");
  });

  it("回填行（0 号）不参与新运行编号，新运行仍从 1 起", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1" });
    db.prepare(`INSERT INTO qa_runs(run_id,task_id,project_id,session_id,kind,status,run_index,created_at,created_by,updated_at)
                SELECT 'run-legacy', task_id, project_id, session_id, 'legacy', 'legacy', 0, '2026-01-01', 'backfill', '2026-01-01'
                FROM qa_tasks WHERE session_id='s1'`).run();
    const run = registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts(), manifestPath: "m", manifestSha256: "s" });
    expect(run.runIndex).toBe(1);
  });
});

describe("compareRuns", () => {
  it("分出回归、修复、仍失败、新增、消失五类", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-1", status: "completed", sutVersion: "v1" }), manifestPath: "m1", manifestSha256: "s1" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-2", status: "completed", sutVersion: "v1" }), manifestPath: "m2", manifestSha256: "s2" });
    const insert = db.prepare("INSERT INTO qa_case_results(project_id,run_id,case_key,status) VALUES ('p',?,?,?)");
    insert.run("run-1", "C-1", "passed");
    insert.run("run-2", "C-1", "failed"); // 回归
    insert.run("run-1", "C-2", "failed");
    insert.run("run-2", "C-2", "passed"); // 修复
    insert.run("run-1", "C-3", "failed");
    insert.run("run-2", "C-3", "failed"); // 仍失败
    insert.run("run-2", "C-4", "passed"); // 新增
    insert.run("run-1", "C-5", "passed"); // 消失（这次没跑）
    const diff = registry.compareRuns("p", "s1", "run-1", "run-2");
    expect(diff.regressions).toEqual(["C-1"]);
    expect(diff.fixed).toEqual(["C-2"]);
    expect(diff.stillFailing).toEqual(["C-3"]);
    expect(diff.added).toEqual(["C-4"]);
    expect(diff.removed).toEqual(["C-5"]);
    expect(diff.comparable).toBe(true);
    expect(diff.versionStatus).toBe("same");
  });

  it("两个 run 都没记录版本时标 unknown，不能因为都空就当作同版本", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-1" }), manifestPath: "m1", manifestSha256: "s1" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-2" }), manifestPath: "m2", manifestSha256: "s2" });
    const diff = registry.compareRuns("p", "s1", "run-1", "run-2");
    expect(diff.versionStatus).toBe("unknown");
    expect(diff.comparable).toBe(false);
    expect(diff.reasons.join(" ")).toContain("被测版本未记录");
  });

  it("环境或版本不同时仍给差异，但标不可比并说明原因", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-1", sutVersion: "v1" }), manifestPath: "m1", manifestSha256: "s1" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-2", sutVersion: "v2" }), manifestPath: "m2", manifestSha256: "s2", env: "prod" });
    const diff = registry.compareRuns("p", "s1", "run-1", "run-2");
    expect(diff.comparable).toBe(false);
    expect(diff.reasons.join(" ")).toContain("环境不同");
    expect(diff.reasons.join(" ")).toContain("被测版本不同");
  });

  it("基线一致说明环境没动，可放心比较", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    const hash = "a".repeat(64);
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-1", sutVersion: "v1", baselineHash: hash }), manifestPath: "m1", manifestSha256: "s1" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-2", sutVersion: "v1", baselineHash: hash }), manifestPath: "m2", manifestSha256: "s2" });
    const diff = registry.compareRuns("p", "s1", "run-1", "run-2");
    expect(diff.baselineStatus).toBe("same");
    expect(diff.comparable).toBe(true);
  });

  it("基线不同即环境变了：仍给差异，但标不可比", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-1", sutVersion: "v1", baselineHash: "a".repeat(64) }), manifestPath: "m1", manifestSha256: "s1" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-2", sutVersion: "v1", baselineHash: "b".repeat(64) }), manifestPath: "m2", manifestSha256: "s2" });
    const diff = registry.compareRuns("p", "s1", "run-1", "run-2");
    expect(diff.baselineStatus).toBe("different");
    expect(diff.comparable).toBe(false);
    expect(diff.reasons.join(" ")).toContain("环境基线不同");
  });

  it("只有一侧采集基线时标 unknown，不冒充一致", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1", env: "staging" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-1", sutVersion: "v1" }), manifestPath: "m1", manifestSha256: "s1" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-2", sutVersion: "v1", baselineHash: "b".repeat(64) }), manifestPath: "m2", manifestSha256: "s2" });
    const diff = registry.compareRuns("p", "s1", "run-1", "run-2");
    expect(diff.baselineStatus).toBe("unknown");
    expect(diff.reasons.join(" ")).toContain("仅一侧采集了环境基线");
  });

  it("拒绝比较不属于该任务的运行", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1" });
    registry.ensureTask({ projectId: "p", sessionId: "s2", userId: "u1" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts({ runId: "run-1" }), manifestPath: "m", manifestSha256: "s" });
    registry.observeRun({ projectId: "p", sessionId: "s2", userId: "u1", facts: facts({ runId: "run-2" }), manifestPath: "m", manifestSha256: "s" });
    expect(() => registry.compareRuns("p", "s1", "run-1", "run-2")).toThrow();
  });
});

describe("资源池租约", () => {
  it("web 池只有 1 个槽：第二个 run 拿不到，而不是被允许去抢设备", () => {
    const first = registry.acquirePoolSlot({ projectId: "p", pool: "web", runId: "run-1" });
    expect(first).toEqual({ slot: 0, leaseUntil: expect.any(String) });
    expect(registry.acquirePoolSlot({ projectId: "p", pool: "web", runId: "run-2" })).toBe(null);
    expect(registry.poolStatus("web").free).toBe(0);
  });

  it("同一个 run 重复申请拿回自己的槽位，不会被自己锁在门外", () => {
    const first = registry.acquirePoolSlot({ projectId: "p", pool: "web", runId: "run-1" });
    const again = registry.acquirePoolSlot({ projectId: "p", pool: "web", runId: "run-1" });
    expect(again?.slot).toBe(first?.slot);
  });

  it("租约过期后槽位可被抢占（进程崩了不会永久占设备）", () => {
    registry.acquirePoolSlot({ projectId: "p", pool: "web", runId: "run-1", ttlMs: 1000 });
    clock += 2000;
    const taken = registry.acquirePoolSlot({ projectId: "p", pool: "web", runId: "run-2" });
    expect(taken?.slot).toBe(0);
    expect(registry.poolStatus("web").holders[0]?.runId).toBe("run-2");
  });

  it("android 池有两个槽；释放只能由持有者发起", () => {
    expect(registry.acquirePoolSlot({ projectId: "p", pool: "android", runId: "run-1" })?.slot).toBe(0);
    expect(registry.acquirePoolSlot({ projectId: "p", pool: "android", runId: "run-2" })?.slot).toBe(1);
    expect(registry.acquirePoolSlot({ projectId: "p", pool: "android", runId: "run-3" })).toBe(null);
    // 别人来释放无效
    expect(registry.releasePoolSlot({ projectId: "p", pool: "android", slot: 0, runId: "run-9" })).toBe(false);
    expect(registry.releasePoolSlot({ projectId: "p", pool: "android", slot: 0, runId: "run-1" })).toBe(true);
    expect(registry.poolStatus("android").free).toBe(1);
  });

  it("按 run 释放只还自己的槽位；租约已被接管时一行都不删", () => {
    registry.acquirePoolSlot({ projectId: "p", pool: "web", runId: "run-1", ttlMs: 1000 });
    clock += 2000;
    expect(registry.acquirePoolSlot({ projectId: "p", pool: "web", runId: "run-2" })?.slot).toBe(0);
    // run-1 崩溃后迟到归还：槽位已经换人，不能把 run-2 踢下去
    expect(registry.releasePoolSlotOfRun({ projectId: "p", pool: "web", runId: "run-1" })).toBe(0);
    expect(registry.poolStatus("web").holders[0]?.runId).toBe("run-2");
    // run_id 只在项目内唯一：换一个项目用同一个 run_id 也不能删别人的租约
    expect(registry.releasePoolSlotOfRun({ projectId: "other", pool: "web", runId: "run-2" })).toBe(0);
    expect(registry.releasePoolSlotOfRun({ projectId: "p", pool: "web", runId: "run-2" })).toBe(1);
    expect(registry.poolStatus("web").free).toBe(1);
  });
});

describe("settleRun / attachBatch", () => {
  it("统计与批次能回填到对应 run，不存在的 run 返回 null", () => {
    registry.ensureTask({ projectId: "p", sessionId: "s1", userId: "u1" });
    registry.observeRun({ projectId: "p", sessionId: "s1", userId: "u1", facts: facts(), manifestPath: "m", manifestSha256: "s" });
    registry.attachBatch("p", "run-1", "batch-9");
    const settled = registry.settleRun("p", "run-1", { passed: 3, failed: 1 });
    expect(settled?.batchId).toBe("batch-9");
    expect(settled?.counts).toEqual({ passed: 3, failed: 1 });
    expect(settled?.finishedAt).not.toBe(null);
    expect(registry.settleRun("p", "run-nope", { passed: 0 })).toBe(null);
  });
});
