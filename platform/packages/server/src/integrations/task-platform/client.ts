/**
 * 任务平台集成 API 客户端（Pull 方向 ①~④ 与 Push 方向 ⑤ 的传输层）。
 *
 * 设计约束（对接方案 §4 P1）：
 * - fetch 可注入：测试不占端口，生产用全局 fetch（house pattern，见 taskexchange/outbox.ts）。
 * - 只按接口清单 §3.5 的错误语义分类：可重试（408/429/503/504 + 重试 subCode）退避重试；
 *   401/403/409 等不可重试错误立即抛出，由调用方告警停轮询。
 * - 事件游标过期（410 EVENT_CURSOR_EXPIRED）由调用方决定重建策略，客户端只报告。
 * - 附件下载走流式读取 + 全文件 SHA-256 校验；哈希不符抛 AttachmentHashMismatchError。
 */

import {
  CURSOR_EXPIRED_SUB_CODE,
  RETRYABLE_SUB_CODES,
  type HandoffEventPage,
  type HandoffPackage,
  type PlatformEnvelope,
  type ProductLinePage,
  type TestResultAck,
  type TestResultPayload,
} from "./contracts.js";

export interface TaskPlatformClientConfig {
  /** 任务平台基地址，如 http://192.168.60.132:8000 或 https://task.example.com。 */
  baseUrl: string;
  /** 服务凭据（Bearer API Key）。 */
  apiKey: string;
  /** 单次请求超时毫秒数。 */
  timeoutMs?: number;
  /** 可重试错误的最大尝试次数（含首次）。 */
  maxAttempts?: number;
  /** 重试基础退避毫秒数（指数翻倍）。 */
  retryBaseBackoffMs?: number;
  /** 注入用于测试；生产为全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 注入用于测试的休眠；生产用真实定时。 */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class TaskPlatformApiError extends Error {
  readonly status: number;
  readonly subCode: string;
  readonly retryable: boolean;
  readonly traceId: string | null;

  constructor(status: number, subCode: string, message: string, traceId: string | null) {
    super(`task platform api error: status=${status} subCode=${subCode} message=${message}`);
    this.name = "TaskPlatformApiError";
    this.status = status;
    this.subCode = subCode;
    this.retryable = status === 408 || status === 429 || status === 503 || status === 504 ||
      RETRYABLE_SUB_CODES.includes(subCode);
    this.traceId = traceId;
  }
}

export class CursorExpiredError extends TaskPlatformApiError {
  constructor(traceId: string | null) {
    super(410, CURSOR_EXPIRED_SUB_CODE, "事件游标过期，需要从最早可用游标重建", traceId);
    this.name = "CursorExpiredError";
  }
}

export class AttachmentHashMismatchError extends Error {
  readonly attachmentId: string;
  readonly expectedSha256: string | null;
  readonly actualSha256: string;

  constructor(attachmentId: string, expectedSha256: string | null, actualSha256: string) {
    super(`attachment hash mismatch: id=${attachmentId}`);
    this.name = "AttachmentHashMismatchError";
    this.attachmentId = attachmentId;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 503, 504]);

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export class TaskPlatformClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(config: TaskPlatformClientConfig) {
    if (!config.baseUrl) throw new Error("TaskPlatformClient: baseUrl is required");
    if (!config.apiKey) throw new Error("TaskPlatformClient: apiKey is required");
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.retryBaseBackoffMs = config.retryBaseBackoffMs ?? 1_000;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = config.sleepImpl ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** ① 产品线目录（一页）。 */
  async fetchProductLines(options: {
    updatedSince?: string;
    cursor?: string;
    limit?: number;
    includeDisabled?: boolean;
  } = {}): Promise<ProductLinePage> {
    const envelope = await this.request<ProductLinePage>({
      method: "GET",
      path: "/api/v1/integration-handoff/product-lines",
      query: {
        updated_since: options.updatedSince,
        cursor: options.cursor,
        limit: options.limit ?? 100,
        include_disabled: options.includeDisabled ?? true,
      },
    });
    return envelope.data ?? { items: [], next_cursor: null, has_more: false };
  }

  /** ② 交接事件（一页）。游标过期抛 CursorExpiredError。 */
  async fetchHandoffEvents(options: {
    cursor?: string;
    limit?: number;
    eventTypes?: string[];
    taskId?: string;
  } = {}): Promise<HandoffEventPage> {
    const envelope = await this.request<HandoffEventPage>({
      method: "GET",
      path: "/api/v1/integration-handoff/handoff-events",
      query: {
        cursor: options.cursor,
        limit: options.limit ?? 100,
        event_types: options.eventTypes?.length ? options.eventTypes.join(",") : undefined,
        task_id: options.taskId,
      },
    });
    return envelope.data ?? { items: [], next_cursor: null, has_more: false };
  }

  /** ③ 交接包（指定版本或 latest）。 */
  async fetchHandoffPackage(taskId: string, packageVersion: number | "latest"): Promise<HandoffPackage> {
    const version = packageVersion === "latest" ? "latest" : String(packageVersion);
    const envelope = await this.request<HandoffPackage>({
      method: "GET",
      path: `/api/v1/integration-handoff/tasks/${encodeURIComponent(taskId)}/handoff-packages/${version}`,
    });
    if (!envelope.data) {
      throw new TaskPlatformApiError(404, "HANDOFF.PACKAGE.NOT_PUBLISHED", "包数据为空", envelope.traceId);
    }
    return envelope.data;
  }

  /**
   * ④ 附件下载：流式读取全文件并校验 SHA-256；不符抛 AttachmentHashMismatchError。
   * 平台侧附件下载响应为原始文件流（非 envelope）。
   */
  async downloadAttachment(taskId: string, attachmentId: string): Promise<Uint8Array> {
    const path = `/api/v1/integration-handoff/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`;
    const response = await this.rawRequestWithRetry({ method: "GET", path });
    if (!response.ok) {
      const subCode = response.headers.get("x-sub-code") ?? "INTEGRATION.DOWNLOAD_FAILED";
      throw new TaskPlatformApiError(response.status, subCode, `附件下载失败 ${attachmentId}`, null);
    }
    const expectedSha256 = normalizeSha256(response.headers.get("x-content-sha256"));
    const buffer = new Uint8Array(await response.arrayBuffer());
    const actualSha256 = await sha256Hex(buffer);
    if (expectedSha256 && actualSha256 !== expectedSha256) {
      throw new AttachmentHashMismatchError(attachmentId, expectedSha256, actualSha256);
    }
    return buffer;
  }

  /** ⑤ 测试结果回传（Push）。调用方负责构造幂等键。 */
  async submitTestResult(
    taskId: string,
    payload: TestResultPayload,
    idempotencyKey: string,
  ): Promise<TestResultAck> {
    const envelope = await this.request<TestResultAck>({
      method: "POST",
      path: `/api/v1/integration-handoff/tasks/${encodeURIComponent(taskId)}/test-results`,
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      idempotencyKey,
    });
    if (!envelope.data) {
      throw new TaskPlatformApiError(500, "INTEGRATION.EMPTY_ACK", "回传响应缺少数据", envelope.traceId);
    }
    return envelope.data;
  }

  /** 连接测试（凭据配置页用）。 */
  async ping(): Promise<{ ok: boolean; subCode: string }> {
    try {
      await this.request({ method: "GET", path: "/api/v1/integration-handoff/product-lines", query: { limit: 1 } });
      return { ok: true, subCode: "SUCCESS" };
    } catch (error) {
      if (error instanceof TaskPlatformApiError) return { ok: false, subCode: error.subCode };
      return { ok: false, subCode: "NETWORK_ERROR" };
    }
  }

  /** 统一请求：envelope 解析 + 可重试错误退避重试。 */
  private async request<T>(options: RequestOptions): Promise<PlatformEnvelope<T>> {
    const response = await this.rawRequestWithRetry(options);
    const text = await response.text();
    let envelope: PlatformEnvelope<T>;
    try {
      envelope = JSON.parse(text) as PlatformEnvelope<T>;
    } catch {
      throw new TaskPlatformApiError(
        response.status,
        "INTEGRATION.RESPONSE_MALFORMED",
        "任务平台响应不是合法 JSON",
        response.headers.get("x-trace-id"),
      );
    }
    if (envelope.code !== 200 || envelope.subCode !== "SUCCESS") {
      if (envelope.subCode === CURSOR_EXPIRED_SUB_CODE || response.status === 410) {
        throw new CursorExpiredError(envelope.traceId);
      }
      throw new TaskPlatformApiError(
        envelope.code || response.status,
        envelope.subCode || "INTEGRATION.UNKNOWN_ERROR",
        envelope.subMessage || envelope.message || "unknown error",
        envelope.traceId,
      );
    }
    return envelope;
  }

  /** 底层请求 + 指数退避重试（仅可重试错误）。 */
  private async rawRequestWithRetry(options: RequestOptions): Promise<Response> {
    let lastError: TaskPlatformApiError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.rawRequest(options);
      } catch (error) {
        // 网络层失败视为可重试
        lastError = new TaskPlatformApiError(0, "INTEGRATION.NETWORK_ERROR", String(error), null);
        if (attempt === this.maxAttempts) throw lastError;
        await this.sleepImpl(this.retryBaseBackoffMs * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) return response;
      const status = response.status;
      if (status === 410) {
        // 游标过期在传输层即可判定（状态码语义），不入重试
        throw new CursorExpiredError(response.headers.get("x-trace-id"));
      }
      const retryable = RETRYABLE_HTTP_STATUSES.has(status);
      lastError = new TaskPlatformApiError(
        status,
        `INTEGRATION.HTTP_${status}`,
        `HTTP ${status}`,
        response.headers.get("x-trace-id"),
      );
      if (!retryable || attempt === this.maxAttempts) throw lastError;
      await this.sleepImpl(this.retryBaseBackoffMs * 2 ** (attempt - 1));
    }
    throw lastError ?? new TaskPlatformApiError(500, "INTEGRATION.RETRY_EXHAUSTED", "重试耗尽", null);
  }

  private async rawRequest(options: RequestOptions): Promise<Response> {
    const url = new URL(this.baseUrl + options.path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
          ...(options.headers ?? {}),
        },
        body: options.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeSha256(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("sha256:") ? trimmed.slice(7) : trimmed;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}
