/**
 * Unattended scheduling contracts (batch 4).
 *
 * The scheduler stays what it was — the file/SQLite intent-state split, the no-backfill
 * slot semantics, the busy queue, the settled archive. What this module adds is the
 * unattended boundary around a fire: WHO owns the task, on WHICH device it may run,
 * under WHICH authorization grant and permission ceiling, and a DURABLE per-fire ledger
 * that survives restarts with fencing versions.
 *
 * Dependency injection (COMMON.md / CONTRACTS.md): the scheduler consults
 * {@link UnattendedCoordinator} for bound tasks; the coordinator consults
 * {@link UnattendedAuthorizer} before every physical send. When the authorizer interface
 * is NOT wired, authorization FAILS CLOSED (`authorizer_missing`) — a production tree
 * without an authorizer never sends an unattended fire. Tasks without a binding keep the
 * previously verified legacy semantics untouched.
 */
import { Interface } from "@prismshadow/penguin-core/kernel";

/** Identity context of an unattended invocation (CONTRACTS.md §1; tenantId v1 mapping: see taskexchange README / integration notes). */
export interface UnattendedIdentity {
  /** v1: the single implicit tenant of this server installation ("local"); never a fake multi-tenant claim. */
  tenantId: string | null;
  userId: string;
  deviceId: string;
  projectId: string;
  agentId: string;
  /** The schedule task name (the file identity). */
  taskId: string;
  sessionId?: string;
}

/** What the authorization is asked about. */
export interface UnattendedResource {
  kind: "schedule_fire";
  projectId: string;
  agentId: string;
  taskId: string;
  /** The scheduled slot (epoch ms) this invocation belongs to. */
  slotMs: number;
}

/** Constraints the caller already knows; the authorizer intersects them with live policy. */
export interface UnattendedConstraints {
  /** The operation requested, e.g. "schedule.dispatch". */
  operation: string;
  /** The grant the binding carries; the authorizer may verify or replace it. */
  grantId?: string;
  /** The binding's permission ceiling; the decision must stay inside it. */
  permissionCeiling?: PermissionCeiling;
  /** Caller's clock as an ISO instant (authorizers re-read their own clock for freshness). */
  now: string;
}

/** Outcome of one authorization decision (CONTRACTS.md §1 shape). */
export interface AuthorizationDecision {
  /** Overall verdict: an allow with outcome needs_approval still proceeds only after human action. */
  allowed: boolean;
  /** "allow" | "deny" | "needs_approval" — needs_approval rows wait for a human, never escalate. */
  outcome: "allow" | "deny" | "needs_approval";
  /** Stable machine code: granted | denied_by_policy | grant_expired | device_mismatch | operation_not_allowed | authorizer_missing | ... */
  reasonCode: string;
  /** Opaque id of THIS decision (audit trail references it per fire). */
  decisionId: string;
  /** Policy revision the decision came from. */
  policyRevision: string;
  /** When the decision was made (ISO). */
  checkedAt: string;
  /** When THIS decision stops being usable (ISO), e.g. a needs_approval window; null = no claimed expiry. */
  expiresAt: string | null;
}

/**
 * The authorization entry point (CONTRACTS.md §1 `authorizeInvocation`), injected as a
 * mechanism. Production wiring: a policy authorizer (Trae's identity/authorization work
 * may replace the local default — see integration-notes.md). MISSING interface = refuse.
 */
@Interface()
export abstract class UnattendedAuthorizer {
  abstract authorizeInvocation(
    identity: UnattendedIdentity,
    resource: UnattendedResource,
    constraints: UnattendedConstraints,
  ): Promise<AuthorizationDecision>;
}

/** The ceiling a binding grants: the run's permissions are the intersection of this and live policy. */
export interface PermissionCeiling {
  /** Operations this task may ever ask for (e.g. ["schedule.dispatch"]). A request outside it is denied. */
  allowedOperations: string[];
  /**
   * Unattended approval escalation. "allow-all" (the user's explicit grant) is the ONLY way an
   * unattended-created session gets the allow-all approval mode; anything else — including an
   * omitted field — keeps the Sandbox card's preset default, and an ask would wait as
   * needs_approval instead of auto-approving. Absent on legacy (unbound) tasks, which keep the
   * previously verified behavior.
   */
  unattendedApproval?: "default" | "allow-all";
  /** Run deadline in ms from dispatch; a run still running past it is expired and cancelled. */
  defaultRunDeadlineMs?: number;
}

/** One run's status (CONTRACTS.md §2 set plus `blocked` / `unknown` per the batch brief). */
export type UnattendedRunStatus =
  | "queued" // run row created, authorization not yet applied
  | "claimed" // authorized, waiting for the physical send (busy queue)
  | "running" // sent to a Session
  | "needs_approval" // authorization asks for a human; NO escalation, NO send
  | "blocked" // denied / expired / authorizer missing — terminal for this fire
  | "succeeded" // terminal, executor reported success
  | "failed" // terminal, executor reported failure or the send failed
  | "cancelled" // terminal, cancelled (an in-flight side effect is recorded in evidence/lifecycle)
  | "expired" // terminal, deadline passed
  | "unknown"; // dispatched but outcome unverifiable — kept pending, never silently re-fired

/** Terminal statuses: no further transition may change them (fencing). */
export const UNATTENDED_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export interface UnattendedBindingRow {
  projectId: string;
  agentId: string;
  name: string;
  ownerUserId: string;
  deviceId: string;
  grantId: string;
  grantExpiresAt: string | null;
  permissionCeiling: PermissionCeiling;
  publishSnapshot: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UnattendedRunRow {
  runId: string;
  projectId: string;
  agentId: string;
  name: string;
  slotMs: number;
  ownerUserId: string;
  deviceId: string;
  grantId: string | null;
  status: UnattendedRunStatus;
  statusVersion: number;
  sessionId: string | null;
  reasonCode: string | null;
  decisionId: string | null;
  policyRevision: string | null;
  decisionExpiresAt: string | null;
  deadlineMs: number | null;
  cancelRequested: boolean;
  cancelSignalDelivered: boolean;
  dispatchedAt: string | null;
  settledAt: string | null;
  evidence: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields a transition may change; the status itself and its fencing version are parameters of the CAS. */
export interface UnattendedRunPatch {
  status?: UnattendedRunStatus;
  sessionId?: string | null;
  reasonCode?: string | null;
  decisionId?: string | null;
  policyRevision?: string | null;
  decisionExpiresAt?: string | null;
  cancelRequested?: boolean;
  cancelSignalDelivered?: boolean;
  dispatchedAt?: string | null;
  settledAt?: string | null;
  /** Absolute deadline (epoch ms); assigned when a ceiling duration converts at dispatch. */
  deadlineMs?: number | null;
  evidence?: Record<string, unknown> | null;
}

/** One lifecycle record. */
export interface UnattendedLifecycleRow {
  eventId: string;
  at: string;
  kind: string;
  detail: Record<string, unknown>;
}

/** A fire the coordinator wants re-sent after a restart (queued, never dispatched, owner process gone). */
export interface UnattendedRedispatchRequest {
  run: UnattendedRunRow;
}

/** Sweep input: the caller's clock, the run ids it still owns, and the restart-redispatch callback. */
export interface UnattendedSweepArgs {
  nowMs: number;
  inFlight: ReadonlySet<string>;
  onRedispatch: (request: UnattendedRedispatchRequest) => Promise<boolean>;
}

/**
 * The scheduler's unattended boundary. Bound tasks (a binding row exists) go through here;
 * unbound tasks never touch it, so every previously verified behavior is preserved.
 */
@Interface()
export abstract class UnattendedCoordinator {
  /**
   * Idempotently open the run row for this fire (the UNIQUE(task, slot) makes double fires
   * impossible across ticks, restarts and concurrent triggers). `fresh=false` means the slot
   * already has a run: the caller must not fire again.
   */
  abstract beginFire(args: {
    projectId: string;
    agentId: string;
    name: string;
    slotMs: number;
  }): Promise<{ runId: string; fresh: boolean }>;

  /** The binding for a task, when the task is unattended-bound; null = legacy task. */
  abstract bindingFor(
    projectId: string,
    agentId: string,
    name: string,
  ): Promise<UnattendedBindingRow | null>;

  /** Pre-send gate: authorization + deadline + fencing. `proceed=false` never sends. */
  abstract authorizeFire(runId: string): Promise<{
    proceed: boolean;
    status: UnattendedRunStatus;
    reasonCode?: string;
    ceiling?: PermissionCeiling;
  }>;

  /** The physical send happened (sessionId is the target). Marks the run running + dispatchedAt. */
  abstract noteDispatched(runId: string, sessionId: string): Promise<void>;

  /** The send failed (slot already consumed): terminal failed with the reason. */
  abstract noteSendFailed(runId: string, reasonCode: string): Promise<void>;

  /** The executor reported a terminal outcome (CAS on the fencing version decides vs cancel). */
  abstract noteSettled(
    runId: string,
    outcome: "succeeded" | "failed",
    evidence?: Record<string, unknown>,
  ): Promise<{ applied: boolean }>;

  /**
   * Periodic sweep: approval-decision expiry, deadline expiry, unknown-outcome marking,
   * outcome polling, restart redispatch. `inFlight` holds the runIds the calling process
   * still owns (busy queue) — those are never redispatched from under it.
   */
  abstract sweep(args: UnattendedSweepArgs): Promise<void>;

  /** User-facing cancel. Terminal runs refuse; CAS decides vs a concurrent completion. */
  abstract cancelRun(
    runId: string,
    by: string,
  ): Promise<{ ok: boolean; status?: UnattendedRunStatus; reasonCode?: string }>;

  /** The task's file is gone (deleted or archived): drop the binding; run rows stay as audit. */
  abstract dropTask(projectId: string, agentId: string, name: string): void;

  /** Service lifecycle / blocked-fire audit records. */
  abstract recordLifecycle(kind: string, detail?: Record<string, unknown>): void;
}

/** Outcome feedback for dispatched runs (production: wired to the Session runtime by Codex; tests: doubles). */
@Interface()
export abstract class RunOutcomeSource {
  /** "succeeded" | "failed" for a settled session run, null while unknown. */
  abstract observe(sessionId: string, dispatchedAt?: string | null): Promise<"succeeded" | "failed" | null>;
}

/** Cancellation signal into the real executor (production adapter: Codex integration; tests: doubles). */
@Interface()
export abstract class RunCanceller {
  /** True when the executor confirmed receiving the cancellation signal. */
  abstract cancel(sessionId: string): Promise<boolean>;
}
