/**
 * 客户端 sync worker 单测（同步层阶段 B）：
 * 镜像 upsert（新建/更新/字段覆盖）、增量游标推进、acct_user_id 用户隔离、
 * 离线降级（不删缓存）、重放幂等、配置持久化。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
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
  // 真实约束形态（Codex 审阅要求）：生产库 PRAGMA foreign_keys=ON（database.ts:30），
  // platform_task_links.project_id 引用 projects——测试库必须同构，否则测不出首同步
  // 因本机缺项目行而失败的问题（此前简化表无外键，漏测）。
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      password_is_initial INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_management (
      project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
      description TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('manual','sync')),
      source_system_name TEXT,
      external_project_id TEXT,
      external_url TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','disabled')),
      purpose TEXT CHECK(purpose IN ('business','internal')),
      last_synced_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS platform_task_links (
      link_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      source_system TEXT NOT NULL,
      external_tenant_id TEXT NOT NULL DEFAULT '',
      external_task_id TEXT NOT NULL,
      external_task_no TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
      product_lines_json TEXT NOT NULL DEFAULT '[]',
      feedback_type TEXT NOT NULL DEFAULT '',
      estimated_hours INTEGER,
      package_version INTEGER NOT NULL DEFAULT 1,
      pm_round_no INTEGER,
      source_url TEXT NOT NULL DEFAULT '',
      main_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending_analysis'
        CHECK(status IN ('pending_analysis','ready','in_progress','impact_pending','result_returned','terminated')),
      ai_summary_json TEXT,
      suggested_priority TEXT,
      local_title_note TEXT NOT NULL DEFAULT '',
      local_test_focus_note TEXT NOT NULL DEFAULT '',
      local_edited_at TEXT,
      last_event_id TEXT,
      last_synced_at TEXT,
      server_link_id TEXT,
      acct_user_id TEXT,
      requirement_baseline_json TEXT,
      self_test_digest_json TEXT,
      changes_digest_json TEXT,
      submitter_name TEXT,
      assignee_name TEXT,
      complexity_level TEXT,
      estimated_days INTEGER,
      last_action_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_system, external_tenant_id, external_task_id)
    );
  `);
  // 镜像项目 owner 引用 users：登录用户本体行先落（真实链路里 AccountClient.localUser 已建）。
  db.prepare("INSERT INTO users (user_id, password_hash, created_at) VALUES ('zhangsan', 'x', '2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO users (user_id, password_hash, created_at) VALUES ('lisi', 'x', '2026-01-01T00:00:00Z')").run();
  return db;
}

/** 预置本机项目行（外键成立）：游标/隔离/离线测试的直接镜像行插入都需要它。 */
function seedProject(db: DatabaseSync, projectId: string, owner = "zhangsan"): void {
  db.prepare("INSERT OR IGNORE INTO projects (project_id, owner_user_id, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')").run(projectId, owner);
  db.prepare("INSERT OR IGNORE INTO project_management (project_id, source_type, source_system_name) VALUES (?, 'sync', 'sbkj-taskassignment')").run(projectId);
}

interface RouteMock {
  match: (url: URL) => boolean;
  respond: () => Response | Promise<Response>;
}

function makeWorker(db: DatabaseSync, routes: RouteMock[], userId = "zhangsan", opts: { dataRoot?: string } = {}) {
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
    dataRoot: opts.dataRoot,
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

  it("first sync provisions the mirror project row when local projects is empty (FK holds)", async () => {
    // Codex 审阅场景：本机 projects 无服务端同步项目行，外键约束下首同步必须成功。
    const db = makeDb();
    const serverProjectId = "sync_data_platform_ab12cd34ef56aa11"; // 服务端 syncProjectId 形态
    const { worker } = makeWorker(db, [
      {
        match: url => url.pathname.includes("/api/sync/v1/platform-tasks"),
        respond: () => okPage([syncItem("srv-1", "task-1", "2026-11-23T00:00:00Z", { project_id: serverProjectId })]),
      },
    ]);
    const before = db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
    expect(before.n).toBe(0); // 本机为空库
    const summary = await worker.tickOnce();
    expect(summary.failed).toBe(false);
    expect(summary.upserted).toBe(1);
    // 项目行已补建：owner=登录用户，project_management 标记 sync 来源
    const project = db.prepare("SELECT owner_user_id FROM projects WHERE project_id = ?").get(serverProjectId) as { owner_user_id: string };
    expect(project.owner_user_id).toBe("zhangsan");
    const managed = db.prepare("SELECT source_type, source_system_name FROM project_management WHERE project_id = ?").get(serverProjectId) as { source_type: string; source_system_name: string };
    expect(managed.source_type).toBe("sync");
    expect(managed.source_system_name).toBe("sbkj-taskassignment");
    // 任务镜像行落库且外键成立
    const task = db.prepare("SELECT project_id, acct_user_id FROM platform_task_links WHERE server_link_id = ?").get("srv-1") as { project_id: string; acct_user_id: string };
    expect(task.project_id).toBe(serverProjectId);
    expect(task.acct_user_id).toBe("zhangsan");
    // 外键完整性校验通过
    const integrity = db.prepare("PRAGMA foreign_key_check").all();
    expect(integrity).toHaveLength(0);
  });

  it("mirror project display name is written to project_config.toml (列表显示产品线名而非 sync_ 编码)", async () => {
    const db = makeDb();
    const dataRoot = mkdtempSync(path.join(tmpdir(), "atp-names-"));
    tempDirs.push(dataRoot);
    const serverProjectId = "sync_data_platform_ab12cd34ef56aa11";
    const { worker } = makeWorker(db, [
      {
        match: url => url.pathname.includes("/api/sync/v1/platform-tasks"),
        respond: () => okPage([syncItem("srv-1", "task-1", "2026-11-23T00:00:00Z", { project_id: serverProjectId })]),
      },
    ], "zhangsan", { dataRoot });
    await worker.tickOnce();
    // 显示名 = 主产品线名写入 .project_config.toml（getName 读取源）
    const configFile = path.join(dataRoot, serverProjectId, ".project_config.toml");
    expect(fs.existsSync(configFile)).toBe(true);
    const content = readFileSync(configFile, "utf8");
    expect(content).toContain('name = "数据平台"');
    // 存量项目补名：config 已存在时不覆盖（不篡改既有命名）
    fs.writeFileSync(configFile, 'name = "手工命名"\n', "utf8");
    const { worker: worker2 } = makeWorker(db, [
      { match: () => true, respond: () => okPage([]) },
    ], "zhangsan", { dataRoot });
    await worker2.tickOnce();
    expect(readFileSync(configFile, "utf8")).toContain('name = "手工命名"');
  });

  it("mirror project provisioning is idempotent and does not overwrite existing projects", async () => {
    const db = makeDb();
    // 预置：手工项目恰好与下发 project_id 同名（占用），owner 是别人——补建不得改动它
    db.prepare("INSERT INTO projects (project_id, owner_user_id, created_at) VALUES ('proj-1', 'lisi', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO project_management (project_id, source_type) VALUES ('proj-1', 'manual')").run();
    const { worker } = makeWorker(db, [
      {
        match: url => url.pathname.includes("/api/sync/v1/platform-tasks"),
        respond: () => okPage([syncItem("srv-1", "task-1", "2026-11-23T00:00:00Z")]),
      },
    ]);
    const summary = await worker.tickOnce();
    expect(summary.upserted).toBe(1);
    // 既有项目行不被覆盖（owner 仍是 lisi，来源仍是 manual）
    const project = db.prepare("SELECT owner_user_id FROM projects WHERE project_id = ?").get("proj-1") as { owner_user_id: string };
    expect(project.owner_user_id).toBe("lisi");
    const managed = db.prepare("SELECT source_type FROM project_management WHERE project_id = ?").get("proj-1") as { source_type: string };
    expect(managed.source_type).toBe("manual");
    // 重放一轮仍幂等（单行任务 + 单行项目）
    await worker.tickOnce();
    const counts = db.prepare("SELECT (SELECT COUNT(*) FROM projects) AS p, (SELECT COUNT(*) FROM platform_task_links) AS t").get() as { p: number; t: number };
    expect(counts.p).toBe(1);
    expect(counts.t).toBe(1);
  });

  it("uses local max updated_at as incremental cursor", async () => {
    const db = makeDb();
    seedProject(db, "proj-1");
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
    seedProject(db, "proj-2", "lisi");
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
    seedProject(db, "proj-1");
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
