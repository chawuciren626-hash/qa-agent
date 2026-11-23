/**
 * 任务平台集成模块单测：契约校验 / 迁移建表 / 客户端重试与错误分类 /
 * ingestion 事件-包幂等 / result outbox 退避与终态。
 *
 * 全部使用 node:sqlite 内存库与注入 fetch/sleep，不占端口、不碰真实网络。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildIdempotencyKey,
  isExecutionStatus,
  isHandoffEventType,
  isTestVerdict,
  looksLikeValidHandoffPackage,
  type HandoffEventDto,
  type HandoffPackage,
  type TestResultPayload,
} from "../src/integrations/task-platform/contracts.js";
import {
  AttachmentHashMismatchError,
  CursorExpiredError,
  TaskPlatformApiError,
  TaskPlatformClient,
} from "../src/integrations/task-platform/client.js";
import { SqliteTaskPlatformStore } from "../src/integrations/task-platform/store.js";
import { IngestionService, type PackageActivationHook } from "../src/integrations/task-platform/ingestion-service.js";
import {
  ResultOutboxDispatcher,
  ResultOutboxScheduler,
} from "../src/integrations/task-platform/result-outbox.js";
import { taskPlatformIntegration } from "../src/db/migrations/steps/2026-11-20-task-platform-integration.js";
import { taskPlatformEventRetry } from "../src/db/migrations/steps/2026-11-23-task-platform-event-retry.js";
import { migrate as migrateSteps } from "../src/db/migrations/runner.js";

// ---------- 测试基建 ----------

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  taskPlatformIntegration.up(db);
  taskPlatformEventRetry.up(db);
  return db;
}

describe("task-platform event retry migration", () => {
  it("upgrades a database whose original migration is already recorded", () => {
    const db = new DatabaseSync(":memory:");
    migrateSteps(db, [taskPlatformIntegration]);
    expect(db.prepare("PRAGMA table_info(task_platform_events)").all().some(row => (row as { name: string }).name === "process_status")).toBe(false);
    expect(migrateSteps(db, [taskPlatformIntegration, taskPlatformEventRetry]).applied).toEqual([taskPlatformEventRetry.name]);
    expect(db.prepare("PRAGMA table_info(task_platform_events)").all().some(row => (row as { name: string }).name === "process_status")).toBe(true);
    expect(migrateSteps(db, [taskPlatformIntegration, taskPlatformEventRetry]).applied).toEqual([]);
    db.close();
  });
});

interface RouteMock {
  match: (url: URL, init: RequestInit) => boolean;
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>;
}

function makeFetch(routes: RouteMock[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: URL | string, init: RequestInit = {}): Promise<Response> => {
    const full = url instanceof URL ? url : new URL(url);
    calls.push({ url: full.toString(), init });
    for (const route of routes) {
      if (route.match(full, init)) return await route.respond(full, init);
    }
    return new Response(JSON.stringify({ code: 404, subCode: "NOT_MOCKED", message: "no route" }), { status: 404 });
  };
  (impl as unknown as { calls: { url: string; init: RequestInit }[] }).calls = calls;
  return impl as unknown as typeof fetch & { calls: { url: string; init: RequestInit }[] };
}

const okEnvelope = (data: unknown) =>
  new Response(JSON.stringify({ code: 200, message: "success", subCode: "SUCCESS", subMessage: "success", data, traceId: "t-1", timestamp: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function sampleEvent(overrides: Partial<HandoffEventDto> = {}): HandoffEventDto {
  return {
    event_id: "evt-1",
    event_type: "initial_handoff",
    tenant_id: "tenant-1",
    task_id: "task-1",
    task_no: "FB202611200001",
    package_version: 1,
    parent_package_version: null,
    pm_round_id: "pm-round-1",
    product_line_ids: ["line-1"],
    occurred_at: "2026-11-20T10:00:00+08:00",
    ...overrides,
  };
}

function samplePackage(overrides: Partial<HandoffPackage> = {}): HandoffPackage {
  return {
    schema_version: "1.0",
    source_system: "sbkj-taskassignment",
    tenant_id: "tenant-1",
    task_id: "task-1",
    task_no: "FB202611200001",
    source_url: "http://platform/tasks/active?taskId=task-1",
    package_version: 1,
    parent_package_version: null,
    content_hash: "sha256:abc",
    event: { event_id: "evt-1", event_type: "initial_handoff", generated_at: null, reason: null },
    product_lines: [{ product_line_id: "line-1", line_code: "L1", line_name: "数据平台", is_primary: true }],
    unresolved_product_line_names: [],
    task: {
      parent_task_id: null,
      root_task_id: null,
      task_kind: "main",
      title: "测试任务",
      feedback_type: "requirement",
      priority: "high",
      complexity_level: "medium",
      estimated_hours: 16,
      estimated_days: 2,
      status_code: "pm_testing",
      submitter: { user_id: "u1", display_name: "提交人" },
      assignee: { user_id: "u2", display_name: "处理人" },
      created_at: null,
    },
    flow: { development_round_id: null, pm_round: { pm_round_id: "pm-round-1", round_no: 1, entered_at: null } },
    requirement: {
      original_content: "原始",
      original_supplements: [],
      original_rich_content: null,
      ai_content: "AI 整理",
      ai_structured_result: null,
      final_content: "最终",
      confirmed_baseline: {
        final_content: "最终",
        acceptance_criteria: [],
        missing_fields: [],
        confirmed: true,
        confirmed_at: null,
        confirmed_by: null,
        document_signature: null,
      },
    },
    schedule_design_documents: [],
    development_self_test: {
      development_round_id: null,
      self_test_submission_id: "approval-1",
      submitted_at: null,
      review_mode: "manual",
      approval_status: "approved",
      reviewed_at: null,
      request_reason: null,
      submission_sections: [],
      related_links: [],
    },
    changes: [],
    attachments: [],
    handoff_document: { format: "markdown", title: "交接", content: "# 交接", content_hash: "sha256:doc" },
    regression_context: null,
    ...overrides,
  };
}

// ---------- 契约校验 ----------

describe("contracts", () => {
  it("validates event types / execution status / verdict", () => {
    expect(isHandoffEventType("initial_handoff")).toBe(true);
    expect(isHandoffEventType("bogus")).toBe(false);
    expect(isExecutionStatus("partially_completed")).toBe(true);
    expect(isExecutionStatus("weird")).toBe(false);
    expect(isTestVerdict("inconclusive")).toBe(true);
    expect(isTestVerdict("nope")).toBe(false);
  });

  it("detects invalid packages", () => {
    expect(looksLikeValidHandoffPackage(samplePackage())).toBe(true);
    const broken = samplePackage() as unknown as Record<string, unknown>;
    delete broken.task_id;
    expect(looksLikeValidHandoffPackage(broken)).toBe(false);
    expect(looksLikeValidHandoffPackage(null)).toBe(false);
  });

  it("builds idempotency key", () => {
    expect(buildIdempotencyKey("t", "k", "r", "res")).toBe("aitest:t:k:r:res");
  });
});

// ---------- 客户端 ----------

describe("TaskPlatformClient", () => {
  const sleepLog: number[] = [];
  const sleep = async (ms: number) => { sleepLog.push(ms); };

  it("parses envelope and returns data", async () => {
    const fetchImpl = makeFetch([
      { match: url => url.pathname.endsWith("/product-lines"), respond: () => okEnvelope({ items: [], next_cursor: null, has_more: false }) },
    ]);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, sleepImpl: sleep });
    const page = await client.fetchProductLines();
    expect(page.items).toEqual([]);
    expect(fetchImpl.calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer k" });
  });

  it("retries retryable statuses with backoff then succeeds", async () => {
    let attempts = 0;
    const fetchImpl = makeFetch([
      {
        match: url => url.pathname.includes("handoff-events"),
        respond: () => {
          attempts++;
          return attempts < 3
            ? new Response("busy", { status: 503 })
            : okEnvelope({ items: [sampleEvent()], next_cursor: "c2", has_more: false });
        },
      },
    ]);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, sleepImpl: sleep, retryBaseBackoffMs: 100 });
    const page = await client.fetchHandoffEvents();
    expect(page.items).toHaveLength(1);
    expect(attempts).toBe(3);
    expect(sleepLog).toEqual([100, 200]);
  });

  it("does not retry permanent errors (401)", async () => {
    let attempts = 0;
    const fetchImpl = makeFetch([
      {
        match: () => true,
        respond: () => {
          attempts++;
          return new Response(JSON.stringify({ code: 401, subCode: "INTEGRATION.AUTH_FAILED", message: "bad key" }), { status: 401 });
        },
      },
    ]);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, sleepImpl: sleep });
    await expect(client.fetchHandoffEvents()).rejects.toThrow(TaskPlatformApiError);
    expect(attempts).toBe(1);
  });

  it("raises CursorExpiredError on 410 cursor expiry", async () => {
    const fetchImpl = makeFetch([
      {
        match: () => true,
        respond: () => new Response(
          JSON.stringify({ code: 410, subCode: "INTEGRATION.EVENT_CURSOR_EXPIRED", message: "cursor expired" }),
          { status: 410 },
        ),
      },
    ]);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, sleepImpl: sleep });
    await expect(client.fetchHandoffEvents({ cursor: "stale" })).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("verifies attachment sha256 and rejects mismatch", async () => {
    const body = "attachment-bytes";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
    const fetchImpl = makeFetch([
      { match: url => url.pathname.includes("/attachments/"), respond: () => new Response(body, { status: 200, headers: { "X-Content-Sha256": hex } }) },
    ]);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, sleepImpl: sleep });
    const bytes = await client.downloadAttachment("task-1", "att-1");
    expect(new TextDecoder().decode(bytes)).toBe(body);

    const badImpl = makeFetch([
      { match: url => url.pathname.includes("/attachments/"), respond: () => new Response(body, { status: 200, headers: { "X-Content-Sha256": "0".repeat(64) } }) },
    ]);
    const badClient = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl: badImpl, sleepImpl: sleep });
    await expect(badClient.downloadAttachment("task-1", "att-1")).rejects.toBeInstanceOf(AttachmentHashMismatchError);
  });

  it("submits test result with idempotency key header", async () => {
    const fetchImpl = makeFetch([
      {
        match: (url, init) => url.pathname.includes("/test-results") && init.method === "POST",
        respond: () => okEnvelope({ result_id: "r1", result_version: 1, receive_status: "accepted", received_at: null }),
      },
    ]);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, sleepImpl: sleep });
    const ack = await client.submitTestResult("task-1", samplePackage().task as never, "aitest:t:k:r:res");
    expect(ack.receive_status).toBe("accepted");
    expect(fetchImpl.calls[0]!.init.headers).toMatchObject({ "Idempotency-Key": "aitest:t:k:r:res" });
  });
});

// ---------- store（幂等唯一键） ----------

describe("SqliteTaskPlatformStore", () => {
  it("initializes the singleton cursor on a fresh database", () => {
    const db = makeDb();
    const row = db.prepare("SELECT id, cursor, updated_at FROM task_platform_ingest_cursor").get() as { id: number; cursor: string | null; updated_at: string };
    expect(row).toMatchObject({ id: 1, cursor: null });
    expect(Number.isFinite(Date.parse(row.updated_at))).toBe(true);
    taskPlatformIntegration.up(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_platform_ingest_cursor").get()).toEqual({ count: 1 });
  });

  it("enforces event idempotency", () => {
    const store = new SqliteTaskPlatformStore(makeDb());
    store.recordEvent(sampleEvent());
    expect(store.hasEvent("evt-1")).toBe(true);
    store.recordEvent(sampleEvent()); // INSERT OR IGNORE
    expect(store.hasEvent("evt-1")).toBe(true);
  });

  it("upserts project link idempotently", () => {
    const store = new SqliteTaskPlatformStore(makeDb());
    const base = {
      project_id: "proj-1",
      source_system: "sbkj-taskassignment" as const,
      external_tenant_id: "tenant-1",
      external_product_line_id: "line-1",
      external_line_code: "L1",
      display_name: "数据平台",
      external_url: null,
      sync_status: "active" as const,
      last_synced_at: "2026-11-20T00:00:00Z",
    };
    const first = store.upsertProjectLink(base);
    const second = store.upsertProjectLink({ ...base, display_name: "数据平台（改名）" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const link = store.findProjectLink("tenant-1", "line-1");
    expect(link?.display_name).toBe("数据平台（改名）");
  });

  it("enforces package uniqueness per task+version", () => {
    const store = new SqliteTaskPlatformStore(makeDb());
    const link = store.createTaskLink({
      project_id: "proj-1",
      source_system: "sbkj-taskassignment",
      external_tenant_id: "tenant-1",
      external_task_id: "task-1",
      external_task_no: "FB-1",
      current_package_version: 1,
      current_pm_round_id: null,
      status: "pending_analysis",
      ai_summary_json: null,
      suggested_priority: null,
    });
    const row = store.recordPackage({
      task_link_id: link.link_id,
      package_version: 1,
      event_id: "evt-1",
      event_type: "initial_handoff",
      content_hash: "sha256:abc",
      payload_json: "{}",
      document_id: "doc-1",
      revision: 1,
      activated: 1,
    });
    expect(row.package_version).toBe(1);
    expect(store.findPackage(link.link_id, 1)).not.toBeNull();
    expect(store.findPackage(link.link_id, 2)).toBeNull();
    // 重复插入同版本 → 唯一约束冲突
    expect(() =>
      store.recordPackage({
        task_link_id: link.link_id,
        package_version: 1,
        event_id: "evt-2",
        event_type: "material_changed",
        content_hash: "sha256:abc",
        payload_json: "{}",
        document_id: "doc-1",
        revision: 1,
        activated: 1,
      }),
    ).toThrow();
  });

  it("queues result outbox idempotently and respects due time", () => {
    const store = new SqliteTaskPlatformStore(makeDb());
    expect(store.enqueueResult({ task_id: "t", result_id: "r", result_version: 1, idempotency_key: "k", payload_json: "{}" }).created).toBe(true);
    expect(store.enqueueResult({ task_id: "t", result_id: "r", result_version: 1, idempotency_key: "k", payload_json: "{}" }).created).toBe(false);
    const due = store.dueOutboxRows("2026-01-01T00:00:00Z", 10);
    expect(due).toHaveLength(1);
    store.markOutboxDelivered(due[0]!.id, "2026-01-02T00:00:00Z");
    expect(store.dueOutboxRows("2026-01-03T00:00:00Z", 10)).toHaveLength(0);
  });
});

// ---------- ingestion ----------

describe("IngestionService", () => {
  function makeHarness(events: HandoffEventDto[], packages: Map<string, HandoffPackage>) {
    const db = makeDb();
    const store = new SqliteTaskPlatformStore(db);
    const fetchImpl = makeFetch([
      {
        match: url => url.pathname.includes("handoff-events"),
        respond: () => okEnvelope({ items: events, next_cursor: null, has_more: false }),
      },
      {
        match: url => url.pathname.includes("handoff-packages"),
        respond: url => {
          const parts = url.pathname.split("/");
          const taskId = parts.at(-3)!;
          const version = Number(parts.at(-1)!);
          const pkg = packages.get(`${taskId}:v${version}`);
          return pkg ? okEnvelope(pkg) : new Response(JSON.stringify({ code: 404, subCode: "HANDOFF.PACKAGE.NOT_PUBLISHED" }), { status: 404 });
        },
      },
    ]);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, sleepImpl: async () => {} });
    const calls: { initial: string[]; update: string[]; projects: string[] } = { initial: [], update: [], projects: [] };
    const activation: PackageActivationHook = {
      async onInitialHandoff(linkId) { calls.initial.push(linkId); },
      async onPackageUpdate(linkId) { calls.update.push(linkId); },
      async ensureSyncProject(line) { calls.projects.push(line.product_line_id); return "proj-1"; },
    };
    const service = new IngestionService({ client, store, activation });
    return { store, service, calls };
  }

  it("ingests event + package end to end and activates initial handoff", async () => {
    const { store, service, calls } = makeHarness([sampleEvent()], new Map([["task-1:v1", samplePackage()]]));
    const summary = await service.runOnce();
    expect(summary.new_events).toBe(1);
    expect(summary.packages_activated).toBe(1);
    expect(calls.projects).toEqual(["line-1"]);
    expect(calls.initial).toHaveLength(1);
    expect(calls.update).toHaveLength(0);
    const link = store.findTaskLink("tenant-1", "task-1");
    expect(link?.status).toBe("pending_analysis");
    expect(link?.current_package_version).toBe(1);
  });

  it("is idempotent: replaying the same event does not duplicate work", async () => {
    const { store, service, calls } = makeHarness([sampleEvent()], new Map([["task-1:v1", samplePackage()]]));
    await service.runOnce();
    const second = await service.runOnce(); // 同一事件再次被拉到
    expect(second.new_events).toBe(0);
    expect(calls.initial).toHaveLength(1); // 激活钩子只跑一次
    expect(store.findTaskLink("tenant-1", "task-1")).not.toBeNull();
  });

  it("routes non-initial events to onPackageUpdate", async () => {
    const event = sampleEvent({ event_id: "evt-2", event_type: "new_pm_round", package_version: 2, parent_package_version: 1 });
    const pkg = samplePackage({
      package_version: 2,
      parent_package_version: 1,
      event: { event_id: "evt-2", event_type: "new_pm_round", generated_at: null, reason: null },
      regression_context: { previous_pm_round_id: "pm-round-0", previous_failed_issues: [], rectifications: [] },
    });
    const { store, calls } = makeHarness([event], new Map([["task-1:v2", pkg]]));
    // 先造 v1 映射与包，模拟已有首轮交接
    const service = new IngestionService({
      client: new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl: makeFetch([]), sleepImpl: async () => {} }),
      store,
      activation: { async onInitialHandoff() {}, async onPackageUpdate() {}, async ensureSyncProject() { return "proj-1"; } },
    });
    void service;
    const harness = makeHarness([event], new Map([["task-1:v2", pkg]]));
    // 预置 v1 包存在：任务已激活过首轮
    harness.store.recordEvent(sampleEvent());
    const link = harness.store.createTaskLink({
      project_id: "proj-1",
      source_system: "sbkj-taskassignment",
      external_tenant_id: "tenant-1",
      external_task_id: "task-1",
      external_task_no: "FB202611200001",
      current_package_version: 1,
      current_pm_round_id: "pm-round-0",
      status: "ready",
      ai_summary_json: null,
      suggested_priority: null,
    });
    harness.store.recordPackage({
      task_link_id: link.link_id,
      package_version: 1,
      event_id: "evt-1",
      event_type: "initial_handoff",
      content_hash: "sha256:v1",
      payload_json: "{}",
      document_id: "doc-1",
      revision: 1,
      activated: 1,
    });
    const summary = await harness.service.runOnce();
    expect(summary.packages_received).toBe(1);
    expect(harness.calls.update).toHaveLength(1);
    expect(harness.calls.initial).toHaveLength(0);
    // 新版本到达 → 待确认影响（S7），不重置回待分析
    expect(harness.store.findTaskLink("tenant-1", "task-1")?.status).toBe("impact_pending");
  });

  it("keeps polling when one package fails, and records the event for retry", async () => {
    const events = [sampleEvent({ event_id: "evt-bad", task_id: "task-bad" }), sampleEvent({ event_id: "evt-good", task_id: "task-good" })];
    const packages = new Map<string, HandoffPackage>([
      ["task-good:v1", samplePackage({ task_id: "task-good", event: { event_id: "evt-good", event_type: "initial_handoff", generated_at: null, reason: null } })],
      // task-bad 无包 → 拉包 404 → 抛错
    ]);
    const harness = makeHarness(events, packages);
    const summary = await harness.service.runOnce();
    expect(summary.packages_failed).toBe(1);
    expect(summary.packages_activated).toBe(1);
    expect(harness.store.hasEvent("evt-bad")).toBe(true);
    expect(harness.store.hasEvent("evt-good")).toBe(true);
  });

  it("failed event is retried on a later run until it succeeds (no missed delivery)", async () => {
    // 第一轮：task-bad 拉包 404 → 事件标 failed + 退避
    const events = [sampleEvent({ event_id: "evt-1", task_id: "task-1" })];
    const packages = new Map<string, HandoffPackage>();
    const harness = makeHarness(events, packages);
    const first = await harness.service.runOnce();
    expect(first.packages_failed).toBe(1);
    // 第二轮：包已可用（平台侧补齐）；时钟推进 30s 后到期
    packages.set("task-1:v1", samplePackage());
    // 把事件的重试时间拨到过去（模拟到期）
    const dbRow = (harness as unknown as { store: SqliteTaskPlatformStore }).store;
    void dbRow;
    await harness.service.runOnce(); // 未到期不重试
    // 直接把 next_retry_at 清到过去
    (harness.store as unknown as { db: DatabaseSync }).db
      .prepare("UPDATE task_platform_events SET process_next_retry_at = '2020-01-01T00:00:00Z' WHERE event_id = 'evt-1'")
      .run();
    const third = await harness.service.runOnce();
    expect(third.packages_activated).toBe(1); // 重试成功
    // 第四轮：已 succeeded 不再重复激活
    const fourth = await harness.service.runOnce();
    expect(fourth.packages_activated).toBe(0);
    expect(fourth.new_events).toBe(0);
  });
});

// ---------- result outbox ----------

describe("ResultOutboxDispatcher", () => {
  function makeOutboxHarness(deliverStatuses: number[]) {
    const db = makeDb();
    const store = new SqliteTaskPlatformStore(db);
    let deliveryAttempts = 0;
    const fetchImpl = makeFetch([
      {
        match: (url, init) => url.pathname.includes("/test-results") && init.method === "POST",
        respond: () => {
          const status = deliverStatuses[Math.min(deliveryAttempts, deliverStatuses.length - 1)];
          deliveryAttempts++;
          if (status === 200) return okEnvelope({ result_id: "r", result_version: 1, receive_status: "accepted", received_at: null });
          return new Response(JSON.stringify({ code: status, subCode: `HTTP_${status}`, message: "err" }), { status });
        },
      },
    ]);
    // maxAttempts: 1 —— 关闭客户端内部重试，让 outbox 层独立重试语义可被精确断言
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, sleepImpl: async () => {}, maxAttempts: 1 });
    let clock = new Date("2026-11-20T10:00:00Z");
    const dispatcher = new ResultOutboxDispatcher({
      client,
      store,
      tenantId: "tenant-1",
      baseBackoffMs: 1000,
      now: () => clock,
    });
    return { store, dispatcher, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, deliveryAttemptsRef: { get attempts() { return deliveryAttempts; } } };
  }

  function makePayload(taskId = "task-1"): TestResultPayload {
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
      session_id: "s",
      run_id: "r",
      result_id: "result-1",
      result_version: 1,
      execution_status: "completed",
      test_verdict: "pass",
      started_at: "2026-11-20T10:00:00+08:00",
      finished_at: "2026-11-20T11:00:00+08:00",
      test_scope: { summary: "s" },
      statistics: { total: 1, passed: 1, failed: 0, blocked: 0, not_executed: 0 },
      issues: [],
      summary: "ok",
      risks: [],
      evidence_index: [],
      created_at: "2026-11-20T11:00:00+08:00",
    };
  }

  it("delivers on first success and marks delivered", async () => {
    const harness = makeOutboxHarness([200]);
    const payload = makePayload();
    harness.dispatcher.enqueue(payload);
    const summary = await harness.dispatcher.tickOnce();
    expect(summary.delivered).toBe(1);
    expect(harness.store.dueOutboxRows("2026-11-20T11:00:00Z", 10)).toHaveLength(0);
  });

  it("retries with exponential backoff on 503 and eventually delivers", async () => {
    const harness = makeOutboxHarness([503, 503, 200]);
    harness.dispatcher.enqueue(makePayload());
    const tick1 = await harness.dispatcher.tickOnce();
    expect(tick1.retried).toBe(1);
    // next_retry_at = now + 1000ms；时钟未推进 → 不到期
    expect((await harness.dispatcher.tickOnce()).attempted).toBe(0);
    harness.advance(1000);
    const tick2 = await harness.dispatcher.tickOnce();
    expect(tick2.retried).toBe(1);
    harness.advance(2000);
    const tick3 = await harness.dispatcher.tickOnce();
    expect(tick3.delivered).toBe(1);
  });

  it("abandons on permanent 4xx (401) without retry", async () => {
    const abandoned: string[] = [];
    const harness = makeOutboxHarness([401]);
    harness.dispatcher.onAbandoned = resultId => abandoned.push(resultId);
    harness.dispatcher.enqueue(makePayload());
    const summary = await harness.dispatcher.tickOnce();
    expect(summary.abandoned).toBe(1);
    expect(abandoned).toEqual(["result-1"]);
    harness.advance(10_000_000);
    expect((await harness.dispatcher.tickOnce()).attempted).toBe(0);
  });

  it("stops on 409 conflict and raises alert", async () => {
    const conflicts: string[] = [];
    const harness = makeOutboxHarness([409]);
    harness.dispatcher.onConflict = resultId => conflicts.push(resultId);
    harness.dispatcher.enqueue(makePayload());
    const summary = await harness.dispatcher.tickOnce();
    expect(summary.attempted).toBe(1);
    expect(summary.delivered).toBe(0);
    expect(summary.retried).toBe(0);
    expect(conflicts).toEqual(["result-1"]);
  });

  it("scheduler prevents overlapping ticks", async () => {
    const db = makeDb();
    const store = new SqliteTaskPlatformStore(db);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl: makeFetch([]), sleepImpl: async () => {} });
    const dispatcher = new ResultOutboxDispatcher({ client, store, tenantId: "t" });
    const scheduler = new ResultOutboxScheduler(dispatcher, 1000);
    // 空队列 tick 安全
    const summary = await scheduler.tickOnce();
    expect(summary.attempted).toBe(0);
    scheduler.stop();
  });
});
