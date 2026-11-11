/**
 * ExchangeService: the task-exchange state machine and its guarantees.
 *
 * - Creation idempotency: UNIQUE(tenant, platform, idempotency_key) — the same key returns
 *   the SAME task (`idempotent: true`), never a second one; a repeated external_id with a
 *   DIFFERENT key is a 409 (the platform retried without its key).
 * - Device binding is verified against the registry at creation; the task never re-binds.
 * - Claims are leases: epoch fencing + expiry. A stale epoch is refused (`lease_expired`);
 *   a lapsed RUNNING lease re-claims with `previous_outcome_unknown` and an audit event —
 *   a crash between execution and report is NEVER treated as "safe to redo".
 * - Cancel: bumps cancel_version; a queued task cancels at once, an in-flight one waits
 *   for the executor's ack; cancel-vs-complete resolves by CAS on status_version, and the
 *   loser is recorded, never overwritten.
 * - Deadlines sweep to `expired`; device liveness is reported as a queued_reason at read
 *   time (device_offline), not guessed into the state.
 * - Results are at-least-once (one row per received attempt, latest wins) and only ever
 *   carry the fields the task's allowed_data_fields authorizes.
 * - Terminal statuses enqueue ONE outbox row whose idempotency key is the DELIVERY's
 *   (`callback:<taskId>:terminal`), so callback retries re-send, never re-execute.
 */
import { randomUUID } from "node:crypto";
import { Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Projects } from "../mechanisms/projects.js";
import type { Db } from "../hmr/capabilities.js";
import type { ExchangeTasks, TaskExchangeStore } from "../mechanisms/taskexchange.js";
import type {
  ExchangeDeviceRow,
  ExchangeTaskRow,
  ExchangeTaskStatus,
} from "./types.js";
import { ExchangeError, newExchangeId } from "./types.js";
import { checkCallbackUrl } from './ssrf.js';

/** A lease lapses after this long without the executor touching the task. */
export const LEASE_MS = 60_000;
/** A device unseen for this long reports as device_offline at read time. */
export const DEVICE_OFFLINE_AFTER_MS = 5 * 60_000;
/** Delivery backoff: 30s doubling, capped; abandoned after this many attempts. */
export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_BASE_BACKOFF_MS = 30_000;
export const OUTBOX_MAX_BACKOFF_MS = 60 * 60_000;

export interface CreateTaskArgs {
  tenantId: string;
  platformId: string;
  body: {
    externalId: string;
    idempotencyKey: string;
    deviceId: string;
    projectRef: string;
    objective: string;
    allowedDataFields: string[];
    deadlineMs: number | null;
    publishSnapshot: Record<string, unknown>;
  };
  userId: string;
  nowMs: number;
}

@Component()
export class ExchangeService implements ExchangeTasks {
  @Use() private readonly store!: TaskExchangeStore;
  @Use() private readonly projects!: Projects;
  @Use() private readonly db!: Db;

  private nowIso(nowMs?: number): string {
    return new Date(nowMs ?? Date.now()).toISOString();
  }

  private event(taskId: string, actor: string, action: string, detail: Record<string, unknown>, at: string): void {
    this.store.insertEvent({ taskId, at, actor, action, detail });
  }

  // -- creation -------------------------------------------------------------

  createTask(args: CreateTaskArgs): { task: ExchangeTaskRow; idempotent: boolean } {
    const existing = this.store.findTaskByIdempotencyKey(
      args.tenantId,
      args.platformId,
      args.body.idempotencyKey,
    );
    if (existing) {
      // The same key: the platform is retrying — the SAME task answers, whatever it carries.
      return { task: existing, idempotent: true };
    }
    const byExternal = this.store.findTaskByExternalId(args.tenantId, args.platformId, args.body.externalId);
    if (byExternal) {
      throw new ExchangeError(
        409,
        "external_id_conflict",
        `external_id already exists under a different idempotency key: ${byExternal.taskId}`,
      );
    }
    const device = this.store.findDevice(args.tenantId, args.body.deviceId);
    if (!device || device.revokedAt !== null) {
      throw new ExchangeError(422, "unknown_device", `No active device: ${args.body.deviceId}`);
    }
    if (device.platformId !== args.platformId) {
      // Cross-platform binding is refused: a task is delivered only through its own platform.
      throw new ExchangeError(422, "device_platform_mismatch", "The device is not registered on this platform.");
    }
    if (device.userId !== args.userId) {
      throw new ExchangeError(422, "device_user_mismatch", "The device belongs to another user.");
    }
    // The project reference is verified server-side — the caller's claim of ownership counts
    // for nothing (CONTRACTS.md: 归属需服务端核实).
    const project = this.projects.findById(args.body.projectRef);
    if (!project || project.ownerUserId !== args.userId) {
      throw new ExchangeError(422, "unresolvable_project_ref", `No project for this user: ${args.body.projectRef}`);
    }
    const state = this.db.prepare("SELECT status FROM project_management WHERE project_id=?").get(args.body.projectRef) as { status?: string } | undefined;
    if (state && state.status !== "active") throw new ExchangeError(409, "project_inactive", "Project is archived or disabled.");
    if (args.body.deadlineMs !== null && args.body.deadlineMs <= args.nowMs) {
      throw new ExchangeError(422, "deadline_in_past", "deadlineMs is already past: the task could never run.");
    }
    const row = this.store.insertTask({
      taskId: newExchangeId("ext"),
      tenantId: args.tenantId,
      platformId: args.platformId,
      externalId: args.body.externalId,
      idempotencyKey: args.body.idempotencyKey,
      userId: args.userId,
      deviceId: args.body.deviceId,
      projectRef: args.body.projectRef,
      objective: args.body.objective,
      allowedDataFields: args.body.allowedDataFields,
      deadlineMs: args.body.deadlineMs,
      publishSnapshot: args.body.publishSnapshot,
    });
    const at = this.nowIso(args.nowMs);
    this.event(row.taskId, `platform:${args.platformId}`, "created", { externalId: args.body.externalId, device: args.body.deviceId }, at);
    return { task: row, idempotent: false };
  }

  // -- platform reads -------------------------------------------------------

  taskForPlatform(tenantId: string, platformId: string, taskId: string, nowMs: number): ExchangeTaskRow {
    const task = this.store.findTask(tenantId, taskId);
    if (!task || task.platformId !== platformId) {
      throw new ExchangeError(404, "task_not_found", `No task: ${taskId}`);
    }
    return this.withLiveness(task, nowMs);
  }

  listForPlatform(tenantId: string, platformId: string, nowMs: number): ExchangeTaskRow[] {
    return this.store
      .listTasksForPlatform(tenantId, platformId)
      .map((task) => this.withLiveness(task, nowMs));
  }

  /** A queued task whose bound device has been silent past the window reports WHY at read time. */
  private withLiveness(task: ExchangeTaskRow, nowMs: number): ExchangeTaskRow {
    if (task.status !== "queued") return task;
    const device = this.store.findDevice(task.tenantId, task.deviceId);
    if (!device || device.revokedAt !== null) {
      return { ...task, queuedReason: "bound_device_revoked" };
    }
    const seen = device.lastSeenAt === null ? null : Date.parse(device.lastSeenAt);
    if (seen === null || nowMs - seen > DEVICE_OFFLINE_AFTER_MS) {
      return { ...task, queuedReason: "device_offline" };
    }
    return task;
  }

  // -- cancel -----------------------------------------------------------------

  cancelTask(tenantId: string, platformId: string, taskId: string, nowMs: number): ExchangeTaskRow {
    const task = this.store.findTask(tenantId, taskId);
    if (!task || task.platformId !== platformId) {
      throw new ExchangeError(404, "task_not_found", `No task: ${taskId}`);
    }
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled" || task.status === "expired") {
      throw new ExchangeError(409, "already_terminal", `Task is already ${task.status}.`);
    }
    if (task.status === "queued") {
      const updated = this.store.transitionTask(task.taskId, task.statusVersion, ["queued"], {
        status: "cancelled",
        cancelRequested: true,
        cancelVersion: task.cancelVersion + 1,
        queuedReason: null,
      });
      if (updated !== null) {
        const at = this.nowIso(nowMs);
        this.event(task.taskId, `platform:${platformId}`, "cancelled_queued", {}, at);
        this.enqueueTerminalDelivery(updated, at);
        return updated;
      }
      // Lost the race (claimed mid-cancel): fall through to the in-flight path.
      const current = this.store.findTask(tenantId, taskId)!;
      return this.cancelInFlight(current, platformId, nowMs);
    }
    return this.cancelInFlight(task, platformId, nowMs);
  }

  /** In-flight cancel: record the request; the executor's ack (or the expiry sweep) settles it. */
  private cancelInFlight(task: ExchangeTaskRow, platformId: string, nowMs: number): ExchangeTaskRow {
    const updated = this.store.transitionTask(
      task.taskId,
      task.statusVersion,
      ["claimed", "running"],
      {
        cancelRequested: true,
        cancelVersion: task.cancelVersion + 1,
      },
    );
    if (updated === null) {
      const current = this.store.findTask(task.tenantId, task.taskId)!;
      if (current.status === "succeeded" || current.status === "failed" || current.status === "cancelled" || current.status === "expired") {
        throw new ExchangeError(409, "already_terminal", `Task is already ${current.status}.`);
      }
      throw new ExchangeError(409, "version_conflict", "The task moved during cancellation; retry.");
    }
    this.event(task.taskId, `platform:${platformId}`, "cancel_requested", { cancelVersion: updated.cancelVersion }, this.nowIso(nowMs));
    return updated;
  }

  /** The executor acknowledges a cancel request: cancel_requested + its version, one CAS. */
  acknowledgeCancel(
    caller: { tenantId: string; deviceId: string },
    taskId: string,
    input: { leaseEpoch: number; ackCancelVersion: number },
    nowMs: number,
  ): ExchangeTaskRow {
    const task = this.store.findTask(caller.tenantId, taskId);
    this.assertWritableByDevice(task, caller.deviceId, input.leaseEpoch, nowMs);
    const row = task!;
    if (!row.cancelRequested || row.cancelVersion !== input.ackCancelVersion) {
      throw new ExchangeError(409, "cancel_version_mismatch", "The cancel request this ack cites is not current.");
    }
    const updated = this.store.transitionTask(row.taskId, row.statusVersion, ["claimed", "running"], {
      status: "cancelled",
    });
    if (updated === null) {
      const current = this.store.findTask(caller.tenantId, taskId)!;
      // Lost the race: the run COMPLETED before the ack landed. The authoritative status
      // stands; the acknowledgment is recorded, never a fake cancel.
      this.event(taskId, `device:${caller.deviceId}`, "cancel_ack_lost", { finalStatus: current.status }, this.nowIso(nowMs));
      throw new ExchangeError(409, "already_settled", `Task settled as ${current.status} before the cancel ack.`);
    }
    const at = this.nowIso(nowMs);
    this.event(taskId, `device:${caller.deviceId}`, "cancelled_by_ack", {}, at);
    this.enqueueTerminalDelivery(updated, at);
    return updated;
  }

  // -- claim (device lease) ----------------------------------------------------

  claimNext(
    caller: { tenantId: string; deviceId: string },
    nowMs: number,
  ): { task: ExchangeTaskRow; lease: { epoch: number; expiresAt: string }; previousOutcomeUnknown: boolean } | null {
    this.sweepExpired(nowMs);
    const nowIso = this.nowIso(nowMs);
    this.store.touchDevice(caller.deviceId, nowIso);
    // A queued task bound to this device, oldest first.
    const queued = this.store.listQueuedForDevice(caller.deviceId).find(
      (t) => t.tenantId === caller.tenantId,
    );
    if (queued) {
      const claimed = this.store.transitionTask(queued.taskId, queued.statusVersion, ["queued"], {
        status: "claimed",
        claimedBy: caller.deviceId,
        leaseEpoch: queued.leaseEpoch + 1,
        leaseExpiresAt: new Date(nowMs + LEASE_MS).toISOString(),
        queuedReason: null,
      });
      if (claimed === null) return null; // moved mid-claim; the next claim pass takes it.
      this.event(queued.taskId, `device:${caller.deviceId}`, "claimed", { leaseEpoch: claimed.leaseEpoch }, nowIso);
      return {
        task: claimed,
        lease: { epoch: claimed.leaseEpoch, expiresAt: claimed.leaseExpiresAt! },
        previousOutcomeUnknown: false,
      };
    }
    // No queued task: re-claim a lapsed lease ONLY when the outcome is unknown — and say so.
    const lapsed = this.store.listReclaimable(nowIso).find(
      (t) => t.tenantId === caller.tenantId && t.deviceId === caller.deviceId,
    );
    if (!lapsed) return null;
    const outcomeUnknown = true; // the previous holder may have started (or finished) work
    const reclaimed = this.store.transitionTask(lapsed.taskId, lapsed.statusVersion, ["claimed", "running"], {
      status: "claimed",
      claimedBy: caller.deviceId,
      leaseEpoch: lapsed.leaseEpoch + 1,
      leaseExpiresAt: new Date(nowMs + LEASE_MS).toISOString(),
    });
    if (reclaimed === null) return null;
    this.event(
      lapsed.taskId,
      `device:${caller.deviceId}`,
      "lease_reclaimed_outcome_unknown",
      { previousEpoch: lapsed.leaseEpoch },
      nowIso,
    );
    return {
      task: reclaimed,
      lease: { epoch: reclaimed.leaseEpoch, expiresAt: reclaimed.leaseExpiresAt! },
      previousOutcomeUnknown: outcomeUnknown,
    };
  }

  // -- device status / result ---------------------------------------------------

  heartbeat(caller: { tenantId: string; deviceId: string }, taskId: string, leaseEpoch: number, nowMs: number): ExchangeTaskRow {
    this.sweepExpired(nowMs);
    const task = this.store.findTask(caller.tenantId, taskId);
    // A late heartbeat may renew only its unchanged epoch; it never starts execution.
    this.assertLeaseHolder(task, caller.deviceId, leaseEpoch, Number.NEGATIVE_INFINITY);
    this.store.touchDevice(caller.deviceId, this.nowIso(nowMs));
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(task!.status)) return task!;
    const updated = this.store.transitionTask(taskId, task!.statusVersion, ['claimed', 'running'], {
      leaseExpiresAt: this.nowIso(nowMs + LEASE_MS),
    });
    if (!updated) throw new ExchangeError(409, 'version_conflict', 'The task changed during renewal.');
    return updated;
  }

  updateStatus(
    caller: { tenantId: string; deviceId: string },
    taskId: string,
    input: { leaseEpoch: number; status: "running" } | { leaseEpoch: number; ackCancelVersion: number },
    nowMs: number,
  ): ExchangeTaskRow {
    if ("ackCancelVersion" in input) return this.acknowledgeCancel(caller, taskId, input, nowMs);
    const task = this.store.findTask(caller.tenantId, taskId);
    this.assertWritableByDevice(task, caller.deviceId, input.leaseEpoch, nowMs);
    const row = task!;
    if (row.status !== "claimed") {
      throw new ExchangeError(409, "invalid_transition", `Cannot mark ${row.status} as running.`);
    }
    const updated = this.store.transitionTask(row.taskId, row.statusVersion, ["claimed"], {
      status: "running",
    });
    if (updated === null) throw new ExchangeError(409, "version_conflict", "The task moved; re-read it.");
    this.store.touchDevice(caller.deviceId, this.nowIso(nowMs));
    this.event(taskId, `device:${caller.deviceId}`, "running", {}, this.nowIso(nowMs));
    return updated;
  }

  submitResult(
    caller: { tenantId: string; deviceId: string },
    taskId: string,
    input: {
      leaseEpoch: number;
      outcome: "succeeded" | "failed";
      summary: Record<string, unknown>;
      evidenceIndex: Record<string, unknown>;
      extraFields?: Record<string, unknown>;
      synthetic: boolean;
      sanitizedError?: string;
    },
    nowMs: number,
  ): { task: ExchangeTaskRow; applied: boolean } {
    const task = this.store.findTask(caller.tenantId, taskId);
    // A result from a valid lease holder is RECORDED even when the task already settled
    // elsewhere (cancel won, or the deadline sweep fired): at-least-once delivery means the
    // row lands, the authoritative status stands, and the race is audited. The status-flip
    // guard below is a CAS, so the loser never overwrites the winner.
    this.assertLeaseHolder(task, caller.deviceId, input.leaseEpoch, nowMs);
    const row = task!;
    // Data-field authorization: anything outside the task's allowed set is REFUSED, and the
    // refusal is audited — the payload never lands, authorized or not.
    const extras = input.extraFields ?? {};
    const unauthorized = Object.keys(extras).filter((f) => !row.allowedDataFields.includes(f));
    if (unauthorized.length > 0) {
      const at = this.nowIso(nowMs);
      this.event(taskId, `device:${caller.deviceId}`, "result_fields_refused", { fields: unauthorized }, at);
      throw new ExchangeError(
        403,
        "unauthorized_data_fields",
        `The task does not authorize these fields: ${unauthorized.join(", ")}`,
      );
    }
    const attempt = this.store.countResults(taskId) + 1;
    this.store.insertResult({
      taskId,
      outcome: input.outcome,
      summary: row.allowedDataFields.includes('summary') ? input.summary : {},
      evidenceIndex: row.allowedDataFields.includes('evidence_index') ? input.evidenceIndex : {},
      synthetic: input.synthetic,
      receivedAt: this.nowIso(nowMs),
      attempt,
    });
    const updated = this.store.transitionTask(row.taskId, row.statusVersion, ["claimed", "running"], {
      status: input.outcome,
    });
    if (updated === null) {
      const current = this.store.findTask(caller.tenantId, taskId)!;
      // The result arrived after a cancel (or expiry) won: the row is kept (at-least-once),
      // the authoritative status stands, and the race is recorded.
      this.event(taskId, `device:${caller.deviceId}`, "result_arrived_after_settle", { finalStatus: current.status, attempt }, this.nowIso(nowMs));
      return { task: current, applied: false };
    }
    const at = this.nowIso(nowMs);
    this.event(taskId, `device:${caller.deviceId}`, input.outcome, { attempt, synthetic: input.synthetic }, at);
    this.enqueueTerminalDelivery(updated, at);
    this.store.touchDevice(caller.deviceId, at);
    return { task: updated, applied: true };
  }

  // -- expiry sweep ----------------------------------------------------------

  sweepExpired(nowMs: number): number {
    const at = this.nowIso(nowMs);
    let n = 0;
    for (const task of this.store.listPastDeadline(nowMs)) {
      const updated = this.store.transitionTask(
        task.taskId,
        task.statusVersion,
        ["queued", "claimed", "running"],
        { status: "expired", queuedReason: null },
      );
      if (updated !== null) {
        n += 1;
        this.event(task.taskId, "server", "expired", { deadlineMs: task.deadlineMs }, at);
        this.enqueueTerminalDelivery(updated, at);
      }
    }
    return n;
  }

  // -- callbacks ----------------------------------------------------------------

  setCallbackUrl(
    tenantId: string,
    platformId: string,
    taskId: string,
    url: string,
    guard: { allowedHosts: ReadonlySet<string> },
    nowMs: number,
  ): ExchangeTaskRow {
    const verdict = checkCallbackUrl(url, guard);
    if (!verdict.ok) throw new ExchangeError(403, verdict.reason, 'Callback target refused.');
    const task = this.store.findTask(tenantId, taskId);
    if (!task || task.platformId !== platformId) {
      throw new ExchangeError(404, "task_not_found", `No task: ${taskId}`);
    }
    const updated = this.store.transitionTask(task.taskId, task.statusVersion, [...["queued", "claimed", "running", "succeeded", "failed", "cancelled", "expired"]], {
      callbackUrl: url,
    });
    if (updated === null) throw new ExchangeError(409, "version_conflict", "The task moved; retry.");
    this.event(taskId, `platform:${platformId}`, "callback_configured", {}, this.nowIso(nowMs));
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(updated.status)) this.enqueueTerminalDelivery(updated, this.nowIso(nowMs));
    return updated;
  }

  /**
   * One outbox row per terminal settle, keyed by the DELIVERY (not the execution): retries
   * re-send this row, they never re-run the task. Any terminal status change can only be
   * reached once (transitions out of terminal statuses do not exist), so the unique key
   * holds.
   */
  enqueueTerminalDelivery(task: ExchangeTaskRow, at: string): void {
    if (task.callbackUrl === null) return;
    const result = this.store.latestResult(task.taskId);
    this.store.insertOutbox({
      taskId: task.taskId,
      kind: "callback",
      targetUrl: task.callbackUrl,
      payload: {
        taskId: task.taskId,
        externalId: task.externalId,
        status: task.status,
        ...(result ? { summary: result.summary, evidenceIndex: result.evidenceIndex, synthetic: result.synthetic } : {}),
        // The callback payload is the DEFAULT set only: status + summary + evidence index +
        // sanitized error. Explicitly authorized extras go through result delivery, not here.
      },
      idempotencyKey: `callback:${task.taskId}:terminal`,
      nextAttemptAt: at,
    });
  }

  // -- internal ----------------------------------------------------------------

  private assertWritableByDevice(
    task: ExchangeTaskRow | null,
    deviceId: string,
    leaseEpoch: number,
    nowMs: number,
  ): void {
    if (!task) throw new ExchangeError(404, "task_not_found", "No such task.");
    if (task.deviceId !== deviceId || task.claimedBy !== deviceId) {
      throw new ExchangeError(403, "not_task_holder", "The task is bound to another device.");
    }
    if (task.leaseEpoch !== leaseEpoch) {
      // A stale executor (its lease was superseded) cannot write — the fencing token decides.
      throw new ExchangeError(409, "lease_expired", "The lease epoch is stale; re-claim if the task is still yours.");
    }
    if (task.leaseExpiresAt !== null && Date.parse(task.leaseExpiresAt) <= nowMs) {
      throw new ExchangeError(409, "lease_expired", "The lease has lapsed; re-claim if the task is still yours.");
    }
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled" || task.status === "expired") {
      throw new ExchangeError(409, "already_terminal", `Task is already ${task.status}.`);
    }
  }

  /** The result-submission variant: a valid lease holder may RECORD a result into a task that
   *  settled elsewhere — the CAS decides whether it also flips the status. */
  private assertLeaseHolder(
    task: ExchangeTaskRow | null,
    deviceId: string,
    leaseEpoch: number,
    nowMs: number,
  ): void {
    if (!task) throw new ExchangeError(404, "task_not_found", "No such task.");
    if (task.deviceId !== deviceId || task.claimedBy !== deviceId) {
      throw new ExchangeError(403, "not_task_holder", "The task is bound to another device.");
    }
    if (task.leaseEpoch !== leaseEpoch) {
      throw new ExchangeError(409, "lease_expired", "The lease epoch is stale; re-claim if the task is still yours.");
    }
    if (task.leaseExpiresAt !== null && Date.parse(task.leaseExpiresAt) <= nowMs) {
      throw new ExchangeError(409, "lease_expired", "The lease has lapsed; re-claim if the task is still yours.");
    }
  }
}
