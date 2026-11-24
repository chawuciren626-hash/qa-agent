/**
 * 同步层阶段 B3 + C 单测：
 * - B3 开始测试登记闸：worker.registerState（成功/409 冲突/离线错误）；
 * - C1 结果接收面：receiveTestResult 幂等（duplicate/载荷哈希冲突/非法载荷）+ 展示行推进；
 * - C2 outbox 装配：IngestionScheduler.enqueueTestResult 入队 → dispatcher 投递
 *   （mock 任务平台）全链，applySettings 热重启通道。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { taskPlatformIntegration } from "../src/db/migrations/steps/2026-11-20-task-platform-integration.js";
import { taskPlatformEventRetry } from "../src/db/migrations/steps/2026-11-23-task-platform-event-retry.js";
import { taskPlatformPackageBackfill } from "../src/db/migrations/steps/2026-11-23-task-platform-package-backfill.js";
import { ClientTaskSyncWorker } from "../src/integrations/task-platform/client-sync-worker.js";
import { PlatformTaskSyncService } from "../src/integrations/task-platform/client-sync-service.js";
import { IngestionScheduler, type TaskPlatformConfigStore } from "../src/integrations/task-platform/runtime.js";
import { SqliteTaskPlatformStore } from "../src/integrations/task-platform/store.js";
import { ResultOutboxDispatcher } from "../src/integrations/task-platform/result-outbox.js";
import { TaskPlatformClient } from "../src/integrations/task-platform/client.js";
import type { TestResultPayload, TestResultAck } from "../src/integrations/task-platform/contracts.js";

class MemConfigStore implements TaskPlatformConfigStore {
  private map = new Map<string, string>();
  get(key: string): string | null { return this.map.get(key) ?? null; }
  set(key: string, value: string): void { this.map.set(key, value); }
  delete(key: string): void { this.map.delete(key); }
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  taskPlatformIntegration.up(db);
  taskPlatformEventRetry.up(db);
  taskPlatformPackageBackfill.up(db);
  // 客户端镜像/展示表（C1 展示行推进断言需要）
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_task_links (
      link_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_system TEXT NOT NULL,
      external_tenant_id TEXT NOT NULL DEFAULT '',
      external_task_id TEXT NOT NULL,
      external_task_no TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending_analysis',
      package_version INTEGER NOT NULL DEFAULT 1,
      pm_round_no INTEGER,
      last_action_json TEXT NOT NULL DEFAULT '{}',
      server_link_id TEXT,
      acct_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedMirrorTask(db: DatabaseSync, linkId: string, externalTaskId: string, status = "in_progress"): void {
  db.prepare(
    `INSERT INTO platform_task_links
       (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no,
        title, status, package_version, pm_round_no, server_link_id, acct_user_id, created_at, updated_at)
     VALUES (?, 'proj-1', 'sbkj-taskassignment', 'tenant-1', ?, 'FB-1', '任务', ?, 1, 1, ?, 'zhangsan',
             '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z')`,
  ).run(linkId, externalTaskId, status, linkId);
}

function makeResultPayload(taskId = "task-1", overrides: Partial<TestResultPayload> = {}): TestResultPayload {
  return {
    schema_version: "1.0",
    source_system: "sbkj-taskassignment",
    tenant_id: "tenant-1",
    task_id: taskId,
    pm_round_id: "pm-1",
    package_version: 1,
    package_hash: "sha256:x",
    project_id: "p",
    test_task_id: "tt",
    session_id: "s-1",
    run_id: "r-1",
    result_id: "result-1",
    result_version: 1,
    execution_status: "completed",
    test_verdict: "pass",
    started_at: "2026-11-24T10:00:00+08:00",
    finished_at: "2026-11-24T11:00:00+08:00",
    test_scope: { summary: "s" },
    statistics: { total: 2, passed: 2, failed: 0, blocked: 0, not_executed: 0 },
    issues: [],
    summary: "全部通过",
    risks: [],
    evidence_index: [],
    created_at: "2026-11-24T11:00:00+08:00",
    ...overrides,
  };
}

// ------------------------------------------------------------- B3 登记闸

describe("B3 worker.registerState", () => {
  function makeWorker(routes: Array<{ match: (url: URL) => boolean; respond: (url: URL, init?: RequestInit) => Response }>) {
    const db = makeDb();
    const fetchImpl = (async (url: URL | string, init?: RequestInit): Promise<Response> => {
      const full = url instanceof URL ? url : new URL(url);
      for (const route of routes) {
        if (route.match(full)) return route.respond(full, init);
      }
      return new Response("not mocked", { status: 404 });
    }) as unknown as typeof fetch;
    const worker = new ClientTaskSyncWorker({
      serverBaseUrl: "http://server",
      serviceKey: "svc-key",
      userId: "zhangsan",
      db,
      fetchImpl,
      intervalMs: 3_600_000,
    });
    return { worker, db };
  }

  it("registers in_progress via A3 and returns applied result", async () => {
    let capturedBody = "";
    const { worker } = makeWorker([
      {
        match: url => url.pathname.endsWith("/api/sync/v1/platform-tasks/srv-1/state"),
        respond: (_url, init) => {
          capturedBody = String(init?.body ?? "");
          return new Response(JSON.stringify({ applied: true, status: "in_progress", revision: 42, reason: null }), { status: 200 });
        },
      },
    ]);
    const result = await worker.registerState("srv-1", "in_progress");
    expect(result.applied).toBe(true);
    expect(result.revision).toBe(42);
    const body = JSON.parse(capturedBody) as { status: string; user: string };
    expect(body.status).toBe("in_progress");
    expect(body.user).toBe("zhangsan");
  });

  it("surfaces 409 conflict as an error with server reason", async () => {
    const { worker } = makeWorker([
      {
        match: url => url.pathname.includes("/state"),
        respond: () => new Response(JSON.stringify({ error: { message: "状态已被其他端更新（乐观锁冲突）" } }), { status: 409 }),
      },
    ]);
    await expect(worker.registerState("srv-1", "in_progress")).rejects.toThrow("乐观锁冲突");
  });

  it("surfaces offline as an error (开始测试拦截语义)", async () => {
    const { worker } = makeWorker([
      { match: () => true, respond: () => { throw new Error("network down"); } },
    ]);
    await expect(worker.registerState("srv-1", "in_progress")).rejects.toThrow();
  });

  it("surfaces 5xx as an error with status code", async () => {
    const { worker } = makeWorker([
      { match: () => true, respond: () => new Response("boom", { status: 503 }) },
    ]);
    await expect(worker.registerState("srv-1", "in_progress")).rejects.toThrow("503");
  });
});

// ------------------------------------------------------------- C1 结果接收面

describe("C1 receiveTestResult", () => {
  it("accepts a valid result, enqueues it and flips the mirror row to result_returned", () => {
    const db = makeDb();
    seedMirrorTask(db, "srv-1", "task-1", "in_progress");
    const svc = new PlatformTaskSyncService(db, () => null);
    const enqueued: TestResultPayload[] = [];
    const received = svc.receiveTestResult(makeResultPayload("task-1"), {
      enqueue: payload => { enqueued.push(payload); return { created: true }; },
    });
    expect(received.accepted).toBe(true);
    expect(received.duplicate).toBe(false);
    expect(enqueued).toHaveLength(1);
    const row = db.prepare("SELECT status, last_action_json FROM platform_task_links WHERE link_id = ?").get("srv-1") as { status: string; last_action_json: string };
    expect(row.status).toBe("result_returned");
    const action = JSON.parse(row.last_action_json) as { action: string; result_id: string };
    expect(action.action).toBe("test_result_received");
    expect(action.result_id).toBe("result-1");
  });

  it("returns duplicate for the same result_id+version with identical content", () => {
    const db = makeDb();
    const svc = new PlatformTaskSyncService(db, () => null);
    const payload = makeResultPayload();
    // 预置 outbox 行（同 result_id+version 同内容）——模拟上一轮已收过
    db.prepare(
      `INSERT INTO task_platform_result_outbox (id, task_id, result_id, result_version, idempotency_key, payload_json, attempts, next_retry_at)
       VALUES ('ob-1', 'task-1', 'result-1', 1, 'aitest:x', ?, 0, '1970-01-01T00:00:00.000Z')`,
    ).run(JSON.stringify(payload));
    const received = svc.receiveTestResult(makeResultPayload(), { enqueue: () => ({ created: true }) });
    expect(received.accepted).toBe(true);
    expect(received.duplicate).toBe(true);
  });

  it("rejects with idempotency conflict when same key carries different content", () => {
    const db = makeDb();
    seedMirrorTask(db, "srv-1", "task-1");
    const svc = new PlatformTaskSyncService(db, () => null);
    const payload = makeResultPayload();
    db.prepare(
      `INSERT INTO task_platform_result_outbox (id, task_id, result_id, result_version, idempotency_key, payload_json, attempts, next_retry_at)
       VALUES ('ob-1', 'task-1', 'result-1', 1, 'aitest:x', ?, 0, '1970-01-01T00:00:00.000Z')`,
    ).run(JSON.stringify({ ...payload, summary: "旧内容" }));
    const received = svc.receiveTestResult({ ...payload, summary: "新内容" }, { enqueue: () => ({ created: true }) });
    expect(received.accepted).toBe(false);
    expect(received.reason).toContain("幂等冲突");
  });

  it("rejects payloads missing key identity fields", () => {
    const db = makeDb();
    const svc = new PlatformTaskSyncService(db, () => null);
    const bad = { result_id: "r" } as unknown as TestResultPayload;
    const received = svc.receiveTestResult(bad, { enqueue: () => ({ created: true }) });
    expect(received.accepted).toBe(false);
    expect(received.reason).toContain("关键标识");
  });

  it("leaves unknown tasks alone (no mirror row flip for foreign task ids)", () => {
    const db = makeDb();
    seedMirrorTask(db, "srv-1", "task-1");
    const svc = new PlatformTaskSyncService(db, () => null);
    const received = svc.receiveTestResult(makeResultPayload("task-foreign"), { enqueue: () => ({ created: true }) });
    expect(received.accepted).toBe(true);
    const row = db.prepare("SELECT status FROM platform_task_links WHERE link_id = ?").get("srv-1") as { status: string };
    expect(row.status).toBe("in_progress"); // 未被外任务波及
  });
});

// ------------------------------------------------------------- C2 outbox 装配

describe("C2 IngestionScheduler outbox assembly", () => {
  it("accepts results via enqueueTestResult while integration disabled (rows are kept, no loss)", () => {
    const db = makeDb();
    const store = new SqliteTaskPlatformStore(db);
    const scheduler = new IngestionScheduler({ configStore: new MemConfigStore(), store, bridge: {} as never });
    const ack = scheduler.enqueueTestResult(makeResultPayload());
    expect(ack.created).toBe(true);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM task_platform_result_outbox WHERE delivered_at IS NULL").get() as { n: number };
    expect(rows.n).toBe(1);
    // 幂等：同 result_id+version 再入队 → created=false
    const again = scheduler.enqueueTestResult(makeResultPayload());
    expect(again.created).toBe(false);
  });

  it("delivers enqueued results to the task platform (full chain: enqueue → dispatcher → platform)", async () => {
    const deliveries: Array<{ path: string; body: TestResultPayload; idem: string | undefined }> = [];
    const db = makeDb();
    const store = new SqliteTaskPlatformStore(db);
    const configStore = new MemConfigStore();
    const scheduler = new IngestionScheduler({ configStore, store, bridge: {} as never });
    const received = scheduler.enqueueTestResult(makeResultPayload());
    expect(received.created).true;
    // 全链打通：独立 dispatcher（mock 平台 ack）消费同一 outbox 行——生产中该角色由
    // IngestionScheduler 内装配的 outbox 心跳承担（投递语义已在 integration 套件覆盖）。
    const fetchImpl = (async (url: URL | string, init?: RequestInit): Promise<Response> => {
      const full = url instanceof URL ? url : new URL(url);
      deliveries.push({
        path: full.pathname,
        body: JSON.parse(String(init?.body ?? "{}")) as TestResultPayload,
        idem: (init?.headers as Record<string, string>)?.["Idempotency-Key"],
      });
      const ack: TestResultAck = { result_id: "result-1", result_version: 1, receive_status: "accepted", received_at: null };
      return new Response(JSON.stringify({ code: 200, subCode: "SUCCESS", message: "ok", data: ack }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, sleepImpl: async () => {}, maxAttempts: 1 });
    const dispatcher = new ResultOutboxDispatcher({ client, store, tenantId: "tenant-1" });
    const summary = await dispatcher.tickOnce();
    expect(summary.delivered).toBe(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.path).toBe("/api/v1/integration-handoff/tasks/task-1/test-results");
    expect(deliveries[0]!.body.result_id).toBe("result-1");
    expect(deliveries[0]!.idem).toContain("aitest:tenant-1:task-1:pm-1:result-1");
    const pending = db.prepare("SELECT COUNT(*) AS n FROM task_platform_result_outbox WHERE delivered_at IS NULL").get() as { n: number };
    expect(pending.n).toBe(0);
    void scheduler;
  });

  it("applySettings restarts the outbox channel (stop old, start new)", () => {
    const db = makeDb();
    const store = new SqliteTaskPlatformStore(db);
    const configStore = new MemConfigStore();
    const scheduler = new IngestionScheduler({ configStore, store, bridge: {} as never });
    // 启用配置：outbox 心跳随 applySettings 启动
    const applied = scheduler.applySettings({
      enabled: true, baseUrl: "http://platform", apiKey: "k", pollIntervalMs: 60_000, batchSize: 50, recipientUserId: "",
    });
    expect(applied.enabled).toBe(true);
    // 结果可入队且不抛（通道已装配）
    const ack = scheduler.enqueueTestResult(makeResultPayload());
    expect(ack.created).toBe(true);
    // 停用：通道回收，再入队仍不丢（lazy 重建）
    scheduler.applySettings({ enabled: false, baseUrl: "", apiKey: "", pollIntervalMs: 60_000, batchSize: 50, recipientUserId: "" });
    const ack2 = scheduler.enqueueTestResult({ ...makeResultPayload(), result_id: "result-2" });
    expect(ack2.created).toBe(true);
  });
});
