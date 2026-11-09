/**
 * Repo for the unattended per-fire run ledger: one row per scheduled slot, the
 * UNIQUE(task, slot) being the idempotency key that makes double fires impossible
 * across ticks, restarts and concurrent triggers. Every transition is a CAS on
 * `status_version` (the fencing counter), so cancel-vs-complete races resolve to
 * exactly one winner and the loser is recorded, never guessed.
 *
 * Status lifecycle (see runtime/unattended/types.ts and deliveries state-machine.md):
 *   queued --authorize ok--> claimed --send--> running --settle--> succeeded | failed
 *   queued --deny--> blocked (terminal)
 *   queued --needs_approval--> needs_approval --decision expiry--> blocked
 *   claimed/running --deadline--> expired --cancel signal--> executor
 *   claimed/running --cancel--> cancelled (CAS decides vs settle; the loser is recorded)
 *   running --stale dispatched, no outcome--> unknown (kept pending; NEVER auto re-fired)
 */
import { randomUUID } from "node:crypto";
import { Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Db } from "../../hmr/capabilities.js";
import type { UnattendedRunLedger } from "../../mechanisms/unattended.js";
import type {
  UnattendedRunPatch,
  UnattendedRunRow,
  UnattendedRunStatus,
} from "../../runtime/unattended/types.js";

function mapRow(r: Record<string, unknown>): UnattendedRunRow {
  return {
    runId: r.run_id as string,
    projectId: r.project_id as string,
    agentId: r.agent_id as string,
    name: r.name as string,
    slotMs: Number(r.slot_ms),
    ownerUserId: r.owner_user_id as string,
    deviceId: r.device_id as string,
    grantId: (r.grant_id as string | null) ?? null,
    status: r.status as UnattendedRunStatus,
    statusVersion: Number(r.status_version),
    sessionId: (r.session_id as string | null) ?? null,
    reasonCode: (r.reason_code as string | null) ?? null,
    decisionId: (r.decision_id as string | null) ?? null,
    policyRevision: (r.policy_revision as string | null) ?? null,
    decisionExpiresAt: (r.decision_expires_at as string | null) ?? null,
    deadlineMs: r.deadline_ms === null || r.deadline_ms === undefined ? null : Number(r.deadline_ms),
    cancelRequested: Number(r.cancel_requested) === 1,
    cancelSignalDelivered: Number(r.cancel_signal_delivered) === 1,
    dispatchedAt: (r.dispatched_at as string | null) ?? null,
    settledAt: (r.settled_at as string | null) ?? null,
    evidence: r.evidence_json === null || r.evidence_json === undefined ? null : JSON.parse(r.evidence_json as string),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

@Component()
export class UnattendedRunsRepo implements UnattendedRunLedger {
  @Use() private readonly db!: Db;

  /**
   * Idempotent insert: returns the row plus `fresh` (true when THIS call created it).
   * A second fire of the same slot returns the existing row with fresh=false.
   */
  begin(args: {
    projectId: string;
    agentId: string;
    name: string;
    slotMs: number;
    ownerUserId: string;
    deviceId: string;
    grantId: string | null;
    deadlineMs: number | null;
  }): { row: UnattendedRunRow; fresh: boolean } {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO unattended_runs
           (run_id, project_id, agent_id, name, slot_ms, owner_user_id, device_id, grant_id,
            status, status_version, deadline_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        args.projectId,
        args.agentId,
        args.name,
        args.slotMs,
        args.ownerUserId,
        args.deviceId,
        args.grantId,
        args.deadlineMs,
        now,
        now,
      );
    const existing = this.byKey(args.projectId, args.agentId, args.name, args.slotMs);
    if (!existing) throw new Error("Failed to read back unattended_runs after begin");
    const fresh = existing.createdAt === now;
    return { row: existing, fresh };
  }

  find(runId: string): UnattendedRunRow | null {
    const r = this.db.prepare("SELECT * FROM unattended_runs WHERE run_id = ?").get(runId);
    return r ? mapRow(r as Record<string, unknown>) : null;
  }

  byKey(
    projectId: string,
    agentId: string,
    name: string,
    slotMs: number,
  ): UnattendedRunRow | null {
    const r = this.db
      .prepare(
        "SELECT * FROM unattended_runs WHERE project_id = ? AND agent_id = ? AND name = ? AND slot_ms = ?",
      )
      .get(projectId, agentId, name, slotMs);
    return r ? mapRow(r as Record<string, unknown>) : null;
  }

  /** Fencing transition: applies `patch` only when the row is still at `fromVersion` AND
   *  still in one of `fromStatuses`. Returns the updated row, or null when the row moved
   *  (the caller lost the race and must record, not overwrite). */
  transition(
    runId: string,
    fromVersion: number,
    fromStatuses: readonly string[],
    patch: UnattendedRunPatch,
  ): UnattendedRunRow | null {
    const sets: string[] = ["status_version = status_version + 1", "updated_at = ?"];
    const vals: (string | number | null)[] = [new Date().toISOString()];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      vals.push(patch.status);
    }
    if (patch.sessionId !== undefined) {
      sets.push("session_id = ?");
      vals.push(patch.sessionId);
    }
    if (patch.reasonCode !== undefined) {
      sets.push("reason_code = ?");
      vals.push(patch.reasonCode);
    }
    if (patch.decisionId !== undefined) {
      sets.push("decision_id = ?");
      vals.push(patch.decisionId);
    }
    if (patch.policyRevision !== undefined) {
      sets.push("policy_revision = ?");
      vals.push(patch.policyRevision);
    }
    if (patch.decisionExpiresAt !== undefined) {
      sets.push("decision_expires_at = ?");
      vals.push(patch.decisionExpiresAt);
    }
    if (patch.cancelRequested !== undefined) {
      sets.push("cancel_requested = ?");
      vals.push(patch.cancelRequested ? 1 : 0);
    }
    if (patch.cancelSignalDelivered !== undefined) {
      sets.push("cancel_signal_delivered = ?");
      vals.push(patch.cancelSignalDelivered ? 1 : 0);
    }
    if (patch.dispatchedAt !== undefined) {
      sets.push("dispatched_at = ?");
      vals.push(patch.dispatchedAt);
    }
    if (patch.settledAt !== undefined) {
      sets.push("settled_at = ?");
      vals.push(patch.settledAt);
    }
    if (patch.deadlineMs !== undefined) {
      sets.push("deadline_ms = ?");
      vals.push(patch.deadlineMs);
    }
    if (patch.evidence !== undefined) {
      sets.push("evidence_json = ?");
      vals.push(patch.evidence === null ? null : JSON.stringify(patch.evidence));
    }
    vals.push(runId, fromVersion);
    const res = this.db
      .prepare(
        `UPDATE unattended_runs SET ${sets.join(", ")}
         WHERE run_id = ? AND status_version = ? AND status IN (${fromStatuses.map(() => "?").join(", ")})`,
      )
      .run(...vals, ...fromStatuses);
    if (res.changes === 0) return null;
    return this.find(runId);
  }

  /** Open runs (queued, never dispatched) for restart redispatch, oldest first. */
  listUndispatchedBefore(beforeIso: string): UnattendedRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unattended_runs
         WHERE status = 'queued' AND dispatched_at IS NULL AND created_at < ?
         ORDER BY created_at`,
      )
      .all(beforeIso);
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  /** Dispatched runs still open past `beforeIso` —the side-effect-unknown candidates. */
  listStaleDispatched(statuses: readonly string[], beforeIso: string): UnattendedRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unattended_runs
         WHERE settled_at IS NULL AND ((dispatched_at IS NOT NULL AND dispatched_at < ?)
           OR (status = 'claimed' AND dispatched_at IS NULL AND updated_at < ?))
           AND status IN (${statuses.map(() => "?").join(", ")})
         ORDER BY dispatched_at`,
      )
      .all(beforeIso, beforeIso, ...statuses);
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  /** Open runs whose deadline has passed (deadline expiry sweep). */
  listPastDeadline(statuses: readonly string[], nowMs: number): UnattendedRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unattended_runs
         WHERE deadline_ms IS NOT NULL AND deadline_ms < ? AND settled_at IS NULL
           AND status IN (${statuses.map(() => "?").join(", ")})
         ORDER BY deadline_ms`,
      )
      .all(nowMs, ...statuses);
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  /** Open needs_approval runs whose decision window has lapsed. */
  listLapsedApprovals(beforeIso: string): UnattendedRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unattended_runs
         WHERE status = 'needs_approval' AND decision_expires_at IS NOT NULL AND decision_expires_at < ?
         ORDER BY decision_expires_at`,
      )
      .all(beforeIso);
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  /** Running runs with a session (outcome polling candidates). */
  listRunningWithSession(): UnattendedRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unattended_runs
         WHERE status = 'running' AND session_id IS NOT NULL AND settled_at IS NULL
         ORDER BY dispatched_at`,
      )
      .all();
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  /** Listing for routes: newest first, optional status filter. */
  listByTask(projectId: string, agentId: string, name: string, limit = 100): UnattendedRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unattended_runs
         WHERE project_id = ? AND agent_id = ? AND name = ?
         ORDER BY created_at DESC, slot_ms DESC LIMIT ?`,
      )
      .all(projectId, agentId, name, limit);
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  listByProject(projectId: string, status: string | null, limit = 200): UnattendedRunRow[] {
    const rows = status
      ? this.db
          .prepare(
            `SELECT * FROM unattended_runs WHERE project_id = ? AND status = ?
             ORDER BY created_at DESC, slot_ms DESC LIMIT ?`,
          )
          .all(projectId, status, limit)
      : this.db
          .prepare(
            `SELECT * FROM unattended_runs WHERE project_id = ?
             ORDER BY created_at DESC, slot_ms DESC LIMIT ?`,
          )
          .all(projectId, limit);
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  findRun(runId: string): UnattendedRunRow | null {
    return this.find(runId);
  }
}
