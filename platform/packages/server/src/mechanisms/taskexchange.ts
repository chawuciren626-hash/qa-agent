/**
 * The task-exchange mechanisms (batch 5): what a node may require, declared apart from
 * what implements it (house pattern). The repo in db/repos/task-exchange.ts implements
 * the store; the service in taskexchange/service.ts and the routes consume it.
 */
import { Interface } from "@prismshadow/penguin-core/kernel";
import type {
  ExchangeAllowedHost,
  ExchangeDeviceRow,
  ExchangeOutboxRow,
  ExchangePlatformRow,
  ExchangeResultRow,
  ExchangeTaskEvent,
  ExchangeTaskInput,
  ExchangeTaskRow,
} from "../taskexchange/types.js";
/** TaskExchangeStore: the mechanism TaskExchangeRepo implements (all exchange tables). */
@Interface()
export abstract class TaskExchangeStore {
  // -- platforms ----------------------------------------------------------
  abstract insertPlatform(row: ExchangePlatformRow): void;
  abstract findPlatformByTokenHash(tokenHash: string): ExchangePlatformRow | null;
  abstract findPlatform(tenantId: string, platformId: string): ExchangePlatformRow | null;
  abstract revokePlatform(tenantId: string, platformId: string, at: string): boolean;

  // -- devices ------------------------------------------------------------
  abstract insertDevice(row: ExchangeDeviceRow): void;
  abstract findDeviceByTokenHash(tokenHash: string): ExchangeDeviceRow | null;
  abstract findDevice(tenantId: string, deviceId: string): ExchangeDeviceRow | null;
  abstract listDevices(tenantId: string, userId: string): ExchangeDeviceRow[];
  abstract revokeDevice(tenantId: string, deviceId: string, at: string): boolean;
  abstract touchDevice(deviceId: string, at: string): void;

  // -- tasks --------------------------------------------------------------
  abstract insertTask(input: ExchangeTaskInput): ExchangeTaskRow;
  abstract findTask(tenantId: string, taskId: string): ExchangeTaskRow | null;
  abstract findTaskByIdempotencyKey(
    tenantId: string,
    platformId: string,
    idempotencyKey: string,
  ): ExchangeTaskRow | null;
  abstract findTaskByExternalId(
    tenantId: string,
    platformId: string,
    externalId: string,
  ): ExchangeTaskRow | null;
  abstract listTasksForPlatform(tenantId: string, platformId: string, limit?: number): ExchangeTaskRow[];
  abstract listQueuedForDevice(deviceId: string): ExchangeTaskRow[];
  abstract listReclaimable(beforeIso: string): ExchangeTaskRow[];
  abstract listPastDeadline(nowMs: number): ExchangeTaskRow[];
  /** Fencing transition: applies only at `expectedVersion` from `fromStatuses`; null = lost the race. */
  abstract transitionTask(
    taskId: string,
    expectedVersion: number,
    fromStatuses: readonly string[],
    patch: Partial<
      Pick<
        ExchangeTaskRow,
        "status" | "claimedBy" | "leaseEpoch" | "leaseExpiresAt" | "cancelRequested" | "cancelVersion" | "queuedReason" | "callbackUrl"
      >
    >,
  ): ExchangeTaskRow | null;

  // -- events (append-only audit) -----------------------------------------
  abstract insertEvent(event: Omit<ExchangeTaskEvent, "eventId">): void;
  abstract listEvents(taskId: string): ExchangeTaskEvent[];

  // -- results (at-least-once: one row per received attempt) ----------------
  abstract insertResult(row: Omit<ExchangeResultRow, "resultId">): void;
  abstract latestResult(taskId: string): ExchangeResultRow | null;
  abstract countResults(taskId: string): number;

  // -- outbox (delivery ledger, separate from execution) --------------------
  abstract insertOutbox(
    row: Omit<ExchangeOutboxRow, "outboxId" | "status" | "attempts" | "lastError" | "createdAt" | "updatedAt">,
  ): ExchangeOutboxRow;
  abstract listDueOutbox(beforeIso: string, limit?: number): ExchangeOutboxRow[];
  abstract markOutboxDelivered(outboxId: string, attempts: number, at: string): void;
  abstract markOutboxAttempt(
    outboxId: string,
    attempts: number,
    nextAttemptAt: string,
    lastError: string | null,
    status: "pending" | "abandoned",
    at: string,
  ): void;

  // -- admin intranet allowlist (explicit config, the SSRF exception) --------
  abstract insertAllowedHost(host: string, addedBy: string, at: string): void;
  abstract listAllowedHosts(): ExchangeAllowedHost[];
}

/** ExchangeTasks: the mechanism ExchangeService implements (the state machine the routes drive). */
@Interface()
export abstract class ExchangeTasks {
  abstract createTask(args: {
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
  }): { task: ExchangeTaskRow; idempotent: boolean };
  abstract taskForPlatform(tenantId: string, platformId: string, taskId: string, nowMs: number): ExchangeTaskRow;
  abstract listForPlatform(tenantId: string, platformId: string, nowMs: number): ExchangeTaskRow[];
  abstract cancelTask(tenantId: string, platformId: string, taskId: string, nowMs: number): ExchangeTaskRow;
  abstract claimNext(
    caller: { tenantId: string; deviceId: string },
    nowMs: number,
  ): { task: ExchangeTaskRow; lease: { epoch: number; expiresAt: string }; previousOutcomeUnknown: boolean } | null;
  abstract updateStatus(
    caller: { tenantId: string; deviceId: string },
    taskId: string,
    input:
      | { leaseEpoch: number; status: "running" }
      | { leaseEpoch: number; ackCancelVersion: number },
    nowMs: number,
  ): ExchangeTaskRow;
  abstract heartbeat(caller: { tenantId: string; deviceId: string }, taskId: string, leaseEpoch: number, nowMs: number): ExchangeTaskRow;
  abstract submitResult(
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
  ): { task: ExchangeTaskRow; applied: boolean };
  abstract sweepExpired(nowMs: number): number;
  abstract setCallbackUrl(
    tenantId: string,
    platformId: string,
    taskId: string,
    url: string,
    guard: { allowedHosts: ReadonlySet<string> },
    nowMs: number,
  ): ExchangeTaskRow;
}

/** ExchangeOutboxScheduler: the mechanism OutboxDispatcher implements (Startup starts it). */
@Interface()
export abstract class ExchangeOutboxScheduler {
  abstract start(): void;
  abstract stop(): void;
  /** One processing pass (expired-task sweep + due deliveries); exposed for tests. */
  abstract tickOnce(): Promise<void>;
}
