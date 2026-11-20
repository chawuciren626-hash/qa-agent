/**
 * 测试结果回传 outbox（对接方案 §4 P5，照 taskexchange/outbox.ts 的模式新建）。
 *
 * - 投递 = POST /test-results，幂等键 aitest:{tenant}:{task}:{pm_round}:{result_id}；
 * - 重试独立于测试执行本身：重试只重发，绝不重新生成结论；
 * - 退避：30s 起指数翻倍封顶 1h；达到最大次数标记 abandoned（保留行，审计用）；
 * - 409 IDEMPOTENCY_CONFLICT 属配置错误（同键不同内容），停止重试并告警——
 *   正确做法是发新 result_version，而不是覆盖旧结论。
 */

import { buildIdempotencyKey, type TestResultPayload } from "./contracts.js";
import { TaskPlatformApiError, TaskPlatformClient } from "./client.js";
import type { TaskPlatformStore } from "./store.js";

export const OUTBOX_BASE_BACKOFF_MS = 30_000;
export const OUTBOX_MAX_BACKOFF_MS = 3_600_000;
export const OUTBOX_MAX_ATTEMPTS = 12;

export interface ResultOutboxOptions {
  client: TaskPlatformClient;
  store: TaskPlatformStore;
  /** 结果所属项目映射的租户（幂等键组成部分）。 */
  tenantId: string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAttempts?: number;
  /** 每轮最多投递条数。 */
  batchSize?: number;
  /** 注入时钟。 */
  now?: () => Date;
}

export interface OutboxTickSummary {
  attempted: number;
  delivered: number;
  retried: number;
  abandoned: number;
}

export class ResultOutboxDispatcher {
  private readonly client: TaskPlatformClient;
  private readonly store: TaskPlatformStore;
  private readonly tenantId: string;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  /** 投递放弃告警挂点。 */
  onAbandoned: ((resultId: string, lastError: string) => void) | null = null;
  /** 幂等冲突告警挂点。 */
  onConflict: ((resultId: string, message: string) => void) | null = null;

  constructor(options: ResultOutboxOptions) {
    this.client = options.client;
    this.store = options.store;
    this.tenantId = options.tenantId;
    this.baseBackoffMs = options.baseBackoffMs ?? OUTBOX_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? OUTBOX_MAX_BACKOFF_MS;
    this.maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    this.batchSize = options.batchSize ?? 10;
    this.now = options.now ?? (() => new Date());
  }

  /** 入队一条结果（测试结论确认后调用）。幂等：同 result_id+version 只入队一次。 */
  enqueue(payload: TestResultPayload): { created: boolean } {
    return this.store.enqueueResult({
      task_id: payload.task_id,
      result_id: payload.result_id,
      result_version: payload.result_version,
      idempotency_key: buildIdempotencyKey(
        payload.tenant_id || this.tenantId,
        payload.task_id,
        payload.pm_round_id,
        payload.result_id,
      ),
      payload_json: JSON.stringify(payload),
    });
  }

  /** 心跳 tick：投递到期行。由调度器周期调用。 */
  async tickOnce(): Promise<OutboxTickSummary> {
    const summary: OutboxTickSummary = { attempted: 0, delivered: 0, retried: 0, abandoned: 0 };
    const nowIso = this.now().toISOString();
    const rows = this.store.dueOutboxRows(nowIso, this.batchSize);
    for (const row of rows) {
      summary.attempted++;
      const outcome = await this.deliverRow(row.id, row.task_id, row.payload_json, row.idempotency_key, row.attempts);
      if (outcome === "delivered") summary.delivered++;
      else if (outcome === "retry") summary.retried++;
      else if (outcome === "abandoned") summary.abandoned++;
      // conflict：既不计 delivered 也不重试，告警已发，等待人工处理
    }
    return summary;
  }

  private async deliverRow(
    rowId: string,
    taskId: string,
    payloadJson: string,
    idempotencyKey: string,
    attemptsSoFar: number,
  ): Promise<"delivered" | "retry" | "abandoned" | "conflict"> {
    let payload: TestResultPayload;
    try {
      payload = JSON.parse(payloadJson) as TestResultPayload;
    } catch (error) {
      // 坏载荷不可恢复：放弃并告警
      this.store.markOutboxRetry(rowId, this.maxAttempts, this.farFuture(), `payload parse error: ${String(error)}`);
      this.onAbandoned?.(payloadJson.slice(0, 64), "payload parse error");
      return "abandoned";
    }
    try {
      const ack = await this.client.submitTestResult(taskId, payload, idempotencyKey);
      this.store.markOutboxDelivered(rowId, this.now().toISOString());
      if (ack.receive_status === "duplicate") {
        // 平台已收过同一幂等键：视为投递成功（至少一次语义收敛）
      }
      return "delivered";
    } catch (error) {
      if (error instanceof TaskPlatformApiError) {
        if (error.status === 409 || error.subCode === "INTEGRATION.IDEMPOTENCY_CONFLICT") {
          this.store.markOutboxRetry(rowId, this.maxAttempts, this.farFuture(), `conflict: ${error.message}`);
          this.onConflict?.(payload.result_id, error.message);
          return "conflict";
        }
        if (!error.retryable) {
          // 401/403/422 等：配置或数据错误，重试无意义，放弃
          this.store.markOutboxRetry(rowId, this.maxAttempts, this.farFuture(), `permanent: ${error.message}`);
          this.onAbandoned?.(payload.result_id, error.message);
          return "abandoned";
        }
      }
      const nextAttempts = attemptsSoFar + 1;
      if (nextAttempts >= this.maxAttempts) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.markOutboxRetry(rowId, nextAttempts, this.farFuture(), message);
        this.onAbandoned?.(payload.result_id, message);
        return "abandoned";
      }
      const backoff = Math.min(this.baseBackoffMs * 2 ** attemptsSoFar, this.maxBackoffMs);
      const message = error instanceof Error ? error.message : String(error);
      this.store.markOutboxRetry(rowId, nextAttempts, new Date(this.now().getTime() + backoff).toISOString(), message);
      return "retry";
    }
  }

  private farFuture(): string {
    return new Date(this.now().getTime() + 100 * 365 * 24 * 3600 * 1000).toISOString();
  }
}

/**
 * 周期调度器（组件生命周期由接线层管理）。
 */
export class ResultOutboxScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly dispatcher: ResultOutboxDispatcher,
    private readonly intervalMs = 15_000,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tickOnce(): Promise<OutboxTickSummary> {
    if (this.ticking) return { attempted: 0, delivered: 0, retried: 0, abandoned: 0 };
    this.ticking = true;
    try {
      return await this.dispatcher.tickOnce();
    } finally {
      this.ticking = false;
    }
  }
}
