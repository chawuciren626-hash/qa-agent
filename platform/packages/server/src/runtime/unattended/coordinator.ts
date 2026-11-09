/**
 * DefaultUnattendedCoordinator: the unattended boundary the scheduler consults for
 * BOUND tasks (tasks with an unattended_bindings row). Unbound tasks never reach this
 * class, so every previously verified scheduler behavior is preserved untouched.
 *
 * Guarantees implemented here:
 * - Idempotency: UNIQUE(task, slot) —a fire can only open one run, across ticks,
 *   restarts and concurrent triggers (`beginFire` fresh=false 鈫?the caller must not fire).
 * - Authorization gate before EVERY physical send (`authorizeFire`), fail-closed when
 *   the authorizer interface is missing (`authorizer_missing`). Binding-level facts
 *   (grant expiry, ceiling operation, deadline) are checked here, before policy.
 * - No escalation: an unattended session's approval mode comes ONLY from an explicit
 *   ceiling grant ("allow-all"); anything else keeps the preset default (the scheduler
 *   reads `ceiling` from authorizeFire's answer).
 * - Fencing: every transition CASes on status_version; cancel-vs-complete races resolve
 *   to exactly one winner, and the loser is RECORDED (lifecycle), never overwritten.
 * - Side-effect honesty: a crash between "sent" and "settled" leaves the run to be
 *   marked `unknown` (kept pending, never auto re-fired); a run that was never sent may
 *   be redispatched after restart, exactly once, via `sweep`'s callback.
 * - Lifecycle records for start/stop, clock-gap suspicion, blocked fires, and the two
 *   lost-race cases (executed-after-cancel, settled-after-cancel).
 */
import { Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Channels } from "../../hmr/capabilities.js";
import { userChannelKey } from "../../http/routes/events.js";
import type {
  UnattendedBindingStore,
  UnattendedLifecycleStore,
  UnattendedRunLedger,
} from "../../mechanisms/unattended.js";
import type { ScheduleServerEvent } from "../../api/types.js";
import type {
  AuthorizationDecision,
  PermissionCeiling,
  RunCanceller,
  RunOutcomeSource,
  UnattendedAuthorizer,
  UnattendedBindingRow,
  UnattendedCoordinator,
  UnattendedRedispatchRequest,
  UnattendedRunPatch,
  UnattendedRunRow,
  UnattendedRunStatus,
  UnattendedSweepArgs,
} from "./types.js";
import { UNATTENDED_TERMINAL_STATUSES } from "./types.js";

/** A queued run older than this, never dispatched, and not in its owner's in-flight set, is a restart orphan. */
export const REDISPATCH_AFTER_MS = 5 * 60_000;
/** A dispatched run unsettled for longer than this has an unknown outcome (crash between send and settle). */
export const UNKNOWN_AFTER_MS = 15 * 60_000;
/** The only operation v1 unattended tasks ask for. */
export const SCHEDULE_DISPATCH_OPERATION = "schedule.dispatch";

@Component()
export class DefaultUnattendedCoordinator implements UnattendedCoordinator {
  @Use() private readonly runs!: UnattendedRunLedger;
  @Use() private readonly bindings!: UnattendedBindingStore;
  @Use() private readonly lifecycle!: UnattendedLifecycleStore;
  @Use() private readonly authorizer?: UnattendedAuthorizer;
  @Use() private readonly outcomes?: RunOutcomeSource;
  @Use() private readonly canceller?: RunCanceller;
  @Use() private readonly channels?: Channels;

  private nowMs(): number {
    return Date.now();
  }

  // -- queries ------------------------------------------------------------

  async bindingFor(
    projectId: string,
    agentId: string,
    name: string,
  ): Promise<UnattendedBindingRow | null> {
    return this.bindings.find(projectId, agentId, name);
  }

  // -- fire flow ----------------------------------------------------------

  async beginFire(args: {
    projectId: string;
    agentId: string;
    name: string;
    slotMs: number;
  }): Promise<{ runId: string; fresh: boolean }> {
    const binding = this.bindings.find(args.projectId, args.agentId, args.name);
    if (!binding) throw new Error(`No unattended binding for task ${args.name}`);
    const { row, fresh } = this.runs.begin({
      projectId: args.projectId,
      agentId: args.agentId,
      name: args.name,
      slotMs: args.slotMs,
      ownerUserId: binding.ownerUserId,
      deviceId: binding.deviceId,
      grantId: binding.grantId,
      // No absolute deadline yet: a ceiling duration converts to one at dispatch time.
      deadlineMs: null,
    });
    return { runId: row.runId, fresh };
  }

  async authorizeFire(runId: string): Promise<{
    proceed: boolean;
    status: UnattendedRunStatus;
    reasonCode?: string;
    ceiling?: PermissionCeiling;
  }> {
    const run = this.runs.find(runId);
    if (!run) return { proceed: false, status: "blocked", reasonCode: "run_not_found" };
    if (UNATTENDED_TERMINAL_STATUSES.has(run.status)) {
      return { proceed: false, status: run.status, reasonCode: run.reasonCode ?? undefined };
    }
    const binding = this.bindings.find(run.projectId, run.agentId, run.name);
    if (!binding) {
      this.transitionOrRecord(run, { status: "blocked", reasonCode: "binding_removed" }, "fire_blocked");
      return { proceed: false, status: "blocked", reasonCode: "binding_removed" };
    }
    const nowMs = this.nowMs();
    if (binding.ownerUserId !== run.ownerUserId || binding.grantId !== run.grantId || binding.deviceId !== run.deviceId) {
      this.transitionOrRecord(run, { status: "blocked", reasonCode: "binding_changed" }, "fire_blocked");
      return {proceed:false, status:"blocked", reasonCode:"binding_changed"};
    }
    // Deadline first: a queued fire whose dispatch moment is already past its deadline is expired.
    if (run.deadlineMs !== null && nowMs > run.deadlineMs) {
      this.transitionOrRecord(run, { status: "expired", settledAt: new Date(nowMs).toISOString() }, "fire_expired");
      this.notify(run, "expired", "deadline_exceeded");
      return { proceed: false, status: "expired", reasonCode: "deadline_exceeded" };
    }
    // Binding-level fact: grant expiry (the revocation the local record can see).
    if (binding.grantExpiresAt !== null && (!Number.isFinite(Date.parse(binding.grantExpiresAt)) || nowMs >= Date.parse(binding.grantExpiresAt))) {
      this.transitionOrRecord(run, { status: "blocked", reasonCode: "grant_expired" }, "fire_blocked");
      this.notify(run, "blocked", "grant_expired");
      return { proceed: false, status: "blocked", reasonCode: "grant_expired" };
    }
    // Binding-level fact: the permission ceiling is a hard boundary.
    if (!binding.permissionCeiling.allowedOperations.includes(SCHEDULE_DISPATCH_OPERATION)) {
      this.transitionOrRecord(
        run,
        { status: "blocked", reasonCode: "operation_not_allowed" },
        "fire_blocked",
      );
      this.notify(run, "blocked", "operation_not_allowed");
      return { proceed: false, status: "blocked", reasonCode: "operation_not_allowed" };
    }
    // Fail closed: no authorizer interface wired 鈫?refuse (production requirement).
    if (!this.authorizer) {
      this.transitionOrRecord(run, { status: "blocked", reasonCode: "authorizer_missing" }, "fire_blocked");
      this.notify(run, "blocked", "authorizer_missing");
      return { proceed: false, status: "blocked", reasonCode: "authorizer_missing" };
    }
    const decision: AuthorizationDecision = await this.authorizer.authorizeInvocation(
      {
        tenantId: "local",
        userId: binding.ownerUserId,
        deviceId: binding.deviceId,
        projectId: run.projectId,
        agentId: run.agentId,
        taskId: run.name,
      },
      {
        kind: "schedule_fire",
        projectId: run.projectId,
        agentId: run.agentId,
        taskId: run.name,
        slotMs: run.slotMs,
      },
      {
        operation: SCHEDULE_DISPATCH_OPERATION,
        grantId: binding.grantId,
        permissionCeiling: binding.permissionCeiling,
        now: new Date(nowMs).toISOString(),
      },
    );
    if (decision.expiresAt !== null && (!Number.isFinite(Date.parse(decision.expiresAt)) || this.nowMs() >= Date.parse(decision.expiresAt))) {
      this.transitionOrRecord(run, { status: "blocked", reasonCode: "decision_expired" }, "fire_blocked");
      return { proceed: false, status: "blocked", reasonCode: "decision_expired" };
    }
    if (decision.outcome === "needs_approval") {
      // NO escalation: the run waits for a human; it never becomes a send.
      this.transitionOrRecord(
        run,
        {
          status: "needs_approval",
          reasonCode: decision.reasonCode,
          decisionId: decision.decisionId,
          policyRevision: decision.policyRevision,
          decisionExpiresAt: decision.expiresAt,
        },
        "fire_needs_approval",
      );
      this.notify(run, "needs_approval", decision.reasonCode);
      return { proceed: false, status: "needs_approval", reasonCode: decision.reasonCode };
    }
    if (!decision.allowed || decision.outcome === "deny") {
      this.transitionOrRecord(
        run,
        {
          status: "blocked",
          reasonCode: decision.reasonCode,
          decisionId: decision.decisionId,
          policyRevision: decision.policyRevision,
        },
        "fire_blocked",
      );
      this.notify(run, "blocked", decision.reasonCode);
      return { proceed: false, status: "blocked", reasonCode: decision.reasonCode };
    }
    const updated = this.runs.transition(run.runId, run.statusVersion, ["queued", "claimed"], {
      status: "claimed",
      reasonCode: decision.reasonCode,
      decisionId: decision.decisionId,
      policyRevision: decision.policyRevision,
    });
    if (!updated) {
      // Lost a race (cancel arrived mid-authorization): do not send.
      const current = this.runs.find(runId);
      return {
        proceed: false,
        status: current?.status ?? "blocked",
        reasonCode: current?.reasonCode ?? "status_moved",
      };
    }
    return { proceed: true, status: "claimed", ceiling: binding.permissionCeiling };
  }

  async noteDispatched(runId: string, sessionId: string): Promise<void> {
    const run = this.runs.find(runId);
    if (!run) return;
    // The run deadline ("ms from dispatch") becomes absolute the moment the send happens;
    // a ceiling without one leaves the run undelimited.
    const binding = this.bindings.find(run.projectId, run.agentId, run.name);
    const duration = binding?.permissionCeiling.defaultRunDeadlineMs;
    const updated = this.runs.transition(runId, run.statusVersion, ["queued", "claimed"], {
      status: "running",
      sessionId,
      dispatchedAt: new Date(this.nowMs()).toISOString(),
      ...(duration !== undefined ? { deadlineMs: this.nowMs() + duration } : {}),
    });
    if (!updated) {
      // The CAS lost —most plausibly a cancel landed between authorize and send. The send
      // DID happen (the side effect exists); record it, never flip the authoritative status.
      const current = this.runs.find(runId);
      if (current?.status === "cancelled") {
        this.lifecycle.insert(
          "fire_executed_after_cancel",
          { runId, sessionId, taskId: run.name, slotMs: run.slotMs },
          new Date(this.nowMs()).toISOString(),
        );
      }
    }
  }

  async noteSendFailed(runId: string, reasonCode: string): Promise<void> {
    const run = this.runs.find(runId);
    if (!run) return;
    // The slot was consumed but nothing was sent: no side effect exists, so terminal failed
    // is honest (unlike a dispatched run's unknown outcome).
    this.runs.transition(runId, run.statusVersion, ["queued", "claimed"], {
      status: "failed",
      reasonCode,
      settledAt: new Date(this.nowMs()).toISOString(),
    });
    this.notify(run, "failed", reasonCode);
  }

  async noteSettled(
    runId: string,
    outcome: "succeeded" | "failed",
    evidence?: Record<string, unknown>,
  ): Promise<{ applied: boolean }> {
    const run = this.runs.find(runId);
    if (!run) return { applied: false };
    const updated = this.runs.transition(
      runId,
      run.statusVersion,
      ["claimed", "running"],
      {
        status: outcome,
        settledAt: new Date(this.nowMs()).toISOString(),
        evidence: evidence ?? null,
      },
    );
    if (!updated) {
      const current = this.runs.find(runId);
      if (current?.status === "cancelled") {
        // The work completed after cancellation was requested: the authoritative status stays
        // cancelled (鍙栨秷鍚庝笉鑳戒吉鎶ュ畬鎴?, the physical outcome is recorded as evidence.
        this.runs.transition(runId, current.statusVersion, ["cancelled"], {
          evidence: { physicalOutcome: outcome, ...(evidence ?? {}) },
        });
        this.lifecycle.insert(
          "fire_settled_after_cancel",
          { runId, taskId: run.name, physicalOutcome: outcome },
          new Date(this.nowMs()).toISOString(),
        );
      }
      return { applied: false };
    }
    this.notify(run, outcome, undefined);
    return { applied: true };
  }

  // -- cancel -------------------------------------------------------------

  async cancelRun(
    runId: string,
    by: string,
  ): Promise<{ ok: boolean; status?: UnattendedRunStatus; reasonCode?: string }> {
    const run = this.runs.find(runId);
    if (!run) return { ok: false, reasonCode: "run_not_found" };
    if (UNATTENDED_TERMINAL_STATUSES.has(run.status)) {
      return { ok: false, status: run.status, reasonCode: "already_terminal" };
    }
    const updated = this.runs.transition(runId, run.statusVersion, ["queued", "claimed", "running", "needs_approval"], {
      status: "cancelled",
      cancelRequested: true,
      settledAt: new Date(this.nowMs()).toISOString(),
      reasonCode: `cancelled_by:${by}`,
    });
    if (!updated) {
      const current = this.runs.find(runId);
      return { ok: false, status: current?.status, reasonCode: "already_terminal" };
    }
    // Deliver the cancellation signal to the real executor when one exists and a canceller is wired.
    if (run.sessionId) {
      if (this.canceller) {
        try {
          const delivered = await this.canceller.cancel(run.sessionId);
          if (delivered) {
            this.runs.transition(runId, updated.statusVersion, ["cancelled"], {
              cancelSignalDelivered: true,
            });
          } else {
            this.lifecycle.insert(
              "cancel_signal_failed",
              { runId, sessionId: run.sessionId },
              new Date(this.nowMs()).toISOString(),
            );
          }
        } catch {
          this.lifecycle.insert(
            "cancel_signal_failed",
            { runId, sessionId: run.sessionId, error: true },
            new Date(this.nowMs()).toISOString(),
          );
        }
      } else {
        // No canceller wired: the status is cancelled server-side, the executor signal was NOT
        // delivered —recorded honestly rather than claimed.
        this.lifecycle.insert(
          "cancel_signal_failed",
          { runId, sessionId: run.sessionId, reason: "canceller_not_wired" },
          new Date(this.nowMs()).toISOString(),
        );
      }
    }
    this.notify(run, "cancelled", run.sessionId ? undefined : "not_dispatched");
    return { ok: true, status: "cancelled" };
  }

  // -- sweeps ---------------------------------------------------------------

  async sweep(args: UnattendedSweepArgs): Promise<void> {
    const nowIso = new Date(args.nowMs).toISOString();
    // 1. Lapsed approval decisions: waiting for a human past the decision window 鈫?blocked.
    for (const run of this.runs.listLapsedApprovals(nowIso)) {
      const updated = this.runs.transition(run.runId, run.statusVersion, ["needs_approval"], {
        status: "blocked",
        reasonCode: "approval_expired",
        settledAt: nowIso,
      });
      if (updated) this.notify(run, "blocked", "approval_expired");
    }
    // 2. Deadline expiry: open runs past their deadline 鈫?expired, cancel signal out.
    for (const run of this.runs.listPastDeadline(["claimed", "running", "needs_approval"], args.nowMs)) {
      const updated = this.runs.transition(run.runId, run.statusVersion, ["claimed", "running", "needs_approval"], {
        status: "expired",
        settledAt: nowIso,
        reasonCode: "deadline_exceeded",
      });
      if (updated) {
        if (run.sessionId && this.canceller) {
          try {
            const delivered = await this.canceller.cancel(run.sessionId);
            if (delivered) this.runs.transition(run.runId, updated.statusVersion, ["expired"], { cancelSignalDelivered: true });
          } catch {
            this.lifecycle.insert(
              "cancel_signal_failed",
              { runId: run.runId, sessionId: run.sessionId, reason: "deadline_expiry" },
              nowIso,
            );
          }
        }
        this.notify(run, "expired", "deadline_exceeded");
      }
    }
    // 3. Outcome polling for running runs (only when an outcome source is wired).
    if (this.outcomes) {
      for (const run of this.runs.listRunningWithSession()) {
        try {
          const outcome = await this.outcomes.observe(run.sessionId!, run.createdAt);
          if (outcome !== null) await this.noteSettled(run.runId, outcome);
        } catch {
          // Observer failure is not a run failure; the next sweep retries.
        }
      }
    }
    // 4. Side-effect-unknown marking: dispatched, unsettled, too old 鈫?unknown (kept pending).
    const unknownBefore = new Date(args.nowMs - UNKNOWN_AFTER_MS).toISOString();
    for (const run of this.runs.listStaleDispatched(["claimed", "running"], unknownBefore)) {
      if (args.inFlight.has(run.runId)) continue;
      const updated = this.runs.transition(run.runId, run.statusVersion, ["claimed", "running"], {
        status: "unknown",
        reasonCode: "outcome_unverified",
      });
      if (updated) this.notify(run, "unknown", "outcome_unverified");
    }
    // 5. Restart redispatch: queued, never dispatched (no side effect possible), older than
    //    the threshold, and NOT owned by this process's busy queue.
    const resumeBefore = new Date(args.nowMs - REDISPATCH_AFTER_MS).toISOString();
    for (const run of this.runs.listUndispatchedBefore(resumeBefore)) {
      if (args.inFlight.has(run.runId)) continue;
      const sent = await args.onRedispatch({ run });
      if (!sent) {
        // The task is gone or refused: terminal, so it stops being retried every tick.
        this.runs.transition(run.runId, run.statusVersion, ["queued"], {
          status: "failed",
          reasonCode: "redispatch_refused",
          settledAt: new Date(args.nowMs).toISOString(),
        });
      }
    }
  }

  // -- task removal / lifecycle -------------------------------------------//

  dropTask(projectId: string, agentId: string, name: string): void {
    this.bindings.delete(projectId, agentId, name);
  }

  recordLifecycle(kind: string, detail: Record<string, unknown> = {}): void {
    this.lifecycle.insert(kind, detail, new Date(this.nowMs()).toISOString());
  }

  // -- internals ----------------------------------------------------------//

  /** CAS transition that also records a lifecycle entry when it applies (best-effort audit). */
  private transitionOrRecord(
    run: UnattendedRunRow,
    patch: UnattendedRunPatch,
    lifecycleKind: string,
  ): void {
    const updated = this.runs.transition(run.runId, run.statusVersion, [
      "queued",
      "claimed",
      "running",
      "needs_approval",
    ], patch);
    if (updated) this.lifecycle.insert(lifecycleKind, { runId: run.runId, taskId: run.name, reasonCode: patch.reasonCode ?? null }, new Date(this.nowMs()).toISOString());
  }

  /** Publish a schedule_unattended event to the run owner's channel (silent without channels). */
  private notify(
    run: UnattendedRunRow,
    status: Extract<
      ScheduleServerEvent,
      { type: "schedule_unattended" }
    >["status"],
    reasonCode?: string,
  ): void {
    if (!this.channels) return;
    const event: ScheduleServerEvent = {
      type: "schedule_unattended",
      projectId: run.projectId,
      agentId: run.agentId,
      name: run.name,
      runId: run.runId,
      status,
      ...(reasonCode !== undefined ? { reasonCode } : {}),
    };
    try {
      this.channels.get(userChannelKey(run.ownerUserId)).publish(event, "server_event");
    } catch {
      // No live channel for this user: nothing to deliver to.
    }
  }
}
