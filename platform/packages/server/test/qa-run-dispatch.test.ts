/**
 * 派发队列（判据 1 执行侧）的单元测试。
 *
 * 断言的重点不是"能进能出"，而是几条一旦写错就会**静默**破坏贯通性的语义：
 *   - 同一条 run 不能被两个执行器同时领走（双领 = 副作用跑两遍，而库里只有一条记录）；
 *   - 租约过期可以被重领，但必须标 reclaimed（否则"上次跑到一半"被当成全新任务）；
 *   - 回填必须来自持租约的执行器，且 facts.run_id 必须等于被派发的 run_id
 *     （不一致时 observeRun 会插入一条新行，派发的那条永远卡在 running）；
 *   - 重复回填同一份结果幂等：counts 是覆盖不是累加。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QaTaskRunRegistry, type RunManifestFacts } from "../src/services/qa-task-run-registry.js";
import type { KnowledgeDb } from "../src/services/qa-project-knowledge.js";

let db: DatabaseSync;
let registry: QaTaskRunRegistry;
let clock = 1_700_000_000_000;
let seq = 0;

const LEASE = 60_000;

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
      dispatch_json TEXT NOT NULL DEFAULT '{}', claimed_by TEXT, claimed_at TEXT,
      lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL,
      created_by TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, run_id)
    );
    CREATE INDEX idx_qa_runs_claim ON qa_runs(project_id, status, lease_until);
    CREATE TABLE qa_case_results (
      project_id TEXT NOT NULL, run_id TEXT NOT NULL, case_key TEXT NOT NULL, status TEXT NOT NULL
    );
  `);
  registry = new QaTaskRunRegistry(db as unknown as KnowledgeDb, () => clock, () => `uuid-${++seq}`);
});

afterEach(() => db.close());

const enqueue = (runId: string, dispatch: Record<string, unknown> = { plan: `plans/${runId}.yaml` }) =>
  registry.enqueueRun({ projectId: "p1", sessionId: "s1", userId: "u1", runId, dispatch });

const facts = (runId: string, over: Partial<RunManifestFacts> = {}): RunManifestFacts => ({
  runId,
  status: "completed",
  manifestVersion: 1,
  resourcePool: "web",
  sutVersion: null,
  baselineHash: null,
  ...over,
});

describe("派发（enqueueRun）", () => {
  it("建 queued 行并带上派发载荷，run_index 从 1 递增", () => {
    const first = enqueue("run-1");
    const second = enqueue("run-2");
    expect(first.status).toBe("queued");
    expect(first.runIndex).toBe(1);
    expect(second.runIndex).toBe(2);
    expect(first.manifestPath).toBe("");
    expect(first.dispatch).toEqual({ plan: "plans/run-1.yaml" });
    expect(first.claimedBy).toBeNull();
    expect(first.attempts).toBe(0);
  });

  it("同一 run_id 重复派发直接拒绝，不静默覆盖", () => {
    enqueue("run-1");
    expect(() => enqueue("run-1")).toThrow(/already exists/);
  });

  it("未领取就回填被拒绝：结果必须挂在真实发生过的执行上", () => {
    enqueue("run-1");
    expect(() =>
      registry.reportRun({
        projectId: "p1",
        runId: "run-1",
        workerId: "u1::w1",
        facts: facts("run-1"),
        manifestPath: "output/runs/run-1/manifest.json",
        manifestSha256: "sha256:1",
      }),
    ).toThrow(/no active claim/);
  });
});

describe("领取（claimRun）", () => {
  it("领取最老的一条并记一次 attempt", () => {
    enqueue("run-1");
    enqueue("run-2");
    const claim = registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE });
    expect(claim?.run.runId).toBe("run-1");
    expect(claim?.run.status).toBe("running");
    expect(claim?.run.attempts).toBe(1);
    expect(claim?.reclaimed).toBe(false);
  });

  it("租约期内第二个执行器拿不到同一条", () => {
    enqueue("run-1");
    registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE });
    const other = registry.claimRun({ projectId: "p1", workerId: "u1::w2", leaseMs: LEASE });
    expect(other).toBeNull();
  });

  it("没有待办时返回 null 而不是抛错", () => {
    expect(registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE })).toBeNull();
  });

  it("租约过期后可重领，并标 reclaimed", () => {
    enqueue("run-1");
    registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE });
    clock += LEASE + 1;
    const again = registry.claimRun({ projectId: "p1", workerId: "u1::w2", leaseMs: LEASE });
    expect(again?.run.runId).toBe("run-1");
    expect(again?.reclaimed).toBe(true);
    expect(again?.run.attempts).toBe(2);
    expect(again?.run.claimedBy).toBe("u1::w2");
  });

  it("按 kind 过滤时不领到别的类型", () => {
    registry.enqueueRun({ projectId: "p1", sessionId: "s1", userId: "u1", runId: "run-design", kind: "design" });
    registry.enqueueRun({ projectId: "p1", sessionId: "s1", userId: "u1", runId: "run-exec", kind: "execution" });
    const claim = registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE, kind: "execution" });
    expect(claim?.run.runId).toBe("run-exec");
  });
});

describe("回填（reportRun）", () => {
  it("写回 manifest 事实与统计，并释放租约", () => {
    enqueue("run-1");
    registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE });
    const run = registry.reportRun({
      projectId: "p1",
      runId: "run-1",
      workerId: "u1::w1",
      facts: facts("run-1"),
      manifestPath: "output/runs/run-1/manifest.json",
      manifestSha256: "sha256:abc",
      counts: { passed: 3, failed: 1 },
    });
    expect(run.status).toBe("completed");
    expect(run.manifestPath).toBe("output/runs/run-1/manifest.json");
    expect(run.manifestSha256).toBe("sha256:abc");
    expect(run.counts).toEqual({ passed: 3, failed: 1 });
    expect(run.claimedBy).toBeNull();
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
  });

  it("非持租约者回填被拒绝", () => {
    enqueue("run-1");
    registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE });
    expect(() =>
      registry.reportRun({
        projectId: "p1",
        runId: "run-1",
        workerId: "u1::w2",
        facts: facts("run-1"),
        manifestPath: "m",
        manifestSha256: "s",
      }),
    ).toThrow(/claimed by/);
  });

  it("facts.run_id 与派发的 run_id 不一致被拒绝，不产生第二条 run", () => {
    enqueue("run-1");
    registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE });
    expect(() =>
      registry.reportRun({
        projectId: "p1",
        runId: "run-1",
        workerId: "u1::w1",
        facts: facts("run-other"),
        manifestPath: "m",
        manifestSha256: "s",
      }),
    ).toThrow(/this claim is for run-1/);
    expect(registry.run("p1", "run-other")).toBeNull();
  });

  it("重复回填同一份结果幂等：counts 不累加", () => {
    enqueue("run-1");
    registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE });
    const once = registry.reportRun({
      projectId: "p1",
      runId: "run-1",
      workerId: "u1::w1",
      facts: facts("run-1"),
      manifestPath: "m",
      manifestSha256: "s",
      counts: { passed: 2 },
    });
    // 租约已释放，再交一次必须被拒——这正是"同一次执行只有一份结论"的保障。
    expect(() =>
      registry.reportRun({
        projectId: "p1",
        runId: "run-1",
        workerId: "u1::w1",
        facts: facts("run-1"),
        manifestPath: "m",
        manifestSha256: "s",
        counts: { passed: 2 },
      }),
    ).toThrow(/no active claim/);
    expect(registry.run("p1", "run-1")?.counts).toEqual({ passed: 2 });
    expect(once.counts).toEqual({ passed: 2 });
  });
});

describe("交回（releaseRun）", () => {
  it("交回后回到队列，下一次可以被别人领", () => {
    enqueue("run-1");
    registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE });
    const released = registry.releaseRun({ projectId: "p1", runId: "run-1", workerId: "u1::w1", reason: "env_missing" });
    expect(released?.status).toBe("queued");
    expect(released?.claimedBy).toBeNull();
    expect(released?.dispatch.last_release_reason).toBe("env_missing");
    const claim = registry.claimRun({ projectId: "p1", workerId: "u1::w2", leaseMs: LEASE });
    expect(claim?.run.runId).toBe("run-1");
  });

  it("非持租约者交回无效，不把别人的任务放回队列", () => {
    enqueue("run-1");
    registry.claimRun({ projectId: "p1", workerId: "u1::w1", leaseMs: LEASE });
    expect(registry.releaseRun({ projectId: "p1", runId: "run-1", workerId: "u1::w2" })).toBeNull();
    expect(registry.run("p1", "run-1")?.status).toBe("running");
  });
});
