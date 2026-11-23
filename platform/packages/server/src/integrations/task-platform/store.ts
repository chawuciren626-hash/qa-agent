/**
 * 任务平台集成的持久化层：接口（ports）+ node:sqlite 实现（adapters）。
 *
 * 幂等防线逐层落唯一键（对接方案 §13.2）：
 * - 事件：UNIQUE(event_id)
 * - 项目映射：UNIQUE(source_system, external_tenant_id, external_product_line_id)
 * - 任务映射：UNIQUE(source_system, external_tenant_id, external_task_id)
 * - 包：UNIQUE(task_link_id, package_version)
 * - 文档修订：UNIQUE(document_id, package_version)
 * - 结果 outbox：UNIQUE(result_id, result_version)
 *
 * schema 由迁移 step 创建（2026-11-2x-task-platform-integration）；本层不做 DDL 判断，
 * 遵循仓库迁移规范：迁移在启动时按 ledger 执行，表一定存在。
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  HandoffEventDto,
  HandoffEventType,
  ProductLineDto,
} from "./contracts.js";

export interface ProjectSyncLinkRow {
  link_id: string;
  project_id: string;
  source_system: string;
  external_tenant_id: string;
  external_product_line_id: string;
  external_line_code: string;
  display_name: string;
  external_url: string | null;
  sync_status: "active" | "inactive";
  last_synced_at: string | null;
}

export interface TaskLinkRow {
  link_id: string;
  project_id: string;
  source_system: string;
  external_tenant_id: string;
  external_task_id: string;
  external_task_no: string;
  current_package_version: number;
  current_pm_round_id: string | null;
  status: string;
  ai_summary_json: string | null;
  suggested_priority: string | null;
  created_at: string;
  updated_at: string;
}

export interface PackageRow {
  id: string;
  task_link_id: string;
  package_version: number;
  event_id: string;
  event_type: HandoffEventType;
  content_hash: string;
  payload_json: string;
  document_id: string;
  revision: number;
  activated: 0 | 1;
  received_at: string;
}

export interface OutboxRow {
  id: string;
  task_id: string;
  result_id: string;
  result_version: number;
  idempotency_key: string;
  payload_json: string;
  attempts: number;
  next_retry_at: string;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface IngestCursorRow {
  id: number;
  cursor: string | null;
  updated_at: string;
}

export interface TaskPlatformStore {
  /** ---- 事件游标（单行） ---- */
  getIngestCursor(): string | null;
  setIngestCursor(cursor: string): void;

  /** ---- 事件去重 + 处理状态（审阅意见 2：失败事件可重试，不漏单） ---- */
  hasEvent(eventId: string): boolean;
  /** 新事件登记为 pending；已存在时返回 false 不覆盖原状态。 */
  recordEvent(event: HandoffEventDto): boolean;
  /** 取出到期的待处理/待重试事件（按重试时间升序）。 */
  dueEvents(nowIso: string, limit: number): HandoffEventDto[];
  /** 标记事件处理成功。 */
  markEventSucceeded(eventId: string): void;
  /** 标记事件处理失败并安排下次重试时间（指数退避由调用方计算）。 */
  markEventFailed(eventId: string, attempts: number, nextRetryAt: string, lastError: string): void;
  /** 事件已重试次数（无记录返回 0）。 */
  eventAttempts(eventId: string): number;

  /** ---- 项目同步映射 ---- */
  findProjectLink(tenantId: string, productLineId: string): ProjectSyncLinkRow | null;
  upsertProjectLink(link: Omit<ProjectSyncLinkRow, "link_id">): { created: boolean };

  /** ---- 任务映射 ---- */
  findTaskLink(tenantId: string, taskId: string): TaskLinkRow | null;
  createTaskLink(link: Omit<TaskLinkRow, "link_id" | "created_at" | "updated_at">): TaskLinkRow;
  updateTaskLink(
    linkId: string,
    patch: Partial<Pick<TaskLinkRow, "current_package_version" | "current_pm_round_id" | "status" | "ai_summary_json" | "suggested_priority">>,
  ): void;
  listTaskLinksByProject(projectId: string): TaskLinkRow[];
  listTaskLinksByStatus(projectId: string, status: string): TaskLinkRow[];
  countTaskLinksByStatus(projectId: string): Record<string, number>;

  /** ---- 包接收（幂等：同任务同版本唯一） ---- */
  findPackage(taskLinkRowId: string, packageVersion: number): PackageRow | null;
  recordPackage(row: Omit<PackageRow, "id" | "received_at">): PackageRow;

  /** ---- 结果 outbox ---- */
  enqueueResult(row: Omit<OutboxRow, "id" | "attempts" | "next_retry_at" | "last_error" | "delivered_at" | "created_at">): { created: boolean };
  dueOutboxRows(nowIso: string, limit: number): OutboxRow[];
  markOutboxDelivered(id: string, deliveredAt: string): void;
  markOutboxRetry(id: string, attempts: number, nextRetryAt: string, lastError: string): void;
}

export class SqliteTaskPlatformStore implements TaskPlatformStore {
  constructor(private readonly db: DatabaseSync) {}

  getIngestCursor(): string | null {
    const row = this.db.prepare("SELECT cursor FROM task_platform_ingest_cursor WHERE id = 1").get() as
      | { cursor: string | null }
      | undefined;
    const value = row?.cursor ?? null;
    // 空串 = 已被 resetCursor 清空，语义等同"无游标，从最早事件开始"
    return value === "" ? null : value;
  }

  setIngestCursor(cursor: string): void {
    this.db.prepare(
      `INSERT INTO task_platform_ingest_cursor (id, cursor, updated_at) VALUES (1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).run(cursor);
  }

  hasEvent(eventId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM task_platform_events WHERE event_id = ?").get(eventId);
    return row !== undefined;
  }

  recordEvent(event: HandoffEventDto): boolean {
    const run = this.db.prepare(
      `INSERT OR IGNORE INTO task_platform_events
        (event_id, event_type, external_tenant_id, external_task_id, task_no,
         package_version, parent_package_version, pm_round_id, occurred_at, product_line_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.event_id,
      event.event_type,
      event.tenant_id,
      event.task_id,
      event.task_no,
      event.package_version,
      event.parent_package_version,
      event.pm_round_id,
      event.occurred_at,
      JSON.stringify(event.product_line_ids ?? []),
    ) as unknown;
    return Number((run as { changes?: number | bigint } | null)?.changes ?? 0) > 0;
  }

  dueEvents(nowIso: string, limit: number): HandoffEventDto[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_platform_events
         WHERE process_status IN ('pending','failed')
           AND (process_next_retry_at IS NULL OR process_next_retry_at <= ?)
         ORDER BY COALESCE(process_next_retry_at, occurred_at) ASC
         LIMIT ?`,
      )
      .all(nowIso, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(row => ({
      event_id: String(row.event_id),
      event_type: String(row.event_type) as HandoffEventDto["event_type"],
      tenant_id: String(row.external_tenant_id),
      task_id: String(row.external_task_id),
      task_no: String(row.task_no),
      package_version: Number(row.package_version),
      parent_package_version: row.parent_package_version === null ? null : Number(row.parent_package_version),
      pm_round_id: row.pm_round_id === null ? null : String(row.pm_round_id),
      product_line_ids: JSON.parse(String(row.product_line_ids_json ?? "[]")) as string[],
      occurred_at: String(row.occurred_at),
    }));
  }

  markEventSucceeded(eventId: string): void {
    this.db
      .prepare(
        `UPDATE task_platform_events
         SET process_status = 'succeeded', process_next_retry_at = NULL, process_last_error = NULL
         WHERE event_id = ?`,
      )
      .run(eventId);
  }

  markEventFailed(eventId: string, attempts: number, nextRetryAt: string, lastError: string): void {
    this.db
      .prepare(
        `UPDATE task_platform_events
         SET process_status = 'failed', process_attempts = ?, process_next_retry_at = ?, process_last_error = ?
         WHERE event_id = ?`,
      )
      .run(attempts, nextRetryAt, lastError.slice(0, 500), eventId);
  }

  eventAttempts(eventId: string): number {
    const row = this.db
      .prepare("SELECT process_attempts FROM task_platform_events WHERE event_id = ?")
      .get(eventId) as { process_attempts: number } | undefined;
    return Number(row?.process_attempts ?? 0);
  }

  findProjectLink(tenantId: string, productLineId: string): ProjectSyncLinkRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM task_platform_project_links
           WHERE source_system = 'sbkj-taskassignment' AND external_tenant_id = ? AND external_product_line_id = ?`,
        )
        .get(tenantId, productLineId) as ProjectSyncLinkRow | undefined) ?? null
    );
  }

  upsertProjectLink(link: Omit<ProjectSyncLinkRow, "link_id">): { created: boolean } {
    const existing = this.findProjectLink(link.external_tenant_id, link.external_product_line_id);
    if (existing) {
      this.db.prepare(
        `UPDATE task_platform_project_links
         SET project_id = ?, external_line_code = ?, display_name = ?, external_url = ?,
             sync_status = ?, last_synced_at = ?
         WHERE link_id = ?`,
      ).run(
        link.project_id,
        link.external_line_code,
        link.display_name,
        link.external_url,
        link.sync_status,
        link.last_synced_at,
        existing.link_id,
      );
      return { created: false };
    }
    const linkId = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO task_platform_project_links
        (link_id, project_id, source_system, external_tenant_id, external_product_line_id,
         external_line_code, display_name, external_url, sync_status, last_synced_at)
       VALUES (?, ?, 'sbkj-taskassignment', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      linkId,
      link.project_id,
      link.external_tenant_id,
      link.external_product_line_id,
      link.external_line_code,
      link.display_name,
      link.external_url,
      link.sync_status,
      link.last_synced_at,
    );
    return { created: true };
  }

  findTaskLink(tenantId: string, taskId: string): TaskLinkRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM task_platform_task_links
           WHERE source_system = 'sbkj-taskassignment' AND external_tenant_id = ? AND external_task_id = ?`,
        )
        .get(tenantId, taskId) as TaskLinkRow | undefined) ?? null
    );
  }

  createTaskLink(link: Omit<TaskLinkRow, "link_id" | "created_at" | "updated_at">): TaskLinkRow {
    const now = new Date().toISOString();
    const linkId = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO task_platform_task_links
        (link_id, project_id, source_system, external_tenant_id, external_task_id, external_task_no,
         current_package_version, current_pm_round_id, status, ai_summary_json, suggested_priority,
         created_at, updated_at)
       VALUES (?, ?, 'sbkj-taskassignment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      linkId,
      link.project_id,
      link.external_tenant_id,
      link.external_task_id,
      link.external_task_no,
      link.current_package_version,
      link.current_pm_round_id,
      link.status,
      link.ai_summary_json,
      link.suggested_priority,
      now,
      now,
    );
    return this.findTaskLink(link.external_tenant_id, link.external_task_id)!;
  }

  updateTaskLink(
    linkId: string,
    patch: Partial<Pick<TaskLinkRow, "current_package_version" | "current_pm_round_id" | "status" | "ai_summary_json" | "suggested_priority">>,
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.current_package_version !== undefined) {
      sets.push("current_package_version = ?");
      values.push(patch.current_package_version);
    }
    if (patch.current_pm_round_id !== undefined) {
      sets.push("current_pm_round_id = ?");
      values.push(patch.current_pm_round_id);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.ai_summary_json !== undefined) {
      sets.push("ai_summary_json = ?");
      values.push(patch.ai_summary_json);
    }
    if (patch.suggested_priority !== undefined) {
      sets.push("suggested_priority = ?");
      values.push(patch.suggested_priority);
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(linkId);
    this.db.prepare(`UPDATE task_platform_task_links SET ${sets.join(", ")} WHERE link_id = ?`).run(...values);
  }

  listTaskLinksByProject(projectId: string): TaskLinkRow[] {
    return this.db
      .prepare("SELECT * FROM task_platform_task_links WHERE project_id = ? ORDER BY updated_at DESC")
      .all(projectId) as unknown as TaskLinkRow[];
  }

  listTaskLinksByStatus(projectId: string, status: string): TaskLinkRow[] {
    return this.db
      .prepare(
        "SELECT * FROM task_platform_task_links WHERE project_id = ? AND status = ? ORDER BY updated_at DESC",
      )
      .all(projectId, status) as unknown as TaskLinkRow[];
  }

  countTaskLinksByStatus(projectId: string): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM task_platform_task_links WHERE project_id = ? GROUP BY status")
      .all(projectId) as unknown as { status: string; n: number }[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  findPackage(taskLinkRowId: string, packageVersion: number): PackageRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM task_platform_packages WHERE task_link_id = ? AND package_version = ?")
        .get(taskLinkRowId, packageVersion) as PackageRow | undefined) ?? null
    );
  }

  recordPackage(row: Omit<PackageRow, "id" | "received_at">): PackageRow {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO task_platform_packages
        (id, task_link_id, package_version, event_id, event_type, content_hash, payload_json,
         document_id, revision, activated, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(
      id,
      row.task_link_id,
      row.package_version,
      row.event_id,
      row.event_type,
      row.content_hash,
      row.payload_json,
      row.document_id,
      row.revision,
      row.activated,
    );
    return this.findPackage(row.task_link_id, row.package_version)!;
  }

  enqueueResult(row: Omit<OutboxRow, "id" | "attempts" | "next_retry_at" | "last_error" | "delivered_at" | "created_at">): { created: boolean } {
    const existing = this.db
      .prepare("SELECT id FROM task_platform_result_outbox WHERE result_id = ? AND result_version = ?")
      .get(row.result_id, row.result_version);
    if (existing) return { created: false };
    this.db.prepare(
      `INSERT INTO task_platform_result_outbox
        (id, task_id, result_id, result_version, idempotency_key, payload_json, attempts, next_retry_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, '1970-01-01T00:00:00.000Z')`,
    ).run(crypto.randomUUID(), row.task_id, row.result_id, row.result_version, row.idempotency_key, row.payload_json);
    return { created: true };
  }

  dueOutboxRows(nowIso: string, limit: number): OutboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM task_platform_result_outbox
         WHERE delivered_at IS NULL AND next_retry_at <= ?
         ORDER BY next_retry_at ASC LIMIT ?`,
      )
      .all(nowIso, limit) as unknown as OutboxRow[];
  }

  markOutboxDelivered(id: string, deliveredAt: string): void {
    this.db
      .prepare("UPDATE task_platform_result_outbox SET delivered_at = ?, attempts = attempts + 1 WHERE id = ?")
      .run(deliveredAt, id);
  }

  markOutboxRetry(id: string, attempts: number, nextRetryAt: string, lastError: string): void {
    this.db
      .prepare(
        "UPDATE task_platform_result_outbox SET attempts = ?, next_retry_at = ?, last_error = ? WHERE id = ?",
      )
      .run(attempts, nextRetryAt, lastError, id);
  }
}
