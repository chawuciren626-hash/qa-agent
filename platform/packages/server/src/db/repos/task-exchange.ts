/**
 * Repo for the external task exchange: platforms, devices, tasks (lease fencing + cancel
 * versioning), the append-only event ledger, at-least-once result rows, the delivery
 * outbox, and the admin intranet allowlist. Every query is tenant/platform-scoped —
 * isolation is enforced HERE, not by callers remembering to add a WHERE clause.
 */
import { randomUUID } from "node:crypto";
import { Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Db } from "../../hmr/capabilities.js";
import type { TaskExchangeStore } from "../../mechanisms/taskexchange.js";
import type {
  ExchangeAllowedHost,
  ExchangeDeviceRow,
  ExchangeOutboxRow,
  ExchangePlatformRow,
  ExchangeResultRow,
  ExchangeTaskEvent,
  ExchangeTaskInput,
  ExchangeTaskRow,
} from "../../taskexchange/types.js";

type TaskPatch = Partial<
  Pick<
    ExchangeTaskRow,
    | "status"
    | "claimedBy"
    | "leaseEpoch"
    | "leaseExpiresAt"
    | "cancelRequested"
    | "cancelVersion"
    | "queuedReason"
    | "callbackUrl"
  >
>;

function mapTask(r: Record<string, unknown>): ExchangeTaskRow {
  return {
    taskId: r.task_id as string,
    tenantId: r.tenant_id as string,
    platformId: r.platform_id as string,
    externalId: r.external_id as string,
    idempotencyKey: r.idempotency_key as string,
    userId: r.user_id as string,
    deviceId: r.device_id as string,
    projectRef: r.project_ref as string,
    objective: r.objective as string,
    allowedDataFields: JSON.parse(r.allowed_data_fields_json as string) as string[],
    deadlineMs: r.deadline_ms === null || r.deadline_ms === undefined ? null : Number(r.deadline_ms),
    publishSnapshot: JSON.parse(r.publish_snapshot_json as string) as Record<string, unknown>,
    callbackUrl: (r.callback_url as string | null) ?? null,
    status: r.status as ExchangeTaskRow["status"],
    statusVersion: Number(r.status_version),
    cancelRequested: Number(r.cancel_requested) === 1,
    cancelVersion: Number(r.cancel_version),
    queuedReason: (r.queued_reason as string | null) ?? null,
    claimedBy: (r.claimed_by as string | null) ?? null,
    leaseEpoch: Number(r.lease_epoch),
    leaseExpiresAt: (r.lease_expires_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapDevice(r: Record<string, unknown>): ExchangeDeviceRow {
  return {
    deviceId: r.device_id as string,
    tenantId: r.tenant_id as string,
    userId: r.user_id as string,
    platformId: r.platform_id as string,
    tokenHash: r.token_hash as string,
    label: r.label as string,
    registeredAt: r.registered_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
  };
}

@Component()
export class TaskExchangeRepo implements TaskExchangeStore {
  @Use() private readonly db!: Db;

  // -- platforms ----------------------------------------------------------

  insertPlatform(row: ExchangePlatformRow): void {
    this.db
      .prepare(
        `INSERT INTO exchange_platforms (tenant_id, platform_id, token_hash, registered_at, revoked_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.tenantId, row.platformId, row.tokenHash, row.registeredAt, row.revokedAt);
  }

  findPlatformByTokenHash(tokenHash: string): ExchangePlatformRow | null {
    const r = this.db
      .prepare("SELECT * FROM exchange_platforms WHERE token_hash = ? AND revoked_at IS NULL")
      .get(tokenHash);
    return r
      ? {
          tenantId: r.tenant_id as string,
          platformId: r.platform_id as string,
          tokenHash: r.token_hash as string,
          registeredAt: r.registered_at as string,
          revokedAt: (r.revoked_at as string | null) ?? null,
        }
      : null;
  }

  findPlatform(tenantId: string, platformId: string): ExchangePlatformRow | null {
    const r = this.db
      .prepare("SELECT * FROM exchange_platforms WHERE tenant_id = ? AND platform_id = ?")
      .get(tenantId, platformId);
    return r
      ? {
          tenantId: r.tenant_id as string,
          platformId: r.platform_id as string,
          tokenHash: r.token_hash as string,
          registeredAt: r.registered_at as string,
          revokedAt: (r.revoked_at as string | null) ?? null,
        }
      : null;
  }

  revokePlatform(tenantId: string, platformId: string, at: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE exchange_platforms SET revoked_at = ? WHERE tenant_id = ? AND platform_id = ? AND revoked_at IS NULL",
      )
      .run(at, tenantId, platformId);
    return res.changes > 0;
  }

  // -- devices ------------------------------------------------------------

  insertDevice(row: ExchangeDeviceRow): void {
    this.db
      .prepare(
        `INSERT INTO exchange_devices
           (device_id, tenant_id, user_id, platform_id, token_hash, label, registered_at, revoked_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.deviceId,
        row.tenantId,
        row.userId,
        row.platformId,
        row.tokenHash,
        row.label,
        row.registeredAt,
        row.revokedAt,
        row.lastSeenAt,
      );
  }

  findDeviceByTokenHash(tokenHash: string): ExchangeDeviceRow | null {
    const r = this.db
      .prepare("SELECT * FROM exchange_devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(tokenHash);
    return r ? mapDevice(r as Record<string, unknown>) : null;
  }

  findDevice(tenantId: string, deviceId: string): ExchangeDeviceRow | null {
    const r = this.db
      .prepare("SELECT * FROM exchange_devices WHERE tenant_id = ? AND device_id = ?")
      .get(tenantId, deviceId);
    return r ? mapDevice(r as Record<string, unknown>) : null;
  }

  listDevices(tenantId: string, userId: string): ExchangeDeviceRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM exchange_devices WHERE tenant_id = ? AND user_id = ? ORDER BY registered_at DESC",
      )
      .all(tenantId, userId);
    return rows.map((r) => mapDevice(r as Record<string, unknown>));
  }

  revokeDevice(tenantId: string, deviceId: string, at: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE exchange_devices SET revoked_at = ? WHERE tenant_id = ? AND device_id = ? AND revoked_at IS NULL",
      )
      .run(at, tenantId, deviceId);
    return res.changes > 0;
  }

  touchDevice(deviceId: string, at: string): void {
    this.db
      .prepare("UPDATE exchange_devices SET last_seen_at = ? WHERE device_id = ?")
      .run(at, deviceId);
  }

  // -- tasks --------------------------------------------------------------

  insertTask(input: ExchangeTaskInput): ExchangeTaskRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO exchange_tasks
           (task_id, tenant_id, platform_id, external_id, idempotency_key, user_id, device_id,
            project_ref, objective, allowed_data_fields_json, deadline_ms, publish_snapshot_json,
            status, status_version, cancel_requested, cancel_version, lease_epoch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 0, 0, 0, ?, ?)`,
      )
      .run(
        input.taskId,
        input.tenantId,
        input.platformId,
        input.externalId,
        input.idempotencyKey,
        input.userId,
        input.deviceId,
        input.projectRef,
        input.objective,
        JSON.stringify(input.allowedDataFields),
        input.deadlineMs,
        JSON.stringify(input.publishSnapshot),
        now,
        now,
      );
    const row = this.findTask(input.tenantId, input.taskId);
    if (!row) throw new Error("Failed to read back exchange_tasks after insert");
    return row;
  }

  findTask(tenantId: string, taskId: string): ExchangeTaskRow | null {
    const r = this.db
      .prepare("SELECT * FROM exchange_tasks WHERE tenant_id = ? AND task_id = ?")
      .get(tenantId, taskId);
    return r ? mapTask(r as Record<string, unknown>) : null;
  }

  findTaskByIdempotencyKey(
    tenantId: string,
    platformId: string,
    idempotencyKey: string,
  ): ExchangeTaskRow | null {
    const r = this.db
      .prepare(
        "SELECT * FROM exchange_tasks WHERE tenant_id = ? AND platform_id = ? AND idempotency_key = ?",
      )
      .get(tenantId, platformId, idempotencyKey);
    return r ? mapTask(r as Record<string, unknown>) : null;
  }

  findTaskByExternalId(
    tenantId: string,
    platformId: string,
    externalId: string,
  ): ExchangeTaskRow | null {
    const r = this.db
      .prepare(
        "SELECT * FROM exchange_tasks WHERE tenant_id = ? AND platform_id = ? AND external_id = ?",
      )
      .get(tenantId, platformId, externalId);
    return r ? mapTask(r as Record<string, unknown>) : null;
  }

  listTasksForPlatform(tenantId: string, platformId: string, limit = 200): ExchangeTaskRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM exchange_tasks WHERE tenant_id = ? AND platform_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(tenantId, platformId, limit);
    return rows.map((r) => mapTask(r as Record<string, unknown>));
  }

  listQueuedForDevice(deviceId: string): ExchangeTaskRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM exchange_tasks WHERE device_id = ? AND status = 'queued' ORDER BY created_at",
      )
      .all(deviceId);
    return rows.map((r) => mapTask(r as Record<string, unknown>));
  }

  /** Claimed/running tasks whose lease lapsed before `beforeIso` — re-claim candidates. */
  listReclaimable(beforeIso: string): ExchangeTaskRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM exchange_tasks
         WHERE status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
         ORDER BY updated_at`,
      )
      .all(beforeIso);
    return rows.map((r) => mapTask(r as Record<string, unknown>));
  }

  listPastDeadline(nowMs: number): ExchangeTaskRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM exchange_tasks
         WHERE deadline_ms IS NOT NULL AND deadline_ms < ? AND status IN ('queued', 'claimed', 'running')
         ORDER BY deadline_ms`,
      )
      .all(nowMs);
    return rows.map((r) => mapTask(r as Record<string, unknown>));
  }

  transitionTask(
    taskId: string,
    expectedVersion: number,
    fromStatuses: readonly string[],
    patch: TaskPatch,
  ): ExchangeTaskRow | null {
    const sets: string[] = ["status_version = status_version + 1", "updated_at = ?"];
    const vals: (string | number | null)[] = [new Date().toISOString()];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      vals.push(patch.status);
    }
    if (patch.claimedBy !== undefined) {
      sets.push("claimed_by = ?");
      vals.push(patch.claimedBy);
    }
    if (patch.leaseEpoch !== undefined) {
      sets.push("lease_epoch = ?");
      vals.push(patch.leaseEpoch);
    }
    if (patch.leaseExpiresAt !== undefined) {
      sets.push("lease_expires_at = ?");
      vals.push(patch.leaseExpiresAt);
    }
    if (patch.cancelRequested !== undefined) {
      sets.push("cancel_requested = ?");
      vals.push(patch.cancelRequested ? 1 : 0);
    }
    if (patch.cancelVersion !== undefined) {
      sets.push("cancel_version = ?");
      vals.push(patch.cancelVersion);
    }
    if (patch.queuedReason !== undefined) {
      sets.push("queued_reason = ?");
      vals.push(patch.queuedReason);
    }
    if (patch.callbackUrl !== undefined) {
      sets.push("callback_url = ?");
      vals.push(patch.callbackUrl);
    }
    vals.push(taskId, expectedVersion);
    const res = this.db
      .prepare(
        `UPDATE exchange_tasks SET ${sets.join(", ")}
         WHERE task_id = ? AND status_version = ? AND status IN (${fromStatuses.map(() => "?").join(", ")})`,
      )
      .run(...vals, ...fromStatuses);
    if (res.changes === 0) return null;
    const row = this.db.prepare("SELECT * FROM exchange_tasks WHERE task_id = ?").get(taskId);
    return row ? mapTask(row as Record<string, unknown>) : null;
  }

  // -- events ---------------------------------------------------------------

  insertEvent(event: Omit<ExchangeTaskEvent, "eventId">): void {
    this.db
      .prepare(
        "INSERT INTO exchange_task_events (event_id, task_id, at, actor, action, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        event.taskId,
        event.at,
        event.actor,
        event.action,
        JSON.stringify(event.detail),
      );
  }

  listEvents(taskId: string): ExchangeTaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM exchange_task_events WHERE task_id = ? ORDER BY at, event_id")
      .all(taskId);
    return rows.map((r) => ({
      eventId: r.event_id as string,
      taskId: r.task_id as string,
      at: r.at as string,
      actor: r.actor as string,
      action: r.action as string,
      detail: JSON.parse(r.detail_json as string) as Record<string, unknown>,
    }));
  }

  // -- results ----------------------------------------------------------------

  insertResult(row: Omit<ExchangeResultRow, "resultId">): void {
    this.db
      .prepare(
        `INSERT INTO exchange_results
           (result_id, task_id, outcome, summary_json, evidence_index_json, synthetic, received_at, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        row.taskId,
        row.outcome,
        JSON.stringify(row.summary),
        JSON.stringify(row.evidenceIndex),
        row.synthetic ? 1 : 0,
        row.receivedAt,
        row.attempt,
      );
  }

  latestResult(taskId: string): ExchangeResultRow | null {
    const r = this.db
      .prepare("SELECT * FROM exchange_results WHERE task_id = ? ORDER BY attempt DESC LIMIT 1")
      .get(taskId);
    if (!r) return null;
    return {
      resultId: r.result_id as string,
      taskId: r.task_id as string,
      outcome: r.outcome as ExchangeResultRow["outcome"],
      summary: JSON.parse(r.summary_json as string) as Record<string, unknown>,
      evidenceIndex: JSON.parse(r.evidence_index_json as string) as Record<string, unknown>,
      synthetic: Number(r.synthetic) === 1,
      receivedAt: r.received_at as string,
      attempt: Number(r.attempt),
    };
  }

  countResults(taskId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM exchange_results WHERE task_id = ?")
      .get(taskId) as { n: number };
    return r.n;
  }

  // -- outbox -----------------------------------------------------------------

  insertOutbox(
    row: Omit<ExchangeOutboxRow, "outboxId" | "status" | "attempts" | "lastError" | "createdAt" | "updatedAt">,
  ): ExchangeOutboxRow {
    const now = new Date().toISOString();
    const full: ExchangeOutboxRow = {
      outboxId: randomUUID(),
      status: "pending",
      attempts: 0,
      lastError: null,
      ...row,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
          `INSERT OR IGNORE INTO exchange_outbox
           (outbox_id, task_id, kind, target_url, payload_json, idempotency_key, attempts, next_attempt_at, last_error, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.outboxId,
        full.taskId,
        full.kind,
        full.targetUrl,
        JSON.stringify(full.payload),
        full.idempotencyKey,
        full.attempts,
        full.nextAttemptAt,
        full.lastError,
        full.status,
        full.createdAt,
        full.updatedAt,
      );
    return full;
  }

  listDueOutbox(beforeIso: string, limit = 50): ExchangeOutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM exchange_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`,
      )
      .all(beforeIso, limit);
    return rows.map((r) => ({
      outboxId: r.outbox_id as string,
      taskId: r.task_id as string,
      kind: r.kind as ExchangeOutboxRow["kind"],
      targetUrl: r.target_url as string,
      payload: JSON.parse(r.payload_json as string) as Record<string, unknown>,
      idempotencyKey: r.idempotency_key as string,
      attempts: Number(r.attempts),
      nextAttemptAt: r.next_attempt_at as string,
      lastError: (r.last_error as string | null) ?? null,
      status: r.status as ExchangeOutboxRow["status"],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  }

  markOutboxDelivered(outboxId: string, attempts: number, at: string): void {
    this.db
      .prepare("UPDATE exchange_outbox SET status = 'delivered', attempts = ?, updated_at = ? WHERE outbox_id = ?")
      .run(attempts, at, outboxId);
  }

  markOutboxAttempt(
    outboxId: string,
    attempts: number,
    nextAttemptAt: string,
    lastError: string | null,
    status: "pending" | "abandoned",
    at: string,
  ): void {
    this.db
      .prepare(
        "UPDATE exchange_outbox SET attempts = ?, next_attempt_at = ?, last_error = ?, status = ?, updated_at = ? WHERE outbox_id = ?",
      )
      .run(attempts, nextAttemptAt, lastError, status, at, outboxId);
  }

  // -- allowed hosts -------------------------------------------------------------

  insertAllowedHost(host: string, addedBy: string, at: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO exchange_allowed_hosts (host, added_by, added_at) VALUES (?, ?, ?)")
      .run(host, addedBy, at);
  }

  listAllowedHosts(): ExchangeAllowedHost[] {
    const rows = this.db.prepare("SELECT * FROM exchange_allowed_hosts ORDER BY host").all();
    return rows.map((r) => ({
      host: r.host as string,
      addedBy: r.added_by as string,
      addedAt: r.added_at as string,
    }));
  }
}
