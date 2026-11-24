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
import { SqliteTaskPlatformStore, type TaskPlatformStore } from "./store.js";

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
  /** 接收人候选提供者（接线层注入 Users 机制）；未注入时只返回 admin。 */
  listRecipientsImpl: (() => Array<{ userId: string; displayName: string; isAdmin: boolean }>) | null = null;
  /** 运行观测（admin 页展示）。 */
  lastRunAt: string | null = null;
  lastError: string | null = null;

  constructor(args: {
    configStore: TaskPlatformConfigStore;
    store: TaskPlatformStore;
    bridge: PlatformTaskBridge;
  }) {
    this.configStore = args.configStore;
    this.store = args.store;
    this.bridge = args.bridge;
    this.settings = loadSettings(args.configStore);
    if (this.settings.enabled && this.settings.baseUrl && this.settings.apiKey) {
      this.service = buildIngestionService(this.settings, this.store, this.bridge);
    }
  }

  /** 推送接收人候选（启用账号；管理页下拉）。 */
  listRecipients(): Array<{ userId: string; displayName: string; isAdmin: boolean }> {
    if (this.listRecipientsImpl) return this.listRecipientsImpl();
    return [{ userId: "admin", displayName: "管理员", isAdmin: true }];
  }

  /** 更新配置；重启调度器使新配置生效。返回 masked 视图。 */
  applySettings(next: TaskPlatformSettings): { enabled: boolean; baseUrl: string; apiKeyMasked: string; pollIntervalMs: number; batchSize: number; recipientUserId: string } {
    saveSettings(this.configStore, next);
    this.settings = next;
    this.stop();
    this.service = null;
    if (next.enabled && next.baseUrl && next.apiKey) {
      this.service = buildIngestionService(next, this.store, this.bridge);
      this.start();
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
