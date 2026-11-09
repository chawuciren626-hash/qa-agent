/**
 * Task exchange contracts (batch 5): statuses, the transition table, and the wire shapes
 * of the versioned external API (`/api/exchange/v1`, schema: task-api.openapi.yaml in the
 * delivery). The authoritative semantics:
 *
 * - Isolation is per (tenant_id, platform_id). v1 runs a single implicit tenant ("local",
 *   this installation); the column exists so a real tenant entity can replace the mapping
 *   without a migration (CONTRACTS.md §1 forbids faking multi-tenancy with a constant —
 *   the constant is documented AS the mapping, and every query filters by it).
 * - A task is bound to ONE device at creation (server-verified against the device
 *   registry); it is never re-bound automatically and never executes elsewhere.
 * - Claims use leases (owner + expiry + epoch fencing token). A stale epoch cannot write;
 *   a lapsed lease does NOT make a previous execution's outcome safe to assume — a
 *   re-claim after a lapsed RUNNING lease flags `previous_outcome_unknown` to the next
 *   executor and records the audit event.
 * - Delivery is at-least-once via the outbox with its own idempotency keys; a retried
 *   delivery never re-executes a task.
 * - Default return data: status, summary, evidence index, sanitized error. Anything else
 *   (screenshots, logs, full reports, project files) is refused unless the task's
 *   allowed_data_fields explicitly authorizes it.
 */
import { randomUUID } from "node:crypto";
import { HttpError } from "../http/errors.js";

export type ExchangeTaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export const EXCHANGE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

/**
 * The allowed transitions. `cancel` entries carry the cancel request's version ack; the
 * executor's own final write still CASes on status_version, so a concurrent cancel and a
 * concurrent completion resolve to exactly one winner.
 */
export const EXCHANGE_TRANSITIONS: ReadonlyArray<{
  from: ExchangeTaskStatus;
  to: ExchangeTaskStatus;
  by: "claim" | "status" | "cancel" | "expire" | "cancel_ack";
}> = [
  { from: "queued", to: "claimed", by: "claim" },
  { from: "queued", to: "cancelled", by: "cancel" },
  { from: "claimed", to: "running", by: "status" },
  { from: "claimed", to: "cancelled", by: "cancel_ack" },
  { from: "claimed", to: "cancelled", by: "cancel" },
  { from: "claimed", to: "expired", by: "expire" },
  { from: "running", to: "succeeded", by: "status" },
  { from: "running", to: "failed", by: "status" },
  { from: "running", to: "cancelled", by: "cancel_ack" },
  { from: "running", to: "cancelled", by: "cancel" },
  { from: "running", to: "expired", by: "expire" },
];

export function transitionAllowed(from: string, to: string): boolean {
  return EXCHANGE_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export interface ExchangePlatformRow {
  tenantId: string;
  platformId: string;
  tokenHash: string;
  registeredAt: string;
  revokedAt: string | null;
}

export interface ExchangeDeviceRow {
  deviceId: string;
  tenantId: string;
  userId: string;
  platformId: string;
  tokenHash: string;
  label: string;
  registeredAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

export interface ExchangeTaskInput {
  taskId: string;
  tenantId: string;
  platformId: string;
  externalId: string;
  idempotencyKey: string;
  userId: string;
  deviceId: string;
  projectRef: string;
  objective: string;
  allowedDataFields: string[];
  deadlineMs: number | null;
  publishSnapshot: Record<string, unknown>;
}

export interface ExchangeTaskRow {
  taskId: string;
  tenantId: string;
  platformId: string;
  externalId: string;
  idempotencyKey: string;
  userId: string;
  deviceId: string;
  projectRef: string;
  objective: string;
  allowedDataFields: string[];
  deadlineMs: number | null;
  publishSnapshot: Record<string, unknown>;
  callbackUrl: string | null;
  status: ExchangeTaskStatus;
  statusVersion: number;
  cancelRequested: boolean;
  cancelVersion: number;
  queuedReason: string | null;
  claimedBy: string | null;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExchangeTaskEvent {
  eventId: string;
  taskId: string;
  at: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface ExchangeResultRow {
  resultId: string;
  taskId: string;
  outcome: "succeeded" | "failed";
  summary: Record<string, unknown>;
  evidenceIndex: Record<string, unknown>;
  synthetic: boolean;
  receivedAt: string;
  attempt: number;
}

export interface ExchangeOutboxRow {
  outboxId: string;
  taskId: string;
  kind: "status" | "callback";
  targetUrl: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  status: "pending" | "delivered" | "abandoned";
  createdAt: string;
  updatedAt: string;
}

export interface ExchangeAllowedHost {
  host: string;
  addedBy: string;
  addedAt: string;
}

/** The fields a result may carry without explicit authorization (CONTRACTS.md §4). */
export const DEFAULT_DATA_FIELDS: ReadonlySet<string> = new Set(["status", "summary", "evidence_index"]);

/** Recognized EXTRA fields (an unrecognized field is refused outright, not silently dropped). */
export const KNOWN_EXTRA_DATA_FIELDS: ReadonlySet<string> = new Set([
  "screenshots",
  "logs",
  "full_report",
  "project_files",
]);

/** Task-creation validation. Returns the shaped input parts, or throws an ExchangeError. */
export function validateCreateTaskBody(body: Record<string, unknown>): {
  externalId: string;
  idempotencyKey: string;
  deviceId: string;
  projectRef: string;
  objective: string;
  allowedDataFields: string[];
  deadlineMs: number | null;
  publishSnapshot: Record<string, unknown>;
} {
  const str = (key: string, max: number): string => {
    const v = body[key];
    if (typeof v !== "string" || v.trim() === "" || v.length > max) {
      throw new ExchangeError(400, "invalid_task", `${key} must be a non-empty string (max ${max}).`);
    }
    return v;
  };
  const externalId = str("externalId", 200);
  const idempotencyKey = str("idempotencyKey", 200);
  const deviceId = str("deviceId", 200);
  const projectRef = str("projectRef", 200);
  const objective = str("objective", 10_000);
  // Allowed data fields: defaults always apply; extras must be known and explicit.
  const rawFields = body.allowedDataFields;
  let allowedDataFields: string[] = [...DEFAULT_DATA_FIELDS];
  if (rawFields !== undefined && rawFields !== null) {
    if (!Array.isArray(rawFields) || rawFields.some((f) => typeof f !== "string" || f === "")) {
      throw new ExchangeError(400, "invalid_task", "allowedDataFields must be an array of field names.");
    }
    for (const field of rawFields as string[]) {
      if (!DEFAULT_DATA_FIELDS.has(field) && !KNOWN_EXTRA_DATA_FIELDS.has(field)) {
        throw new ExchangeError(400, "invalid_task", `unknown data field: ${field}`);
      }
    }
    allowedDataFields = [...new Set(rawFields as string[])];
  }
  let deadlineMs: number | null = null;
  if (body.deadlineMs !== undefined && body.deadlineMs !== null) {
    if (typeof body.deadlineMs !== "number" || !Number.isFinite(body.deadlineMs)) {
      throw new ExchangeError(400, "invalid_task", "deadlineMs must be epoch ms.");
    }
    deadlineMs = body.deadlineMs;
  }
  const snapshot = body.publishSnapshot ?? {};
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new ExchangeError(400, "invalid_task", "publishSnapshot must be an object.");
  }
  return {
    externalId,
    idempotencyKey,
    deviceId,
    projectRef,
    objective,
    allowedDataFields,
    deadlineMs,
    publishSnapshot: snapshot as Record<string, unknown>,
  };
}

/**
 * A task-exchange API error. It IS an HttpError (same `{error:{code,message}}` shape), so
 * the app's central onError converges service-thrown exchange errors into versioned JSON
 * responses without any route-level catching.
 */
export class ExchangeError extends HttpError {
  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(status, code, message);
    this.name = "ExchangeError";
  }
}

export function newExchangeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
