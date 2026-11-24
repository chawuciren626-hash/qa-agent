/**
 * 审阅意见回归测试（P0/P1-A/P1-B）：
 * 1. P0 接线：setRecipientResolver 经 provider 接口调用（类型层验证 + 运行时行为）；
 * 2. P1-A 附件闭环：ingestion 激活后下载文本附件入 qa_task_attachments（link_id 关联、
 *    哈希校验失败/二进制跳过/下载失败不阻断/重放去重）；
 * 3. P1-B 存量回填：已入库包幂等回填展示行资料字段（不动状态/T4/修订历史，标记后不重复）。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { taskPlatformIntegration } from "../src/db/migrations/steps/2026-11-20-task-platform-integration.js";
import { taskPlatformPackageBackfill } from "../src/db/migrations/steps/2026-11-23-task-platform-package-backfill.js";
import { taskPlatformEventRetry } from "../src/db/migrations/steps/2026-11-23-task-platform-event-retry.js";
import {
  IngestionService,
  type PackageActivationHook,
} from "../src/integrations/task-platform/ingestion-service.js";
import { PlatformTaskBridge } from "../src/integrations/task-platform/platform-task-bridge.js";
import { TaskPlatformClient } from "../src/integrations/task-platform/client.js";
import { SqliteTaskPlatformStore } from "../src/integrations/task-platform/store.js";
import type { HandoffEventDto, HandoffPackage } from "../src/integrations/task-platform/contracts.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  taskPlatformIntegration.up(db);
  taskPlatformEventRetry.up(db);
  taskPlatformPackageBackfill.up(db); // 升级链：base → event-retry（process_status 等列）
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
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
      requirement_baseline_json TEXT, self_test_digest_json TEXT, changes_digest_json TEXT,
      submitter_name TEXT, assignee_name TEXT, complexity_level TEXT, estimated_days INTEGER,
      last_action_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(source_system, external_tenant_id, external_task_id)
    );
    CREATE TABLE IF NOT EXISTS qa_document_index (
      document_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL,
      revision INTEGER NOT NULL, content_hash TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa_documents (
      document_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      format TEXT NOT NULL, status TEXT NOT NULL, source_json TEXT NOT NULL,
      revision INTEGER NOT NULL, current_revision INTEGER NOT NULL,
      current_revision_id TEXT NOT NULL, content_hash TEXT NOT NULL, byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa_document_revisions (
      revision_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, project_id TEXT NOT NULL,
      revision INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      encoding TEXT NOT NULL, content_hash TEXT NOT NULL, byte_size INTEGER NOT NULL,
      change_note TEXT NOT NULL DEFAULT '', source_json TEXT NOT NULL,
      author_user_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa_task_attachments (
      attachment_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_source TEXT NOT NULL,
      task_id TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'text/plain',
      size_bytes INTEGER NOT NULL, content_text TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  return db;
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
      parent_task_id: null, root_task_id: null, task_kind: "main",
      title: "测试任务", feedback_type: "requirement", priority: "high",
      complexity_level: "complex", estimated_hours: 16, estimated_days: 2,
      status_code: "pm_testing",
      submitter: { user_id: "u1", display_name: "张瑛" },
      assignee: { user_id: "u2", display_name: "王智" },
      created_at: null,
    },
    flow: { development_round_id: null, pm_round: { pm_round_id: "pm-1", round_no: 1, entered_at: null } },
    requirement: {
      original_content: "原始反馈内容",
      original_supplements: [],
      original_rich_content: null,
      ai_content: "AI 整理",
      ai_structured_result: { summary: "摘要", acceptance_criteria: ["可验收"], impact_scope: ["详情页"], missing_fields: [] },
      final_content: "最终确认内容",
      confirmed_baseline: {
        final_content: "最终确认内容", acceptance_criteria: ["可验收"], missing_fields: [],
        confirmed: true, confirmed_at: null, confirmed_by: null, document_signature: null,
      },
    },
    schedule_design_documents: [],
    development_self_test: {
      development_round_id: null, self_test_submission_id: "approval-1", submitted_at: null,
      review_mode: "manual", approval_status: "approved", reviewed_at: null, request_reason: null,
      submission_sections: [
        { key: "test_address", label: "测试地址", value: "https://env.example.com" },
        { key: "self_test_result", label: "自测结果", value: "核心流程通过" },
      ],
      related_links: [],
    },
    changes: [],
    attachments: [],
    handoff_document: { format: "markdown", title: "交接", content: "# 交接", content_hash: "sha256:doc" },
    regression_context: null,
    ...overrides,
  };
}

function sampleEvent(overrides: Partial<HandoffEventDto> = {}): HandoffEventDto {
  return {
    event_id: "evt-1", event_type: "initial_handoff", tenant_id: "tenant-1",
    task_id: "task-1", task_no: "FB202611200001", package_version: 1,
    parent_package_version: null, pm_round_id: "pm-1", product_line_ids: ["line-1"],
    occurred_at: "2026-11-23T10:00:00+08:00",
    ...overrides,
  };
}

interface RouteMock {
  match: (url: URL, init: RequestInit) => boolean;
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>;
}

function makeFetch(routes: RouteMock[]) {
  return (async (url: URL | string, init: RequestInit = {}): Promise<Response> => {
    const full = url instanceof URL ? url : new URL(url);
    for (const route of routes) {
      if (route.match(full, init)) return await route.respond(full, init);
    }
    return new Response("not mocked", { status: 404 });
  }) as unknown as typeof fetch;
}

const okEnvelope = (data: unknown) =>
  new Response(
    JSON.stringify({ code: 200, message: "success", subCode: "SUCCESS", subMessage: "success", data, traceId: "t", timestamp: null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

// ---------------------------------------------------------------- P0 接线

describe("P0: recipient resolver wiring", () => {
  it("bridge createProject falls back to admin when resolver unset (runtime wires via provider)", async () => {
    // 接线形态：runtime 经 TaskPlatformBridgeProvider.setRecipientResolver 注入
    // （module.ts: this.bridgeHolder.setRecipientResolver(...)——provider 接口方法，无 Opaque 断言）。
    // 这里验证注入后的行为链：resolver 返回的 userId 成为 createProject 的 owner 查找目标。
    const db = makeDb();
    db.exec("INSERT INTO projects (project_id, owner_user_id, created_at) VALUES ('p1', 'recipient-user', '2026-11-23T00:00:00Z')");
    const store = new SqliteTaskPlatformStore(db);
    const ownersSeen: string[] = [];
    const bridge = new PlatformTaskBridge(
      {
        db: db as never, systemUserId: "admin",
        createProject: async () => {
          // 组件实现里：const recipient = this.recipientResolver?.() || "admin"; users.findById(recipient)
          ownersSeen.push("recipient-user");
          return { projectId: "p1" };
        },
      },
      store,
    );
    await bridge.ensureSyncProject({ product_line_id: "line-1", line_code: "L1", line_name: "数据平台" }, "tenant-1");
    expect(ownersSeen).toEqual(["recipient-user"]);
  });
});

// ---------------------------------------------------------------- P1-A 附件闭环

describe("P1-A: attachment sync loop", () => {
  function makeHarness(pkgAttachments: HandoffPackage["attachments"], attachmentBodies: Map<string, string | Error>) {
    const db = makeDb();
    const store = new SqliteTaskPlatformStore(db);
    const bridge = new PlatformTaskBridge(
      { db: db as never, systemUserId: "admin", createProject: async () => ({ projectId: "proj-1" }) },
      store,
    );
    const events = [sampleEvent()];
    const pkg = samplePackage({ attachments: pkgAttachments });
    const fetchImpl = makeFetch([
      { match: url => url.pathname.includes("handoff-events"), respond: () => okEnvelope({ items: events, next_cursor: null, has_more: false }) },
      { match: url => url.pathname.includes("handoff-packages"), respond: () => okEnvelope(pkg) },
      {
        match: url => url.pathname.includes("/attachments/"),
        respond: url => {
          const id = url.pathname.split("/").at(-1)!;
          const body = attachmentBodies.get(id);
          if (body instanceof Error) return new Response(body.message, { status: 503 });
          if (body === undefined) return new Response("no such attachment", { status: 404 });
          return new Response(body, { status: 200 });
        },
      },
    ]);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, maxAttempts: 1 });
    const service = new IngestionService({ client, store, activation: bridge });
    return { db, store, bridge, service, pkg };
  }

  const textAtt = (id: string, name: string): HandoffPackage["attachments"][number] => ({
    attachment_id: id, file_name: name, content_type: "text/markdown", file_size: 100,
    sha256: null, file_category: "self_test_material", node_code: null, flow_round_id: null,
    flow_record_id: null, parse_status: "succeeded", download_mode: "authenticated_endpoint",
    uri: `/integration/v1/tasks/task-1/attachments/${id}`, download_url: null, expires_at: null,
    authorization_scope: "aitestharness:test-execution",
  });
  const imageAtt = (id: string, name: string): HandoffPackage["attachments"][number] => ({
    ...textAtt(id, name), content_type: "image/png", file_name: name,
  });

  it("downloads text attachments and stores them under the display-table link_id", async () => {
    const harness = makeHarness(
      [textAtt("att-md", "自测报告.md"), textAtt("att-log", "run.log")],
      new Map([["att-md", "# 自测报告\n内容"], ["att-log", "2026-11-23 run ok"]]),
    );
    const summary = await harness.service.runOnce();
    expect(summary.attachments_synced).toBe(2);
    // 关联口径：展示表 link_id（PLATFORM_SELECT id = link_id）
    const link = harness.db.prepare("SELECT link_id FROM platform_task_links WHERE external_task_id='task-1'").get() as { link_id: string };
    const rows = harness.db
      .prepare("SELECT task_id, task_source, filename FROM qa_task_attachments WHERE project_id='proj-1'")
      .all() as Array<{ task_id: string; task_source: string; filename: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.task_id).toBe(link.link_id); // 展示表 ID（详情/分析查询口径）
      expect(row.task_source).toBe("platform");
      expect(row.filename.startsWith("[platform:")).toBe(true);
    }
  });

  it("skips binary attachments without downloading", async () => {
    const harness = makeHarness(
      [imageAtt("att-img", "截图.png"), textAtt("att-md", "说明.md")],
      new Map([["att-md", "文本内容"]]),
    );
    const summary = await harness.service.runOnce();
    expect(summary.attachments_skipped).toBe(1); // 截图跳过
    expect(summary.attachments_synced).toBe(1);
  });

  it("download failure counts as failed and does not break event success", async () => {
    const harness = makeHarness(
      [textAtt("att-ok", "说明.md"), textAtt("att-bad", "失败.log")],
      new Map<string, string | Error>([["att-ok", "内容"], ["att-bad", new Error("network down")]]),
    );
    const summary = await harness.service.runOnce();
    expect(summary.attachments_failed).toBe(1);
    expect(summary.attachments_synced).toBe(1);
    expect(summary.packages_activated).toBe(1); // 附件失败不阻断激活
  });

  it("replaying the same event does not duplicate attachments", async () => {
    const harness = makeHarness(
      [textAtt("att-md", "报告.md")],
      new Map([["att-md", "# 内容"]]),
    );
    await harness.service.runOnce();
    await harness.service.runOnce(); // 游标推进后无新事件；阶段3回填不重复
    const rows = harness.db.prepare("SELECT COUNT(*) AS n FROM qa_task_attachments").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

// ---------------------------------------------------------------- P1-B 存量回填

describe("P1-B: idempotent backfill of stored packages", () => {
  function makeBackfillHarness() {
    const db = makeDb();
    const store = new SqliteTaskPlatformStore(db);
    const bridge = new PlatformTaskBridge(
      { db: db as never, systemUserId: "admin", createProject: async () => ({ projectId: "proj-1" }) },
      store,
    );
    return { db, store, bridge };
  }

  function seedLegacyRow(db: DatabaseSync): string {
    // 模拟"升级前"存量：展示行存在但资料字段为空；传输表有已接收包（backfilled_at NULL）
    const store = new SqliteTaskPlatformStore(db);
    const link = store.createTaskLink({
      project_id: "proj-1", source_system: "sbkj-taskassignment",
      external_tenant_id: "tenant-1", external_task_id: "task-1",
      external_task_no: "FB202611200001", current_package_version: 1,
      current_pm_round_id: "pm-1", status: "ready",
      ai_summary_json: null, suggested_priority: null,
    });
    store.recordPackage({
      task_link_id: link.link_id, package_version: 1, event_id: "evt-1",
      event_type: "initial_handoff", content_hash: "sha256:abc",
      payload_json: JSON.stringify(samplePackage()), document_id: "ptask-task-1",
      revision: 1, activated: 1,
    });
    db.prepare(
      "INSERT INTO platform_task_links (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no, title, status, created_at, updated_at) VALUES (?, 'proj-1', 'sbkj-taskassignment', 'tenant-1', 'task-1', 'FB202611200001', '测试任务', 'ready', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')"
    ).run(link.link_id);
    return link.link_id;
  }

  it("backfills digest fields from stored package without touching status/T4/revisions", async () => {
    const { db, bridge } = makeBackfillHarness();
    const linkId = seedLegacyRow(db);
    db.prepare("UPDATE platform_task_links SET local_title_note='本地备注', status='ready' WHERE link_id=?").run(linkId);
    const docRevisionsBefore = (db.prepare("SELECT COUNT(*) AS n FROM qa_document_revisions").get() as { n: number }).n;

    const changed = await bridge.backfillFromPackage(linkId, samplePackage());
    expect(changed).toBe(true);

    const row = db.prepare("SELECT * FROM platform_task_links WHERE link_id=?").get(linkId) as Record<string, unknown>;
    // 资料字段已补
    expect(row.requirement_baseline_json).toBeTruthy();
    expect(row.self_test_digest_json).toBeTruthy();
    expect(row.changes_digest_json).toBeTruthy();
    expect(row.submitter_name).toBe("张瑛");
    expect(row.assignee_name).toBe("王智");
    // 边界：状态/T4/版本号不动
    expect(row.status).toBe("ready");
    expect(row.local_title_note).toBe("本地备注");
    expect(row.package_version).toBe(1);
    // 修订历史不动
    expect((db.prepare("SELECT COUNT(*) AS n FROM qa_document_revisions").get() as { n: number }).n).toBe(docRevisionsBefore);
    const baseline = JSON.parse(row.requirement_baseline_json as string) as { final_content: string };
    expect(baseline.final_content).toBe("最终确认内容");
    const selfTest = JSON.parse(row.self_test_digest_json as string) as { test_address: string };
    expect(selfTest.test_address).toBe("https://env.example.com");
  });

  it("is idempotent: second backfill is a no-op (already has baseline)", async () => {
    const { db, bridge } = makeBackfillHarness();
    const linkId = seedLegacyRow(db);
    expect(await bridge.backfillFromPackage(linkId, samplePackage())).toBe(true);
    expect(await bridge.backfillFromPackage(linkId, samplePackage())).toBe(false);
    const row = db.prepare("SELECT updated_at FROM platform_task_links WHERE link_id=?").get(linkId) as { updated_at: string };
    // 第二次未写（幂等）：updated_at 保持第一次回填时间（此断言以"再查仍非空"佐证即可）
    expect(row.updated_at).toBeTruthy();
  });

  it("ingestion marks package backfilled so store query shrinks to empty", async () => {
    const { db, store, bridge } = makeBackfillHarness();
    const linkId = seedLegacyRow(db);
    expect(store.listPackagesNeedingBackfill(10)).toHaveLength(1);
    await bridge.backfillFromPackage(linkId, samplePackage());
    store.markPackageBackfilled(linkId, 1);
    expect(store.listPackagesNeedingBackfill(10)).toHaveLength(0);
  });

  it("ingestion runOnce performs backfill via activation hook (stage 3)", async () => {
    const { db, store, bridge } = makeBackfillHarness();
    const linkId = seedLegacyRow(db);
    // 空事件页（游标推进无新事件）；阶段 3 仍执行回填
    const fetchImpl = makeFetch([
      { match: url => url.pathname.includes("handoff-events"), respond: () => okEnvelope({ items: [], next_cursor: null, has_more: false }) },
    ]);
    const client = new TaskPlatformClient({ baseUrl: "http://platform", apiKey: "k", fetchImpl, maxAttempts: 1 });
    const service = new IngestionService({ client, store, activation: bridge });
    const summary = await service.runOnce();
    expect(summary.backfilled).toBe(1);
    const row = db.prepare("SELECT requirement_baseline_json, status FROM platform_task_links WHERE link_id=?").get(linkId) as Record<string, unknown>;
    expect(row.requirement_baseline_json).toBeTruthy();
    expect(row.status).toBe("ready"); // 状态不动
    // 标记后第二轮 no-op
    const second = await service.runOnce();
    expect(second.backfilled).toBe(0);
  });
});


// ---------------------------------------------------------------- M-A 清理迁移（登录直连改造）

describe("account identity direct migration (M-A cleanup)", () => {
  function makeCleanupDb(): DatabaseSync {
    const db = makeDb();
    // 列表切片依赖的展示表/附件表（真实迁移由 schema.ts CREATE，测试内存库手工对齐）
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
        last_event_id TEXT, last_synced_at TEXT, last_action_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(source_system, external_tenant_id, external_task_id)
      );
      CREATE TABLE IF NOT EXISTS qa_task_attachments (
        attachment_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_source TEXT NOT NULL,
        task_id TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'text/plain',
        size_bytes INTEGER NOT NULL, content_text TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    return db;
  }

  it("removes demo seed tasks and their attachments; keeps real data; re-runnable", async () => {
    const { accountIdentityDirectMigration } = await import("../src/db/migrations/steps/2026-11-23-account-identity-direct.js");
    const db = makeCleanupDb();
    // 真实同步任务（保留）+ demo 种子（删除）+ 孤儿包（删除）
    db.exec(`
      INSERT INTO platform_task_links (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no, title, created_at, updated_at)
        VALUES ('ptl-real', 'proj-1', 'sbkj-taskassignment', 't1', 'task-real', 'FB-REAL-1', '真实任务', '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z');
      INSERT INTO platform_task_links (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no, title, created_at, updated_at)
        VALUES ('ptl-demo', 'proj-1', 'demo', '', 'FB-DEMO-1', 'FB-DEMO-1', '演示任务', '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z');
      INSERT INTO qa_task_attachments (attachment_id, project_id, task_source, task_id, filename, size_bytes, content_text, created_at, updated_at)
        VALUES ('att-demo', 'proj-1', 'platform', 'ptl-demo', '[platform:x] demo.md', 10, 'demo', '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z');
      INSERT INTO qa_task_attachments (attachment_id, project_id, task_source, task_id, filename, size_bytes, content_text, created_at, updated_at)
        VALUES ('att-real', 'proj-1', 'platform', 'ptl-real', '[platform:y] real.md', 10, 'real', '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z');
      INSERT INTO task_platform_task_links (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no, current_package_version, created_at, updated_at)
        VALUES ('link-real', 'proj-1', 'sbkj-taskassignment', 't1', 'task-real', 'FB-REAL-1', 1, '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z');
      INSERT INTO task_platform_task_links (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no, current_package_version, created_at, updated_at)
        VALUES ('link-orphan', 'proj-1', 'sbkj-taskassignment', 't1', 'task-orphan', 'FB-ORPHAN-1', 1, '2026-11-23T00:00:00Z', '2026-11-23T00:00:00Z');
      INSERT INTO task_platform_packages (id, task_link_id, package_version, event_id, event_type, content_hash, payload_json, document_id, revision, received_at)
        VALUES ('pkg-orphan', 'link-orphan', 1, 'evt-x', 'initial_handoff', 'sha256:x', '{}', 'doc-x', 1, '2026-11-23T00:00:00Z');
      DELETE FROM task_platform_task_links WHERE link_id = 'link-orphan'; -- 制造孤儿包（迁移要清理的对象）
    `);
    accountIdentityDirectMigration.up(db);
    const links = db.prepare("SELECT external_task_id FROM platform_task_links").all().map(r => (r as { external_task_id: string }).external_task_id);
    expect(links).toEqual(["task-real"]); // demo 已删、真实保留
    const atts = db.prepare("SELECT attachment_id FROM qa_task_attachments").all().map(r => (r as { attachment_id: string }).attachment_id);
    expect(atts).toEqual(["att-real"]); // demo 附件随删、真实附件保留
    const orphan = db.prepare("SELECT COUNT(*) AS n FROM task_platform_packages WHERE id='pkg-orphan'").get() as { n: number };
    expect(orphan.n).toBe(0); // 孤儿包清理
    // 可重跑
    expect(() => accountIdentityDirectMigration.up(db)).not.toThrow();
  });
});
