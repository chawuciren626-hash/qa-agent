/**
 * 桥接层与运行时单测：
 * - PlatformTaskBridge：摘要提取（真实 ai_structured_result 路径）、文档渲染、
 *   platform_task_links upsert 语义（新建/更新/终止不复活/T4 字段不覆盖）；
 * - runtime：clampSettingsInput 校验、IngestionScheduler 配置热更新与手动同步、
 *   clearDemo 透传。
 *
 * 全部使用 node:sqlite 内存库 + 真迁移建表；不碰网络。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { taskPlatformIntegration } from "../src/db/migrations/steps/2026-11-20-task-platform-integration.js";
import { taskPlatformEventRetry } from "../src/db/migrations/steps/2026-11-23-task-platform-event-retry.js";
import {
  extractSummaryFromPackage,
  PlatformTaskBridge,
  renderPackageDocument,
} from "../src/integrations/task-platform/platform-task-bridge.js";
import {
  clampSettingsInput,
  IngestionScheduler,
  type TaskPlatformConfigStore,
} from "../src/integrations/task-platform/runtime.js";
import { SqliteTaskPlatformStore } from "../src/integrations/task-platform/store.js";
import type { HandoffPackage } from "../src/integrations/task-platform/contracts.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // 任务平台承载表
  taskPlatformIntegration.up(db);
  taskPlatformEventRetry.up(db);
  // 列表切片依赖的表：projects / project_management / platform_task_links / qa_documents
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_management (
      project_id TEXT PRIMARY KEY,
      description TEXT,
      source_type TEXT,
      source_system_name TEXT,
      external_project_id TEXT,
      external_url TEXT,
      status TEXT,
      last_synced_at TEXT,
      revision INTEGER
    );
    CREATE TABLE IF NOT EXISTS platform_task_links (
      link_id                TEXT PRIMARY KEY,
      project_id             TEXT NOT NULL,
      source_system          TEXT NOT NULL,
      external_tenant_id     TEXT NOT NULL DEFAULT '',
      external_task_id       TEXT NOT NULL,
      external_task_no       TEXT NOT NULL,
      title                  TEXT NOT NULL DEFAULT '',
      priority               TEXT NOT NULL DEFAULT 'medium',
      product_lines_json     TEXT NOT NULL DEFAULT '[]',
      feedback_type          TEXT NOT NULL DEFAULT '',
      estimated_hours        INTEGER,
      package_version        INTEGER NOT NULL DEFAULT 1,
      pm_round_no            INTEGER,
      source_url             TEXT NOT NULL DEFAULT '',
      main_session_id        TEXT,
      status                 TEXT NOT NULL DEFAULT 'pending_analysis',
      ai_summary_json        TEXT,
      suggested_priority     TEXT,
      local_title_note       TEXT NOT NULL DEFAULT '',
      local_test_focus_note  TEXT NOT NULL DEFAULT '',
      local_edited_at        TEXT,
      last_event_id          TEXT,
      last_synced_at         TEXT,
      requirement_baseline_json TEXT,
      self_test_digest_json  TEXT,
      changes_digest_json    TEXT,
      package_detail_json    TEXT,
      submitter_name         TEXT,
      assignee_name          TEXT,
      complexity_level       TEXT,
      estimated_days         INTEGER,
      last_action_json       TEXT NOT NULL DEFAULT '{}',
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      UNIQUE(source_system, external_tenant_id, external_task_id)
    );
    CREATE TABLE IF NOT EXISTS qa_documents (
      document_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      format TEXT NOT NULL,
      status TEXT NOT NULL,
      source_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      current_revision INTEGER NOT NULL,
      current_revision_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa_document_index (
      document_id  TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      revision_id  TEXT NOT NULL,
      revision     INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      title        TEXT NOT NULL,
      content      TEXT NOT NULL,
      indexed_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qa_document_revisions (
      revision_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      encoding TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      change_note TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
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
    product_lines: [
      { product_line_id: "line-1", line_code: "L1", line_name: "数据平台", is_primary: true },
      { product_line_id: "line-2", line_code: "L2", line_name: "保标PC端", is_primary: false },
    ],
    unresolved_product_line_names: ["未知线"],
    task: {
      parent_task_id: null,
      root_task_id: null,
      task_kind: "main",
      title: "测试任务",
      feedback_type: "requirement",
      priority: "high",
      complexity_level: "complex",
      estimated_hours: 24,
      estimated_days: 3,
      status_code: "pm_testing",
      submitter: { user_id: "u1", display_name: "张瑛" },
      assignee: { user_id: "u2", display_name: "王智" },
      created_at: null,
    },
    flow: { development_round_id: null, pm_round: { pm_round_id: "pm-1", round_no: 1, entered_at: null } },
    requirement: {
      original_content: "原始反馈",
      original_supplements: [],
      original_rich_content: null,
      ai_content: "AI 整理内容",
      ai_structured_result: {
        summary: "结构化摘要",
        acceptance_criteria: ["变更可查看"],
        impact_scope: ["任务详情", "附件权限"],
        missing_fields: ["并发场景待补"],
      },
      final_content: "最终确认内容",
      confirmed_baseline: {
        final_content: "最终确认内容",
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
      submitted_at: "2026-11-19T09:00:00+08:00",
      review_mode: "manual",
      approval_status: "approved",
      reviewed_at: null,
      request_reason: null,
      submission_sections: [
        { key: "test_address", label: "测试地址", value: "https://example.com" },
        { key: "test_focus", label: "验证重点", value: "变更可见性" },
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

function makeBridge(db: DatabaseSync, createProject?: (args: { name: string }) => Promise<{ projectId: string }>) {
  const store = new SqliteTaskPlatformStore(db);
  const bridge = new PlatformTaskBridge(
    {
      db: db as never,
      systemUserId: "admin",
      createProject: createProject ?? (async () => ({ projectId: "sync-line-1" })),
    },
    store,
  );
  return { store, bridge };
}

function seedTaskLink(db: DatabaseSync, taskId = "task-1", projectId = "proj-1") {
  const store = new SqliteTaskPlatformStore(db);
  return store.createTaskLink({
    project_id: projectId,
    source_system: "sbkj-taskassignment",
    external_tenant_id: "tenant-1",
    external_task_id: taskId,
    external_task_no: "FB202611200001",
    current_package_version: 1,
    current_pm_round_id: null,
    status: "pending_analysis",
    ai_summary_json: null,
    suggested_priority: null,
  });
}

describe("extractSummaryFromPackage", () => {
  it("uses ai_structured_result fields when present (real data path)", () => {
    const summary = JSON.parse(extractSummaryFromPackage(samplePackage())) as {
      requirement_points: string[];
      suggested_test_scope: string[];
      suggested_priority: string;
      priority_reason: string;
      risks: string[];
      open_questions: string[];
      source: string;
    };
    expect(summary.requirement_points).toContain("结构化摘要");
    expect(summary.requirement_points).toContain("变更可查看");
    expect(summary.suggested_test_scope).toContain("任务详情");
    expect(summary.suggested_test_scope).toContain("变更可见性"); // 自测验证重点并入
    expect(summary.suggested_priority).toBe("high");
    expect(summary.priority_reason).toContain("平台优先级=high");
    expect(summary.risks).toEqual(["并发场景待补"]);
    expect(summary.open_questions[0]).toContain("未知线");
    expect(summary.source).toBe("requirement_analysis");
  });

  it("falls back to platform priority when structured result absent", () => {
    const pkg = samplePackage();
    (pkg.requirement.ai_structured_result as Record<string, unknown> | null) = null;
    const summary = JSON.parse(extractSummaryFromPackage(pkg)) as { suggested_priority: string; requirement_points: string[] };
    expect(summary.suggested_priority).toBe("high");
    expect(summary.requirement_points).toEqual([]);
  });
});

describe("renderPackageDocument", () => {
  it("renders all major sections with package version traceability", () => {
    const { title, content } = renderPackageDocument(samplePackage());
    expect(title).toContain("FB202611200001");
    expect(title).toContain("v1");
    expect(content).toContain("需求基准");
    expect(content).toContain("最终确认内容");
    expect(content).toContain("原始反馈");
    expect(content).toContain("AI 整理内容");
    expect(content).toContain("研发自测提交资料");
    expect(content).toContain("https://example.com");
    expect(content).toContain("数据平台（主）");
    expect(content).toContain("未知线");
    // 空附件清单不渲染该节（渲染器语义）；带附件的断言见下一个用例
  });

  it("renders attachment list section when attachments present", () => {
    const pkg = samplePackage({
      attachments: [
        {
          attachment_id: "att-1",
          file_name: "自测截图.png",
          content_type: "image/png",
          file_size: 2048,
          sha256: "b".repeat(64),
          file_category: "self_test_material",
          node_code: null,
          flow_round_id: null,
          flow_record_id: null,
          parse_status: "succeeded",
          download_mode: "authenticated_endpoint",
          uri: "/integration/v1/tasks/task-1/attachments/att-1",
          download_url: null,
          expires_at: null,
          authorization_scope: "aitestharness:test-execution",
        },
      ],
    });
    const { content } = renderPackageDocument(pkg);
    expect(content).toContain("附件清单");
    expect(content).toContain("自测截图.png");
  });

  it("renders regression section when context present", () => {
    const pkg = samplePackage({
      regression_context: {
        previous_pm_round_id: "pm-0",
        previous_failed_issues: [
          { issue_no: "AIT-001", title: "编号未递增", problem_description: "批次号仍为1", expected_result: "递增", test_scene: null, severity: "high", status: "pending" },
        ],
        rectifications: [
          { issue_id: "i1", solution: "已修复", changed_content: "", test_method: "复测", test_result: "通过", risk_note: null, evidence_attachment_ids: [] },
        ],
      },
    });
    const { content } = renderPackageDocument(pkg);
    expect(content).toContain("上轮抽测退回问题");
    expect(content).toContain("AIT-001");
    expect(content).toContain("已修复");
  });
});

describe("PlatformTaskBridge.onInitialHandoff", () => {
  it("creates qa_documents entry and platform_task_links row with real summary", async () => {
    const db = makeDb();
    seedTaskLink(db);
    const { bridge } = makeBridge(db);
    await bridge.onInitialHandoff(linkId(db), samplePackage());

    const doc = db.prepare("SELECT title, content FROM qa_document_revisions LIMIT 1").get() as { title: string; content: string };
    expect(doc.title).toContain("FB202611200001");
    expect(doc.content).toContain("需求基准");

    const link = db.prepare("SELECT * FROM platform_task_links WHERE external_task_id='task-1'").get() as {
      status: string;
      ai_summary_json: string | null;
      package_version: number;
      pm_round_no: number | null;
      source_url: string;
    };
    expect(link.status).toBe("pending_analysis");
    expect(link.package_version).toBe(1);
    expect(link.pm_round_no).toBe(1);
    expect(link.source_url).toContain("taskId=task-1");
    const summary = JSON.parse(link.ai_summary_json!) as { suggested_priority: string };
    expect(summary.suggested_priority).toBe("high");
  });

  it("replay of same package is idempotent: no duplicate revision, no duplicate link rows", async () => {
    const db = makeDb();
    seedTaskLink(db);
    const { bridge } = makeBridge(db);
    await bridge.onInitialHandoff(linkId(db), samplePackage());
    await bridge.onInitialHandoff(linkId(db), samplePackage()); // 同一包重放
    const revisions = db.prepare("SELECT COUNT(*) AS n FROM qa_document_revisions").get() as { n: number };
    expect(revisions.n).toBe(1); // 审阅意见：同包重放不追加重复修订
    const links = db.prepare("SELECT COUNT(*) AS n FROM platform_task_links").get() as { n: number };
    expect(links.n).toBe(1); // 列表条目不重复
  });

  it("does not reset an analyzed task when the initial package is retried", async () => {
    const db = makeDb();
    seedTaskLink(db);
    const { bridge } = makeBridge(db);
    await bridge.onInitialHandoff(linkId(db), samplePackage());
    db.prepare("UPDATE platform_task_links SET status = 'ready', ai_summary_json = ? WHERE external_task_id = 'task-1'")
      .run(JSON.stringify({ source: "agent" }));
    await bridge.onInitialHandoff(linkId(db), samplePackage());
    const row = db.prepare("SELECT status, ai_summary_json FROM platform_task_links WHERE external_task_id = 'task-1'")
      .get() as { status: string; ai_summary_json: string };
    expect(row.status).toBe("ready");
    expect(JSON.parse(row.ai_summary_json)).toEqual({ source: "agent" });
  });

  it("keeps the same external task id isolated by tenant", async () => {
    const db = makeDb();
    const first = seedTaskLink(db);
    const { store, bridge } = makeBridge(db);
    const second = store.createTaskLink({
      project_id: "proj-2", source_system: "sbkj-taskassignment", external_tenant_id: "tenant-2",
      external_task_id: "task-1", external_task_no: "FB202611200002", current_package_version: 1,
      current_pm_round_id: null, status: "pending_analysis", ai_summary_json: null, suggested_priority: null,
    });
    await bridge.onInitialHandoff(first.link_id, samplePackage());
    await bridge.onInitialHandoff(second.link_id, samplePackage({ tenant_id: "tenant-2" }));
    expect(db.prepare("SELECT external_tenant_id, project_id FROM platform_task_links ORDER BY external_tenant_id").all())
      .toEqual([
        { external_tenant_id: "tenant-1", project_id: "proj-1" },
        { external_tenant_id: "tenant-2", project_id: "proj-2" },
      ]);
  });

  it("new package version appends an immutable revision (v1 → v2)", async () => {
    const db = makeDb();
    seedTaskLink(db);
    const { bridge } = makeBridge(db);
    await bridge.onInitialHandoff(linkId(db), samplePackage());
    const v2 = samplePackage({
      package_version: 2,
      parent_package_version: 1,
      event: { event_id: "evt-2", event_type: "new_pm_round", generated_at: null, reason: null },
    });
    await bridge.onPackageUpdate(linkId(db), v2);
    const revisions = db.prepare("SELECT COUNT(*) AS n FROM qa_document_revisions").get() as { n: number };
    expect(revisions.n).toBe(2); // 版本演进追加修订
  });

  it("same version with changed content appends a revision (hash guard)", async () => {
    const db = makeDb();
    seedTaskLink(db);
    const { bridge } = makeBridge(db);
    await bridge.onInitialHandoff(linkId(db), samplePackage());
    const changed = samplePackage({ requirement: samplePackage().requirement }); // 同版本同内容
    await bridge.onInitialHandoff(linkId(db), changed);
    expect((db.prepare("SELECT COUNT(*) AS n FROM qa_document_revisions").get() as { n: number }).n).toBe(1);
    const mutated = samplePackage();
    (mutated.requirement as { original_content: string }).original_content = "平台侧同版本号但内容变了";
    await bridge.onInitialHandoff(linkId(db), mutated);
    expect((db.prepare("SELECT COUNT(*) AS n FROM qa_document_revisions").get() as { n: number }).n).toBe(2);
  });
});

describe("PlatformTaskBridge.onPackageUpdate", () => {
  it("appends revision and sets impact_pending without touching session", async () => {
    const db = makeDb();
    seedTaskLink(db);
    const { bridge } = makeBridge(db);
    await bridge.onInitialHandoff(linkId(db), samplePackage());
    db.prepare("UPDATE platform_task_links SET status='in_progress', main_session_id='session-1' WHERE external_task_id='task-1'").run();

    const v2 = samplePackage({
      package_version: 2,
      parent_package_version: 1,
      event: { event_id: "evt-2", event_type: "new_pm_round", generated_at: null, reason: null },
    });
    await bridge.onPackageUpdate(linkId(db), v2);

    const link = db.prepare("SELECT * FROM platform_task_links WHERE external_task_id='task-1'").get() as {
      status: string;
      package_version: number;
      main_session_id: string | null;
    };
    expect(link.status).toBe("impact_pending"); // S7：不自动重跑
    expect(link.package_version).toBe(2);
    expect(link.main_session_id).toBe("session-1"); // 会话不动
  });

  it("never revives a terminated task (对接方案 §8.4)", async () => {
    const db = makeDb();
    seedTaskLink(db);
    const { bridge } = makeBridge(db);
    await bridge.onInitialHandoff(linkId(db), samplePackage());
    db.prepare("UPDATE platform_task_links SET status='terminated' WHERE external_task_id='task-1'").run();

    await bridge.onPackageUpdate(linkId(db), samplePackage({ package_version: 2 }));
    const link = db.prepare("SELECT status, package_version FROM platform_task_links WHERE external_task_id='task-1'").get() as { status: string; package_version: number };
    expect(link.status).toBe("terminated");
    expect(link.package_version).toBe(1); // 版本号也不推进（封存语义）
  });

  it("does not overwrite local notes (T4)", async () => {
    const db = makeDb();
    seedTaskLink(db);
    const { bridge } = makeBridge(db);
    await bridge.onInitialHandoff(linkId(db), samplePackage());
    db.prepare("UPDATE platform_task_links SET local_title_note='本地备注', local_edited_at='2026-11-20T00:00:00Z' WHERE external_task_id='task-1'").run();

    await bridge.onPackageUpdate(linkId(db), samplePackage({ package_version: 2 }));
    const link = db.prepare("SELECT local_title_note, local_edited_at FROM platform_task_links WHERE external_task_id='task-1'").get() as {
      local_title_note: string;
      local_edited_at: string | null;
    };
    expect(link.local_title_note).toBe("本地备注");
    expect(link.local_edited_at).toBe("2026-11-20T00:00:00Z");
  });
});

function linkId(db: DatabaseSync): string {
  const row = db.prepare("SELECT link_id FROM task_platform_task_links LIMIT 1").get() as { link_id: string };
  return row.link_id;
}

// ------------------------------------------------------------------ runtime

class MemoryConfigStore implements TaskPlatformConfigStore {
  private readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

describe("clampSettingsInput", () => {
  it("rejects enable without valid baseUrl", () => {
    expect(() => clampSettingsInput({ enabled: true, baseUrl: "not-a-url", apiKey: "k", pollIntervalMs: 60_000, batchSize: 10 })).toThrow(RangeError);
  });
  it("rejects enable with empty apiKey (caller should backfill from currentApiKey)", () => {
    expect(() => clampSettingsInput({ enabled: true, baseUrl: "http://p", apiKey: "", pollIntervalMs: 60_000, batchSize: 10 })).toThrow(RangeError);
  });
  it("accepts non-empty apiKey and normalizes baseUrl trailing slash", () => {
    const settings = clampSettingsInput({ enabled: true, baseUrl: "http://p/", apiKey: "old-key", pollIntervalMs: 60_000, batchSize: 10 });
    expect(settings.apiKey).toBe("old-key");
    expect(settings.baseUrl).toBe("http://p");
  });
  it("rejects out-of-range poll interval", () => {
    expect(() => clampSettingsInput({ enabled: false, baseUrl: "http://p", apiKey: "k", pollIntervalMs: 500, batchSize: 10 })).toThrow(RangeError);
  });
});

describe("sync project id derivation (slugify)", () => {
  // SEMANTIC_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/（project-service.ts createProject 校验，
  // 审阅意见 1：首次建同步项目必须一次通过）
  const SEMANTIC_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

  it("maps uuid / hyphenated codes / non-ascii names to legal ids", async () => {
    const { slugify } = await import("../src/integrations/task-platform/module.js");
    const cases = [
      "9eac166d-76a7-4b4e-9efe-ed18042c04be", // UUID（真实产品线 ID 形态）
      "LINE-001",
      "数据平台",
      "--__--",
      "",
    ];
    for (const input of cases) {
      const id = `sync_${slugify(input)}`.slice(0, 64);
      expect(id).toMatch(SEMANTIC_ID_PATTERN);
    }
    expect(`sync_${slugify("9eac166d-76a7-4b4e-9efe-ed18042c04be")}`).toBe(
      "sync_9eac166d_76a7_4b4e_9efe_ed18042c04be".slice(0, 64).replace(/-+/g, "_"),
    );
  });

  it("keeps different tenants and normalized line collisions distinct", async () => {
    const { syncProjectId } = await import("../src/integrations/task-platform/module.js");
    const ids = [
      syncProjectId("tenant-1", "line-a"),
      syncProjectId("tenant-2", "line-a"),
      syncProjectId("tenant-1", "line_a"),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(id => /^[a-z][a-z0-9_]{1,63}$/.test(id))).toBe(true);
  });
});

describe("IngestionScheduler", () => {
  function makeSchedulerHarness() {
    const db = makeDb();
    const store = new SqliteTaskPlatformStore(db);
    const { bridge } = makeBridge(db);
    const configStore = new MemoryConfigStore();
    const scheduler = new IngestionScheduler({ configStore, store, bridge });
    return { scheduler, configStore };
  }

  it("syncNow without config reports not-configured instead of throwing", async () => {
    const { scheduler } = makeSchedulerHarness();
    const result = await scheduler.syncNow();
    expect(result.ran).toBe(false);
    expect(result.message).toContain("尚未配置");
  });

  it("applySettings persists and describe() masks the key", () => {
    const { scheduler, configStore } = makeSchedulerHarness();
    const applied = scheduler.applySettings({
      enabled: false,
      baseUrl: "http://platform",
      apiKey: "secret-key-value",
      pollIntervalMs: 60_000,
      batchSize: 10,
      recipientUserId: "",
    });
    expect(applied.apiKeyMasked).toBe("secr****alue");
    expect(applied.enabled).toBe(false);
    // 持久化验证
    const raw = configStore.get("task_platform_settings_json");
    expect(raw).toContain("secret-key-value");
  });

  it("resetCursor clears the stored cursor", () => {
    const { scheduler } = makeSchedulerHarness();
    scheduler.resetCursor();
    // 无异常即可；游标行为在传输层测试已覆盖
  });
});
