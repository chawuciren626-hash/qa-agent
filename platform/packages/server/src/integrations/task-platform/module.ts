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
import { IngestionScheduler, type TaskPlatformConfigStore } from "./runtime.js";
import { taskPlatformAdminRoutes } from "../../http/routes/task-platform-admin.js";

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
}

@Component()
export class PlatformTaskBridgeComponent implements TaskPlatformBridgeProvider {
  @Use() private readonly db!: Db;
  @Use() private readonly projectService!: ProjectLifecycle;
  @Use() private readonly users!: Users;
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
          const owner = users.findById("admin");
          if (!owner) throw new Error("admin 用户不存在，无法创建平台同步项目");
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
  private scheduler: IngestionScheduler | null = null;

  setup({ effect }: ClassCtx) {
    const store = this.storeHolder.getStore();
    const bridge = this.bridgeHolder.getBridge();
    this.scheduler = new IngestionScheduler({
      configStore: new SettingsConfigStore(this.settings),
      store,
      bridge,
    });
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
    ],
  },
})
export class TaskPlatformAdminRoutes {
  @Use() private readonly db!: Db;
  @Use() private readonly runtime!: TaskPlatformSchedulerProvider;
  @Bind("task-platform.admin") adminRoutes!: Hono<AppEnv>;

  setup() {
    const runtime = this.runtime;
    const db = this.db as unknown as import("node:sqlite").DatabaseSync;
    this.adminRoutes = taskPlatformAdminRoutes({
      scheduler: runtime.getScheduler(),
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
export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_{2,}/g, "_");
  return slug || "line";
}

/** The suffix keeps tenant/line identity even when normalization or truncation collides. */
export function syncProjectId(tenantId: string, productLineId: string): string {
  const hash = createHash("sha256").update(JSON.stringify([tenantId, productLineId])).digest("hex").slice(0, 16);
  return `sync_${slugify(productLineId).slice(0, 36)}_${hash}`;
}
