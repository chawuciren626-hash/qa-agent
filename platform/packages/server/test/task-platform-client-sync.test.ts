/**
 * 同步层阶段 A 单测：服务端 → 客户端的任务增量下发 / 状态登记 / 服务凭据校验。
 * 全部使用 node:sqlite 内存库 + 双迁移链建表，不碰网络。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { taskPlatformIntegration } from "../src/db/migrations/steps/2026-11-20-task-platform-integration.js";
import { taskPlatformEventRetry } from "../src/db/migrations/steps/2026-11-23-task-platform-event-retry.js";
import { taskPlatformPackageBackfill } from "../src/db/migrations/steps/2026-11-23-task-platform-package-backfill.js";
import {
  PlatformTaskSyncService,
} from "../src/integrations/task-platform/client-sync-service.js";

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
      requirement_baseline_json TEXT, self_test_digest_json TEXT, changes_digest_json TEXT,
      submitter_name TEXT, assignee_name TEXT, complexity_level TEXT, estimated_days INTEGER,
      last_action_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(source_system, external_tenant_id, external_task_id)
    );
    CREATE TABLE IF NOT EXISTS task_platform_packages (
      id TEXT PRIMARY KEY, task_link_id TEXT NOT NULL REFERENCES task_platform_task_links(link_id) ON DELETE CASCADE,
      package_version INTEGER NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL,
      content_hash TEXT NOT NULL, payload_json TEXT NOT NULL, document_id TEXT NOT NULL,
      revision INTEGER NOT NULL, activated INTEGER NOT NULL DEFAULT 1, received_at TEXT NOT NULL,
      UNIQUE(task_link_id, package_version)
    );
  `);
  return db;
}

function seedTask(db: DatabaseSync, linkId: string, taskId: string, updatedAt: string, status = "ready"): void {
  db.prepare(
    `INSERT INTO platform_task_links
       (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no,
        title, priority, product_lines_json, feedback_type, package_version, pm_round_no,
        source_url, status, ai_summary_json, suggested_priority, requirement_baseline_json,
        self_test_digest_json, changes_digest_json, submitter_name, assignee_name,
        created_at, updated_at)
     VALUES (?, 'proj-1', 'sbkj-taskassignment', 'tenant-1', ?, ?, '任务', 'high',
             '[{"name":"数据平台","isPrimary":true}]', 'requirement', 1, 1,
             'http://p/t', ?, '{"s":"x"}', 'high',
             '{"final_content":"基准"}', '{"test_address":"https://e"}', '[]',
             '张瑛', '王智', '2026-11-01T00:00:00Z', ?)`,
  ).run(linkId, taskId, taskId, status, updatedAt);
}

function makeService(db: DatabaseSync, recipient: string | null): PlatformTaskSyncService {
  return new PlatformTaskSyncService(db, () => recipient);
}

describe("PlatformTaskSyncService.listIncremental", () => {
  it("returns all tasks on first pull (no cursor)", () => {
    const db = makeDb();
    seedTask(db, "ptl-1", "task-1", "2026-11-20T00:00:00Z");
    seedTask(db, "ptl-2", "task-2", "2026-11-21T00:00:00Z");
    const page = makeService(db, null).listIncremental("recipient-1", null, 50);
    expect(page.items).toHaveLength(2);
    expect(page.has_more).toBe(false);
    expect(page.items[0]!.server_link_id).toBe("ptl-1"); // 升序
    expect(page.items[0]!.product_lines[0]!.name).toBe("数据平台");
    expect(page.items[0]!.requirement_baseline!.final_content).toBe("基准");
    expect(page.items[0]!.submitter).toBe("张瑛");
  });

  it("returns only tasks updated after the cursor (incremental)", () => {
    const db = makeDb();
    seedTask(db, "ptl-1", "task-1", "2026-11-20T00:00:00Z");
    seedTask(db, "ptl-2", "task-2", "2026-11-21T00:00:00Z");
    const page = makeService(db, null).listIncremental("recipient-1", "2026-11-20T12:00:00Z", 50);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.server_link_id).toBe("ptl-2");
  });

  it("paginates with next_cursor", () => {
    const db = makeDb();
    seedTask(db, "ptl-1", "task-1", "2026-11-20T00:00:00Z");
    seedTask(db, "ptl-2", "task-2", "2026-11-21T00:00:00Z");
    const svc = makeService(db, null);
    const page1 = svc.listIncremental("recipient-1", null, 1);
    expect(page1.items).toHaveLength(1);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBe("2026-11-20T00:00:00Z");
    const page2 = svc.listIncremental("recipient-1", page1.next_cursor, 1);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.server_link_id).toBe("ptl-2");
    expect(page2.has_more).toBe(false);
  });

  it("returns empty for non-recipient users when recipient configured", () => {
    const db = makeDb();
    seedTask(db, "ptl-1", "task-1", "2026-11-20T00:00:00Z");
    const page = makeService(db, "recipient-1").listIncremental("someone-else", null, 50);
    expect(page.items).toEqual([]);
    // admin 总可拉（运维排查）
    const adminPage = makeService(db, "recipient-1").listIncremental("admin", null, 50);
    expect(adminPage.items).toHaveLength(1);
  });
});

describe("PlatformTaskSyncService.registerState", () => {
  it("applies state and writes audit last_action_json", () => {
    const db = makeDb();
    seedTask(db, "ptl-1", "task-1", "2026-11-20T00:00:00Z");
    const result = makeService(db, null).registerState("ptl-1", "in_progress", "recipient-1");
    expect(result.applied).toBe(true);
    const row = db.prepare("SELECT status, last_action_json FROM platform_task_links WHERE link_id='ptl-1'").get() as {
      status: string;
      last_action_json: string;
    };
    expect(row.status).toBe("in_progress");
    const audit = JSON.parse(row.last_action_json) as { action: string; user_id: string; from: string };
    expect(audit.action).toBe("client_state_register");
    expect(audit.user_id).toBe("recipient-1");
    expect(audit.from).toBe("ready");
  });

  it("rejects illegal status", () => {
    const db = makeDb();
    seedTask(db, "ptl-1", "task-1", "2026-11-20T00:00:00Z");
    const result = makeService(db, null).registerState("ptl-1", "bogus", "u");
    expect(result.applied).toBe(false);
  });

  it("optimistic lock: stale expectedRevision is rejected", () => {
    const db = makeDb();
    seedTask(db, "ptl-1", "task-1", "2026-11-20T00:00:00Z");
    const svc = makeService(db, null);
    const first = svc.registerState("ptl-1", "in_progress", "u");
    expect(first.applied).toBe(true);
    const staleRevision = first.revision - 1;
    const second = svc.registerState("ptl-1", "result_returned", "u", staleRevision);
    expect(second.applied).toBe(false);
    expect(second.reason).toContain("乐观锁");
    // 状态未被覆盖
    const row = db.prepare("SELECT status FROM platform_task_links WHERE link_id='ptl-1'").get() as { status: string };
    expect(row.status).toBe("in_progress");
  });

  it("unknown task returns not applied with reason", () => {
    const db = makeDb();
    const result = makeService(db, null).registerState("ptl-missing", "ready", "u");
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("任务不存在");
  });
});

describe("service key", () => {
  it("issues base64url key and verifies with constant-time compare", () => {
    const key = PlatformTaskSyncService.issueServiceKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(PlatformTaskSyncService.verifyServiceKey(key, key)).toBe(true);
    expect(PlatformTaskSyncService.verifyServiceKey("wrong-key-same-length-as-key!!", key)).toBe(false);
    expect(PlatformTaskSyncService.verifyServiceKey("", key)).toBe(false);
    expect(PlatformTaskSyncService.verifyServiceKey(key, "")).toBe(false);
  });
});
