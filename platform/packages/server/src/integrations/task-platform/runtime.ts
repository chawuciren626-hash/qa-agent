/**
 * 任务平台集成的运行时装配层：配置存取 + ingestion 轮询调度器 + 一次性手动同步。
 *
 * - 配置（凭据/开关/轮询间隔）存 system_config 通用 KV（admin-system-store 同库），
 *   Key 前缀 task_platform_；API Key 只写不读出（读返回 masked）。
 * - IngestionScheduler：周期 runOnce；游标过期自动重建；失败告警回调注入。
 * - 手动同步：与自动轮询共用同一个 IngestionService 实例，避免并发踩踏（单线程 tick 锁）。
 *
 * 本模块由 http/routes/task-platform-admin.ts 与 Startup 接线层消费；
 * 不直接 import 具体服务容器（保持可单测）。
 */
import { IngestionService } from "./ingestion-service.js";
import { TaskPlatformClient } from "./client.js";
import { PlatformTaskBridge } from "./platform-task-bridge.js";
import { PlatformTaskSyncService } from "./client-sync-service.js";
import { ResultOutboxDispatcher, ResultOutboxScheduler } from "./result-outbox.js";
import { SqliteTaskPlatformStore, type TaskPlatformStore } from "./store.js";
import { buildIdempotencyKey } from "./contracts.js";

export interface TaskPlatformSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  pollIntervalMs: number;
  batchSize: number;
  /** 推送接收人（同步项目 owner / 任务归属用户）；空 = admin。 */
  recipientUserId: string;
}

export interface TaskPlatformConfigStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const SETTINGS_KEY = "task_platform_settings_json";

export function loadSettings(configStore: TaskPlatformConfigStore): TaskPlatformSettings {
  const raw = configStore.get(SETTINGS_KEY);
  if (!raw) {
    return { enabled: false, baseUrl: "", apiKey: "", pollIntervalMs: 60_000, batchSize: 50, recipientUserId: "" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TaskPlatformSettings>;
    return {
      enabled: parsed.enabled === true,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      pollIntervalMs: clampInterval(parsed.pollIntervalMs),
      batchSize: typeof parsed.batchSize === "number" && parsed.batchSize >= 1 && parsed.batchSize <= 500 ? parsed.batchSize : 50,
      recipientUserId: typeof parsed.recipientUserId === "string" ? parsed.recipientUserId : "",
    };
  } catch {
    return { enabled: false, baseUrl: "", apiKey: "", pollIntervalMs: 60_000, batchSize: 50, recipientUserId: "" };
  }
}

export function saveSettings(configStore: TaskPlatformConfigStore, settings: TaskPlatformSettings): void {
  configStore.set(SETTINGS_KEY, JSON.stringify(settings));
}

export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function clampInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 60_000;
  return Math.min(Math.max(Math.round(value), 10_000), 3_600_000);
}

/** admin 路由输入 → 合法配置（先校验后写；非法整体拒绝）。Key 缺省由调用方回填原值。 */
export function clampSettingsInput(input: {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  pollIntervalMs: unknown;
  batchSize: unknown;
  recipientUserId?: unknown;
}): TaskPlatformSettings {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  if (input.enabled && !/^https?:\/\/.+/i.test(baseUrl)) {
    throw new RangeError("启用集成时必须提供合法的任务平台地址（http(s)://…）");
  }
  if (input.enabled && !input.apiKey) {
    throw new RangeError("启用集成时必须提供服务凭据（API Key）");
  }
  if (typeof input.pollIntervalMs !== "number" || input.pollIntervalMs < 10_000 || input.pollIntervalMs > 3_600_000) {
    throw new RangeError("轮询间隔必须在 10 秒到 1 小时之间");
  }
  if (typeof input.batchSize !== "number" || input.batchSize < 1 || input.batchSize > 500) {
    throw new RangeError("单轮事件批量必须在 1~500 之间");
  }
  const recipientUserId = typeof input.recipientUserId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(input.recipientUserId.trim())
    ? input.recipientUserId.trim()
    : "";
  return {
    enabled: input.enabled,
    baseUrl,
    apiKey: input.apiKey,
    pollIntervalMs: clampInterval(input.pollIntervalMs),
    batchSize: Math.round(input.batchSize),
    recipientUserId,
  };
}

/** 组装依赖就绪的 IngestionService（每次配置变更后重建）。 */
export function buildIngestionService(
  settings: TaskPlatformSettings,
  store: TaskPlatformStore,
  bridge: PlatformTaskBridge,
): IngestionService {
  const client = new TaskPlatformClient({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
  });
  return new IngestionService({ client, store, activation: bridge, batchSize: settings.batchSize });
}

export class IngestionScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private service: IngestionService | null = null;
  private settings: TaskPlatformSettings;
  private readonly store: TaskPlatformStore;
  private readonly bridge: PlatformTaskBridge;
  private readonly configStore: TaskPlatformConfigStore;
  /** 库句柄（同步项目归属迁移用；可选，缺省跳过迁移）。 */
  private readonly db: import("node:sqlite").DatabaseSync | null;
  /** 结果回传 outbox 调度器（C2）：接收端点入队 → 周期投递任务平台。enabled 时与拉取同启停。 */
  private outboxScheduler: ResultOutboxScheduler | null = null;
  /** 接收人候选提供者（接线层注入 Users 机制）；未注入时只返回 admin。 */
  listRecipientsImpl: (() => Array<{ userId: string; displayName: string; isAdmin: boolean }>) | null = null;
  /** 运行观测（admin 页展示）。 */
  lastRunAt: string | null = null;
  lastError: string | null = null;

  constructor(args: {
    configStore: TaskPlatformConfigStore;
    store: TaskPlatformStore;
    bridge: PlatformTaskBridge;
    /** 同步项目归属迁移用（可选：单测/无库场景缺省时跳过迁移）。 */
    db?: import("node:sqlite").DatabaseSync;
  }) {
    this.configStore = args.configStore;
    this.store = args.store;
    this.bridge = args.bridge;
    this.db = args.db ?? null;
    this.settings = loadSettings(args.configStore);
    // 启动兜底：接收人配置与既有同步项目 owner 可能不一致（配置写入早于本进程/上一实例
    // 未及迁移）——幂等迁移到当前接收人，保证接收人切换后项目/任务立即可见。
    if (this.db) this.transferSyncProjects(this.settings.recipientUserId || "admin");
    if (this.settings.enabled && this.settings.baseUrl && this.settings.apiKey) {
      this.service = buildIngestionService(this.settings, this.store, this.bridge);
      const pair = this.buildOutboxScheduler(this.settings);
      this.outboxScheduler = pair.scheduler;
      this.outboxDispatcher = pair.dispatcher;
      pair.scheduler.start();
    }
  }

  /**
   * 同步项目归属迁移（接收人切换）：source_type='sync' 的项目统一交给当前接收人，
   * 使"后台配置推送给哪个用户"立即生效——新接收人在项目列表/任务列表直接看到既有
   * 同步项目与任务（任务已入库，事件游标不回放也不需要重放）。手工项目不受影响。
   * 幂等：重复调用只重复写同一 owner。目标用户不存在（已禁用/删号）时 FK 失败被吞，
   * 保留原 owner（admin 仍可见），并记录日志。
   */
  transferSyncProjects(toUserId: string): number {
    if (!this.db) return 0;
    const target = toUserId.trim() || "admin";
    try {
      const result = this.db
        .prepare(
          `UPDATE projects SET owner_user_id = ?
            WHERE project_id IN (SELECT project_id FROM project_management WHERE source_type = 'sync')`,
        )
        .run(target);
      return Number((result as { changes?: number }).changes ?? 0);
    } catch (error) {
      console.error(`[task-platform] sync project ownership transfer to ${target} skipped:`, error instanceof Error ? error.message : error);
      return 0;
    }
  }

  /**
   * 组装结果回传 outbox（C2 闭环）：客户端结果经 /api/sync/v1/test-results 入队
   * （幂等键 + 载荷），enabled 时按 15s 心跳投递任务平台（POST /tasks/{task_id}/test-results，
   * 指数退避，见 result-outbox.ts）。dispatcher 与 scheduler 一起持有：入队要 dispatcher。
   */
  private buildOutboxScheduler(settings: TaskPlatformSettings): { scheduler: ResultOutboxScheduler; dispatcher: ResultOutboxDispatcher } {
    const client = new TaskPlatformClient({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      maxAttempts: 3,
    });
    const dispatcher = new ResultOutboxDispatcher({
      client,
      store: this.store,
      tenantId: "sbkj-taskassignment",
    });
    dispatcher.onAbandoned = (resultId, message) => {
      console.error(`[task-platform] result outbox abandoned: ${resultId}: ${message}`);
    };
    dispatcher.onConflict = (resultId, message) => {
      console.error(`[task-platform] result idempotency conflict（发新 result_version 而非重发）: ${resultId}: ${message}`);
    };
    return { scheduler: new ResultOutboxScheduler(dispatcher), dispatcher };
  }

  /**
   * 结果入队（C1 接收面调用）。对接未启用时也允许入队——结果先落库不丢，
   * 配置补齐后下一轮自动投递。直接走 store.enqueueResult（幂等 result_id+version）：
   * 不经 dispatcher（未启用时无 baseUrl/apiKey，client 无法构造，也不需要投递通道）。
   */
  enqueueTestResult(payload: import("./contracts.js").TestResultPayload): { created: boolean } {
    return this.store.enqueueResult({
      task_id: payload.task_id,
      result_id: payload.result_id,
      result_version: payload.result_version,
      idempotency_key: buildIdempotencyKey(
        payload.tenant_id || "sbkj-taskassignment",
        payload.task_id,
        payload.pm_round_id,
        payload.result_id,
      ),
      payload_json: JSON.stringify(payload),
    });
  }

  private outboxDispatcher: ResultOutboxDispatcher | null = null;

  /** 推送接收人候选（启用账号；管理页下拉）。 */
  listRecipients(): Array<{ userId: string; displayName: string; isAdmin: boolean }> {
    if (this.listRecipientsImpl) return this.listRecipientsImpl();
    return [{ userId: "admin", displayName: "管理员", isAdmin: true }];
  }

  /** 更新配置；重启调度器使新配置生效。返回 masked 视图。 */
  applySettings(next: TaskPlatformSettings): { enabled: boolean; baseUrl: string; apiKeyMasked: string; pollIntervalMs: number; batchSize: number; recipientUserId: string } {
    const previousRecipient = this.settings.recipientUserId;
    saveSettings(this.configStore, next);
    this.settings = next;
    // 接收人切换：既有同步项目 owner 迁移到新接收人（否则新账号看不到任何项目/任务，
    // 且下次建项目会撞上"已被其他用户占用"）。幂等，仅变更时执行。
    if (next.recipientUserId !== previousRecipient) {
      this.transferSyncProjects(next.recipientUserId || "admin");
    }
    this.stop();
    this.service = null;
    // outbox 投递目标（baseUrl/apiKey）可能变化：停旧的心跳，配置齐时换新通道重启。
    if (this.outboxScheduler) { this.outboxScheduler.stop(); this.outboxScheduler = null; this.outboxDispatcher = null; }
    if (next.enabled && next.baseUrl && next.apiKey) {
      this.service = buildIngestionService(next, this.store, this.bridge);
      this.start();
      const pair = this.buildOutboxScheduler(next);
      this.outboxScheduler = pair.scheduler;
      this.outboxDispatcher = pair.dispatcher;
      pair.scheduler.start();
    }
    return this.describe();
  }

  /** 当前配置中的原 Key（仅服务端内存；路由层用于"省略 Key = 保留原值"语义，绝不回显）。 */
  currentApiKey(): string {
    return this.settings.apiKey;
  }

  describe(): { enabled: boolean; baseUrl: string; apiKeyMasked: string; pollIntervalMs: number; batchSize: number; recipientUserId: string } {
    return {
      enabled: this.settings.enabled,
      baseUrl: this.settings.baseUrl,
      apiKeyMasked: maskApiKey(this.settings.apiKey),
      pollIntervalMs: this.settings.pollIntervalMs,
      batchSize: this.settings.batchSize,
      recipientUserId: this.settings.recipientUserId,
    };
  }

  start(): void {
    if (this.timer !== null) return;
    if (!this.service) return;
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.settings.pollIntervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    // 拉取停止时结果投递心跳一并停止（组件卸载 effect 走这里；applySettings 单独停 outbox）。
    if (this.outboxScheduler) { this.outboxScheduler.stop(); this.outboxScheduler = null; this.outboxDispatcher = null; }
  }

  /** 手动触发一轮（与自动轮询共用服务实例 + 防重入锁）。 */
  async syncNow(): Promise<{ ran: boolean; message: string }> {
    if (!this.service) {
      // 未启用时允许一次性运行（配置临时生效），不入常驻调度
      const settings = loadSettings(this.configStore);
      if (!settings.baseUrl || !settings.apiKey) {
        return { ran: false, message: "尚未配置任务平台地址或凭据" };
      }
      const oneShot = buildIngestionService(settings, this.store, this.bridge);
      return await this.runService(oneShot, "manual");
    }
    return await this.runService(this.service, "manual");
  }

  /** 连接测试：只读探测目录接口（不写任何状态）。 */
  async ping(): Promise<{ ok: boolean; subCode: string; message: string }> {
    const settings = loadSettings(this.configStore);
    if (!settings.baseUrl || !settings.apiKey) {
      return { ok: false, subCode: "NOT_CONFIGURED", message: "尚未配置任务平台地址或凭据" };
    }
    const client = new TaskPlatformClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, maxAttempts: 1 });
    const result = await client.ping();
    return {
      ok: result.ok,
      subCode: result.subCode,
      message: result.ok ? "连接成功，凭据有效" : `连接失败：${result.subCode}`,
    };
  }

  /** 重建事件游标：清空后下一轮从最早事件重放（已入库内容靠幂等键保护）。 */
  resetCursor(): void {
    this.store.setIngestCursor("");
  }

  /** 清除项目下演示种子（切换真数据源的动作）。bridge 已解包 changes，直接返回数字。 */
  clearDemo(projectId: string): number {
    return this.bridge.clearDemo(projectId);
  }

  /** 同步下发服务凭据（客户端本地服务持有）；缺失时自动生成并持久化。 */
  ensureServiceKey(): string {
    const KEY = "task_platform_service_key";
    const existing = this.configStore.get(KEY);
    if (existing) return existing;
    const key = PlatformTaskSyncService.issueServiceKey();
    this.configStore.set(KEY, key);
    return key;
  }

  /** 轮换服务凭据（管理页操作；旧 Key 立即失效，客户端需更新）。 */
  rotateServiceKey(): string {
    const key = PlatformTaskSyncService.issueServiceKey();
    this.configStore.set("task_platform_service_key", key);
    return key;
  }

  /** 读取当前服务凭据（非轮换；客户端配置用）。无 Key 时自动生成（幂等，不失效既有 Key）。 */
  currentServiceKey(): string {
    return this.ensureServiceKey();
  }

  /** 同步下发服务（面向客户端本地服务的增量下发/状态登记）。 */
  getSyncService(db: import("node:sqlite").DatabaseSync): PlatformTaskSyncService {
    const recipient = () => loadSettings(this.configStore).recipientUserId || null;
    return new PlatformTaskSyncService(db, recipient);
  }

  /** 校验客户端同步凭据。 */
  verifySyncKey(provided: string | undefined): boolean {
    const stored = this.configStore.get("task_platform_service_key");
    return PlatformTaskSyncService.verifyServiceKey(provided ?? "", stored ?? "");
  }

  private async tickOnce(): Promise<void> {
    if (!this.service) return;
    await this.runService(this.service, "auto");
  }

  private async runService(service: IngestionService, trigger: "auto" | "manual"): Promise<{ ran: boolean; message: string }> {
    if (this.ticking) return { ran: false, message: "上一轮拉取仍在进行中" };
    this.ticking = true;
    try {
      const summary = await service.runOnce();
      this.lastRunAt = new Date().toISOString();
      this.lastError = null;
      return {
        ran: true,
        message: `事件 ${summary.polled_events} 条（新 ${summary.new_events}）· 包入库 ${summary.packages_received} · 激活 ${summary.packages_activated} · 失败 ${summary.packages_failed}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      if (trigger === "manual") return { ran: true, message: `拉取失败：${message}` };
      console.error("[task-platform] scheduled ingestion failed:", message);
      return { ran: true, message: `拉取失败：${message}` };
    } finally {
      this.ticking = false;
    }
  }
}

export type { TaskPlatformStore, SqliteTaskPlatformStore };
