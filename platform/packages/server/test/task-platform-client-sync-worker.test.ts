/**
 * 客户端 sync worker 单测（同步层阶段 B）：
 * 镜像 upsert（新建/更新/字段覆盖）、增量游标推进、acct_user_id 用户隔离、
 * 离线降级（不删缓存）、重放幂等、配置持久化。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { taskPlatformIntegration } from "../src/db/migrations/steps/2026-11-20-task-platform-integration.js";
import { taskPlatformEventRetry } from "../src/db/migrations/steps/2026-11-23-task-platform-event-retry.js";
import { taskPlatformPackageBackfill } from "../src/db/migrations/steps/2026-11-23-task-platform-package-backfill.js";
import {
  ClientTaskSyncWorker,
  loadClientSyncConfig,
  saveClientSyncConfig,
} from "../src/integrations/task-platform/client-sync-worker.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  taskPlatformIntegration.up(db);
  taskPlatformEventRetry.up(db);
  taskPlatformPackageBackfill.up(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_task_links (
      link_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_system TEXT NOT NULL,
      external_tenant_id TEXT NOT NULL DEFAULT '', external_task_id TEXT NOT NULL,
      external_task_no TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium', product_lines_json TEXT NOT NULL DEFAULT '[]',
      feedback_type TEXT NOT NULL DEFAULT '', estimated_hours INTEGER,
      package_version INTEGER NOT NULL DEFAULT 1, pm_round_no INTEGER,
      source_url TEXT NOT NULL DEFAULT '', main_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending_analysis', ai_summary_json TEXT,
      suggested_priority TEXT, local_title_note TEXT NOT NULL DEFAULT '',
      local_test_focus_note TEXT NOT NULL DEFAULT '', local_edited_at TEXT,
      last_event_id TEXT, last_synced_at TEXT,
      server_link_id TEXT, acct_user_id TEXT,
      requirement_baseline_json TEXT, self_test_digest_json TEXT, changes_digest_json TEXT,
      submitter_name TEXT, assignee_name TEXT, complexity_level TEXT, estimated_days INTEGER,
      last_action_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(source_system, external_tenant_id, external_task_id)
    );
  `);
  return db;
}

interface RouteMock {
  match: (url: URL) => boolean;
  respond: () => Response | Promise<Response>;
}

function makeWorker(db: DatabaseSync, routes: RouteMock[], userId = "zhangsan") {
  const fetchImpl = (async (url: URL | string): Promise<Response> => {
    const full = url instanceof URL ? url : new URL(url);
    for (const route of routes) {
      if (route.match(full)) return await route.respond();
    }
    return new Response("not mocked", { status: 404 });
  }) as unknown as typeof fetch;
  const worker = new ClientTaskSyncWorker({
    serverBaseUrl: "http://server",
    serviceKey: "svc-key",
    userId,
    db,
    fetchImpl,
    intervalMs: 3_600_000, // 测试不触发定时
  });
  return { worker, db };
}

function syncItem(serverLinkId: string, taskId: string, updatedAt: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    server_link_id: serverLinkId,
    project_id: "proj-1",
    task_id: taskId,
    task_no: `FB-${taskId.slice(-4).toUpperCase()}`,
    title: `任务 ${taskId}`,
    priority: "high",
    package_version: 1,
    pm_round_no: 1,
    product_lines: [{ name: "数据平台", isPrimary: true }],
    suggested_priority: "high",
    ai_summary: { summary: "摘要" },
    status: "ready",
    source_url: `http://platform/tasks/active?taskId=${taskId}`,
    requirement_baseline: { final_content: "需求基准内容" },
    self_test_digest: { test_address: "https://env" },
    changes_digest: [],
    submitter: "张瑛",
    assignee: "王智",
    updated_at: updatedAt,
    ...overrides,
  };
}

function okPage(items: unknown[], hasMore = false, nextCursor: string | null = null): Response {
  return new Response(JSON.stringify({ items, next_cursor: nextCursor, has_more: hasMore }), { status: 200 });
}

describe("ClientTaskSyncWorker", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("pulls server tasks and upserts into local mirror with acct_user_id", async () => {
    const db = makeDb();
    const { worker } = makeWorker(db, [
      {
        match: url => url.pathname.includes("/api/sync/v1/platform-tasks"),
        respond: () => okPage([syncItem("srv-1", "task-1", "2026-11-23T00:00:00Z")]),
      },
    ]);
    const summary = await worker.tickOnce();
    expect(summary.pulled).toBe(1);
    expect(summary.upserted).toBe(1);
    const row = db
      .prepare("SELECT link_id, acct_user_id, server_link_id, title, requirement_baseline_json FROM platform_task_links")
      .get() as { link_id: string; acct_user_id: string; server_link_id: string; title: string; requirement_baseline_json: string };
    expect(row.acct_user_id).toBe("zhangsan");
    expect(row.server_link_id).toBe("srv-1");
    expect(row.title).toBe("任务 task-1");
    const baseline = JSON.parse(row.requirement_baseline_json) as { final_content: string };
    expect(baseline.final_content).toBe("需求基准内容");
  });

  it("uses local max updated_at as incremental cursor", async () => {
    const db = makeDb();
    const urls: string[] = [];
    const { worker } = makeWorker(db, [
      {
        match: url => {
          urls.push(url.toString());
          return url.pathname.includes("/api/sync/v1/platform-tasks");
        },
        respond: () => okPage([]),
      },
    ]);
    db.prepare(
      `INSERT INTO platform_task_links (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no, title, acct_user_id, updated_at, created_at)
       VALUES ('ptl-1', 'proj-1', 'sbkj-taskassignment', 't', 'task-1', 'FB-1', '已有', 'zhangsan', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')`,
    ).run();
    await worker.tickOnce();
    expect(urls[0]).toContain("since=2026-11-20T00%3A00%3A00Z");
  });

  it("updates existing mirror row instead of duplicating (replay idempotent)", async () => {
    const db = makeDb();
    const item = syncItem("srv-1", "task-1", "2026-11-23T00:00:00Z");
    const { worker } = makeWorker(db, [
      { match: url => url.pathname.includes("/api/sync/v1/platform-tasks"), respond: () => okPage([item]) },
    ]);
    await worker.tickOnce();
    await worker.tickOnce(); // 同内容重放
    const rows = db.prepare("SELECT COUNT(*) AS n FROM platform_task_links").get() as { n: number };
    expect(rows.n).toBe(1);
    const row = db.prepare("SELECT title FROM platform_task_links").get() as { title: string };
    expect(row.title).toBe("任务 task-1");
  });

  it("updates existing row when server pushes newer fields (version bump)", async () => {
    const db = makeDb();
    const old = syncItem("srv-1", "task-1", "2026-11-23T00:00:00Z", { status: "ready" });
    const newer = syncItem("srv-1", "task-1", "2026-11-24T00:00:00Z", { status: "impact_pending", package_version: 2 });
    const harness1 = makeWorker(db, [{ match: () => true, respond: () => okPage([old]) }]);
    await harness1.worker.tickOnce();
    const harness2 = makeWorker(db, [{ match: () => true, respond: () => okPage([newer]) }]);
    await harness2.worker.tickOnce();
    const row = harness2.db.prepare("SELECT status, package_version FROM platform_task_links").get() as { status: string; package_version: number };
    expect(row.status).toBe("impact_pending");
    expect(row.package_version).toBe(2);
  });

  it("user isolation: rows of another acct_user_id are invisible to this user's cursor", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO platform_task_links (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no, title, acct_user_id, updated_at, created_at)
       VALUES ('ptl-other', 'proj-2', 'sbkj-taskassignment', 't', 'task-other', 'FB-OTHER', '他人任务', 'lisi', '2026-11-25T00:00:00Z', '2026-11-25T00:00:00Z')`,
    ).run();
    let requestedUrl = "";
    const { worker } = makeWorker(db, [
      {
        match: url => {
          requestedUrl = url.toString();
          return url.pathname.includes("/api/sync/v1/platform-tasks");
        },
        respond: () => okPage([]),
      },
    ]);
    await worker.tickOnce();
    // zhangsan 的游标不受 lisi 行影响（从 null 开始全量）
    expect(requestedUrl).not.toContain("since=");
  });

  it("offline: keeps local cache and records error (no deletion)", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO platform_task_links (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no, title, acct_user_id, updated_at, created_at)
       VALUES ('ptl-1', 'proj-1', 'sbkj-taskassignment', 't', 'task-1', 'FB-1', '已有缓存', 'zhangsan', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')`,
    ).run();
    const { worker } = makeWorker(db, [
      { match: () => true, respond: () => { throw new Error("network down"); } },
    ]);
    const summary = await worker.tickOnce();
    expect(summary.failed).toBe(true);
    expect(summary.error).toContain("network down");
    const row = db.prepare("SELECT title FROM platform_task_links").get() as { title: string };
    expect(row.title).toBe("已有缓存"); // 缓存保留
  });
});

describe("client sync config persistence", () => {
  it("saves and loads config; missing dir returns null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atp-sync-"));
    saveClientSyncConfig(dir, { serverBaseUrl: "http://server", serviceKey: "k" });
    expect(loadClientSyncConfig(dir)).toEqual({ serverBaseUrl: "http://server", serviceKey: "k" });
    expect(loadClientSyncConfig(path.join(dir, "empty"))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("invalid json content returns null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atp-sync-bad-"));
    saveClientSyncConfig(dir, { serverBaseUrl: "http://server", serviceKey: "k" });
    // 手写坏内容
    const file = path.join(dir, "task-platform-sync", "client-sync.json");
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(file, "not-json", "utf8");
    expect(loadClientSyncConfig(dir)).toBeNull();
    // 缺字段
    fs.writeFileSync(file, JSON.stringify({ serverBaseUrl: "http://server" }), "utf8");
    expect(loadClientSyncConfig(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
