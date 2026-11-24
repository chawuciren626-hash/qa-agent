/**
 * 任务平台集成模块：把 integrations/task-platform 的传输层装配进组件树。
 *
 * 职责（对接方案 §4 接线层；README §0 的"剩余待做"）：
 * - TaskPlatformRepo：SqliteTaskPlatformStore 组件（@Use db）；
 * - PlatformTaskBridgeComponent：PackageActivationHook 生产实现（写 platform_task_links
 *   列表真源 + qa_documents 不可变修订；同步项目建立走 ProjectService.createProject
 *   + project_management 的 source_type=sync 行）；
 * - TaskPlatformRuntime：配置（server_settings KV）+ IngestionScheduler（轮询/手动同步/
 *   连接测试/游标重建/清 demo）；
 * - TaskPlatformAdminRoutes：/api/admin/task-platform 管理面（审计复用 admin audit 表）。
 *
 * Startup.start() 由 platform.ts 的 Startup 组件调用（enabled 才有 interval）。
 */
import {
  Bind,
  Component,
  Interface,
  Module,
  Use,
} from "@prismshadow/penguin-core/kernel";
import type { ClassCtx, Opaque } from "@prismshadow/penguin-core/kernel";
import type { Hono } from "hono";
import { createHash } from "node:crypto";

import type { Db } from "../../hmr/capabilities.js";
import type { AppEnv } from "../../auth/middleware.js";
import type { Settings } from "../../mechanisms/settings.js";
import type { Users } from "../../mechanisms/identity.js";
import type { ProjectLifecycle } from "../../mechanisms/projects.js";
import type { UserRow } from "../../db/repos/users.js";
import { SqliteTaskPlatformStore, type TaskPlatformStore } from "./store.js";
import { PlatformTaskBridge } from "./platform-task-bridge.js";
import { IngestionScheduler, loadSettings, type TaskPlatformConfigStore } from "./runtime.js";
import { taskPlatformAdminRoutes } from "../../http/routes/task-platform-admin.js";
import { taskPlatformSyncRoutes } from "../../http/routes/task-platform-sync.js";

/** Settings 机制适配（server_settings KV）。 */
class SettingsConfigStore implements TaskPlatformConfigStore {
  constructor(private readonly settings: Settings) {}
  get(key: string): string | null {
    return this.settings.get(key);
  }
  set(key: string, value: string): void {
    this.settings.set(key, value);
  }
  delete(key: string): void {
    this.settings.set(key, "");
  }
}

@Interface()
export abstract class TaskPlatformRepository {
  abstract getStore(): TaskPlatformStore;
}

@Component()
export class TaskPlatformRepo implements TaskPlatformRepository {
  @Use() private readonly db!: Db;
  private store: TaskPlatformStore | null = null;

  setup() {
    this.store = new SqliteTaskPlatformStore(this.db as unknown as import("node:sqlite").DatabaseSync);
  }

  getStore(): TaskPlatformStore {
    if (!this.store) throw new Error("task-platform repository not ready");
    return this.store;
  }
}

@Interface()
export abstract class TaskPlatformBridgeProvider {
  abstract getBridge(): Opaque<"PlatformTaskBridge", PlatformTaskBridge>;
  /** 接收人读取器注入（runtime setup 调用；读 settings.recipientUserId）。 */
  abstract setRecipientResolver(resolver: (() => string) | null): void;
}

@Component()
export class PlatformTaskBridgeComponent implements TaskPlatformBridgeProvider {
  @Use() private readonly db!: Db;
  @Use() private readonly projectService!: ProjectLifecycle;
  @Use() private readonly users!: Users;
  /** 接收人读取器（runtime 注入，读 settings.recipientUserId）；空 = admin。 */
  recipientResolver: (() => string) | null = null;
  private bridge: PlatformTaskBridge | null = null;

  setup() {
    const db = this.db;
    const store = new SqliteTaskPlatformStore(db as unknown as import("node:sqlite").DatabaseSync);
    const projectService = this.projectService;
    const users = this.users;
    this.bridge = new PlatformTaskBridge(
      {
        db: db as never,
        systemUserId: "admin",
        now: () => new Date(),
        createProject: async args => {
          const recipient = this.recipientResolver?.() || "admin";
          const owner = users.findById(recipient) ?? users.findById("admin");
          if (!owner) throw new Error("接收人用户不存在且 admin 缺失，无法创建平台同步项目");
          // SEMANTIC_ID_PATTERN 要求 ^[a-z][a-z0-9_]{1,63}$（无连字符）：外部 ID 中的
          // 连字符/其他字符统一映射为下划线，保证首次创建即合法（审阅意见 1）
          const projectId = syncProjectId(args.externalTenantId, args.externalProjectId);
          const existing = db.prepare("SELECT owner_user_id FROM projects WHERE project_id = ?")
            .get(projectId) as { owner_user_id: string } | undefined;
          if (existing && existing.owner_user_id !== owner.userId) {
            throw new Error(`同步项目 ID 已被其他用户占用: ${projectId}`);
          }
          if (!existing) await projectService.createProject(owner as UserRow, projectId, args.name);
          const managed = db.prepare("SELECT source_system_name, external_project_id FROM project_management WHERE project_id = ?")
            .get(projectId) as { source_system_name: string | null; external_project_id: string | null } | undefined;
          if (managed && (managed.source_system_name !== args.sourceSystem || managed.external_project_id !== args.externalProjectId)) {
            throw new Error(`同步项目 ID 与现有项目来源冲突: ${projectId}`);
          }
          // project_management 补 sync 来源行（与 managed-projects 创建路径同款语义）
          if (!managed) db.prepare(
            `INSERT INTO project_management (project_id, description, source_type, source_system_name, external_project_id, external_url)
             VALUES (?, ?, 'sync', ?, ?, ?)`,
          ).run(
            projectId,
            `任务平台同步项目（产品线：${args.name}）`,
            args.sourceSystem,
            args.externalProjectId,
            args.externalUrl,
          );
          return { projectId };
        },
      },
      store,
    );
  }

  getBridge(): Opaque<"PlatformTaskBridge", PlatformTaskBridge> {
    if (!this.bridge) throw new Error("task-platform bridge not ready");
    return this.bridge;
  }

  setRecipientResolver(resolver: (() => string) | null): void {
    this.recipientResolver = resolver;
  }
}

@Interface()
export abstract class TaskPlatformSchedulerProvider {
  abstract getScheduler(): Opaque<"IngestionScheduler", IngestionScheduler>;
}

@Component()
export class TaskPlatformRuntime implements TaskPlatformSchedulerProvider {
  @Use() private readonly settings!: Settings;
  @Use() private readonly storeHolder!: TaskPlatformRepository;
  @Use() private readonly bridgeHolder!: TaskPlatformBridgeProvider;
  @Use() private readonly users!: Users;
  private scheduler: IngestionScheduler | null = null;

  setup({ effect }: ClassCtx) {
    const store = this.storeHolder.getStore();
    const bridge = this.bridgeHolder.getBridge();
    this.scheduler = new IngestionScheduler({
      configStore: new SettingsConfigStore(this.settings),
      store,
      bridge,
    });
    // 推送接收人：bridge 建项目时读 settings.recipientUserId 做 owner；
    // admin 页下拉从启用账号列表选（Users 机制）。
    // 注意：setRecipientResolver 声明在 TaskPlatformBridgeProvider（provider 接口）上，
    // 经 provider 引用调用——不对 getBridge() 的 Opaque 返回值做类型断言（审阅 P0）。
    const settingsStore = new SettingsConfigStore(this.settings);
    this.bridgeHolder.setRecipientResolver(() => loadSettings(settingsStore).recipientUserId);
    const users = this.users;
    RUNTIME_USERS_REF.list = () => users.list() as Array<{ userId: string; displayName: string | null; isAdmin: boolean }>;
    this.scheduler.listRecipientsImpl = () =>
      RUNTIME_USERS_REF.list().map(u => ({ userId: u.userId, displayName: u.displayName || u.userId, isAdmin: u.isAdmin }));
    if (this.settings.get("task_platform_autostart") !== "0") this.scheduler.start();
    effect(() => this.scheduler?.stop());
  }

  getScheduler(): Opaque<"IngestionScheduler", IngestionScheduler> {
    if (!this.scheduler) throw new Error("task-platform runtime not ready");
    return this.scheduler;
  }
}

@Component({
  contributes: {
    "HttpModule.routes": [
      {
        id: "task-platform.admin",
        prefix: "/api/admin/task-platform",
        auth: "user",
        order: 50,
      },
      {
        id: "task-platform.sync",
        prefix: "/api/sync/v1",
        // none = 不装用户会话/API token 闸；路由内部以 Bearer 服务凭据自鉴权
        // （requireServiceKey，客户端本地服务持久持有——与任务平台对接凭据同模式）。
        auth: "none",
        order: 51,
      },
    ],
  },
})
export class TaskPlatformAdminRoutes {
  @Use() private readonly db!: Db;
  @Use() private readonly runtime!: TaskPlatformSchedulerProvider;
  @Bind("task-platform.admin") adminRoutes!: Hono<AppEnv>;
  @Bind("task-platform.sync") syncRoutes!: Hono<AppEnv>;

  setup() {
    const runtime = this.runtime;
    const db = this.db as unknown as import("node:sqlite").DatabaseSync;
    const scheduler = runtime.getScheduler();
    // 服务凭据激活：缺失时自动生成并持久化（settings.task_platform_service_key），
    // 客户端本地服务持此 Key 调 /api/sync/v1；无 Key 则同步下发一律 401。
    scheduler.ensureServiceKey();
    this.adminRoutes = taskPlatformAdminRoutes({
      scheduler,
      audit: (actor: string, action: string, summary: string) => {
        try {
          // admin 审计与 auth.ts 登录审计同表（public_admin_audit）；表不存在时静默降级
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_admin_audit'").get()) return;
          db.prepare("INSERT INTO public_admin_audit(actor,action,resource_id,created_at) VALUES (?,?,?,?)")
            .run(actor, action, summary.slice(0, 120), new Date().toISOString());
        } catch {
          // 审计失败不阻断业务
        }
      },
    });
    // 同步下发面（客户端本地服务持服务凭据 Bearer 调用；路由内部自鉴权，不走用户会话）
    this.syncRoutes = taskPlatformSyncRoutes({
      sync: scheduler.getSyncService(db),
      verifyKey: provided => scheduler.verifySyncKey(provided),
      // C1 结果接收：入 task_platform_result_outbox（幂等 result_id+version）；
      // 任务平台回传由 ResultOutboxScheduler 心跳负责（IngestionScheduler 内装配）。
      receiveTestResult: payload => scheduler.enqueueTestResult(payload),
    });
  }
}

/**
 * 根树挂载点：admin 路由的 Hono 子应用通过 @Bind 暴露；接线进 app.ts 的 admin 面
 * （app.route("/api/admin/task-platform", …)）。Startup 已在根树（platform.ts），
 * 调度器 start() 由 TaskPlatformRuntime.setup 内触发（enabled 才有 interval）。
 */
@Module({
  children: [TaskPlatformRepo, PlatformTaskBridgeComponent, TaskPlatformRuntime, TaskPlatformAdminRoutes],
  exports: [],
})
export class TaskPlatformIntegrationModule {}

/** 同步项目 ID 派生：外部 ID（UUID/编码/中文名）→ SEMANTIC_ID_PATTERN 合法段（^[a-z][a-z0-9_]{1,63}$）。 */
export function usersList(settings: Settings): Array<{ userId: string; displayName: string | null; isAdmin: boolean }> {
  void settings;
  // Users 机制由组件树注入（TaskPlatformRuntime.users.list()）；此处经闭包访问，见 setup。
  return RUNTIME_USERS_REF.list();
}

/** setup 时回填的 Users 机制引用（避免 helper 签名侵入组件结构）。 */
const RUNTIME_USERS_REF: { list: () => Array<{ userId: string; displayName: string | null; isAdmin: boolean }> } = {
  list: () => [],
};

export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_{2,}/g, "_");
  return slug || "line";
}

/** The suffix keeps tenant/line identity even when normalization or truncation collides. */
export function syncProjectId(tenantId: string, productLineId: string): string {
  const hash = createHash("sha256").update(JSON.stringify([tenantId, productLineId])).digest("hex").slice(0, 16);
  return `sync_${slugify(productLineId).slice(0, 36)}_${hash}`;
}
