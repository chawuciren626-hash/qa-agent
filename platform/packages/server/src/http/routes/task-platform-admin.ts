/**
 * 任务平台集成管理路由（对接方案 §4 P6 管理面）：
 *
 * GET    /api/admin/task-platform/settings      查看（API Key 脱敏）
 * PUT    /api/admin/task-platform/settings      配置（校验通过才写；启用即热启调度器）
 * POST   /api/admin/task-platform/ping          连接测试（凭据 + 目录只读探测）
 * POST   /api/admin/task-platform/sync-now      手动拉取一轮（与自动轮询共用实例防重入）
 * GET    /api/admin/task-platform/status        运行观测（最近拉取/最近错误/游标）
 * POST   /api/admin/task-platform/reset-cursor  重建事件游标（从最早可用事件重放，幂等保护）
 * DELETE /api/admin/task-platform/demo/:projectId 清除项目下演示种子（真数据接通后的切换动作）
 *
 * 写操作全部审计（admin audit log）；API Key 不回显明文。
 * 路由文件不承载业务逻辑：装配在 modules/task-platform.ts（接线层），本文件只做 HTTP 适配。
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { requireHuman } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson } from "../validate.js";
import type { IngestionScheduler } from "../../integrations/task-platform/runtime.js";
import { clampSettingsInput } from "../../integrations/task-platform/runtime.js";

export interface TaskPlatformAdminDeps {
  scheduler: IngestionScheduler;
  /** 审计（actor, action, summary）。 */
  audit: (actor: string, action: string, summary: string) => void;
}

export function taskPlatformAdminRoutes(deps: TaskPlatformAdminDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // 管理面：仅管理员 + 必须真人登录（同 admin-settings 的闸；API token 拒绝）
  app.use("*", async (c, next) => {
    requireHuman(c);
    if (!c.var.user.isAdmin) {
      throw new HttpError(403, "admin_required", "只有管理员可以操作任务平台集成配置。");
    }
    await next();
  });

  app.get("/settings", async c => {
    return c.json({ settings: deps.scheduler.describe() });
  });

  app.put("/settings", async c => {
    const body = await readJson(c);
    const current = deps.scheduler.describe();
    const next = clampSettingsInput({
      enabled: body.enabled === true,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : current.baseUrl,
      // 省略/空 Key = 保留服务端已存原值（脱敏回显后原样提交的场景）；审阅意见 3
      apiKey: typeof body.apiKey === "string" && body.apiKey ? body.apiKey : deps.scheduler.currentApiKey(),
      pollIntervalMs: body.pollIntervalMs,
      batchSize: body.batchSize,
      recipientUserId: body.recipientUserId,
    });
    const applied = deps.scheduler.applySettings(next);
    deps.audit(c.var.user.userId, "task_platform_settings", `任务平台集成配置更新：enabled=${next.enabled} baseUrl=${next.baseUrl} recipient=${next.recipientUserId || "admin"}`);
    return c.json({ settings: applied });
  });

  /** 推送接收人候选：启用账号列表（管理后台用户管理同源；前端下拉）。 */
  app.get("/recipients", async c => {
    return c.json({ recipients: deps.scheduler.listRecipients() });
  });

  app.post("/ping", async c => {
    const result = await deps.scheduler.ping();
    deps.audit(c.var.user.userId, "task_platform_ping", `任务平台连接测试：ok=${result.ok} subCode=${result.subCode}`);
    return c.json(result);
  });

  app.post("/sync-now", async c => {
    const result = await deps.scheduler.syncNow();
    deps.audit(c.var.user.userId, "task_platform_sync", `手动拉取：${result.message}`);
    return c.json(result);
  });

  app.get("/status", async c => {
    return c.json({
      settings: deps.scheduler.describe(),
      lastRunAt: deps.scheduler.lastRunAt,
      lastError: deps.scheduler.lastError,
    });
  });

  app.post("/reset-cursor", async c => {
    deps.scheduler.resetCursor();
    deps.audit(c.var.user.userId, "task_platform_cursor_reset", "任务平台事件游标重建（从最早可用事件重放）");
    return c.json({ ok: true, message: "游标已清空，下一轮拉取将从最早事件重放（已入库内容由幂等键保护）" });
  });

  app.delete("/demo/:projectId", async c => {
    const projectId = c.req.param("projectId");
    const cleared = deps.scheduler.clearDemo(projectId);
    deps.audit(c.var.user.userId, "task_platform_demo_clear", `清除项目 ${projectId} 演示种子 ${cleared} 条`);
    return c.json({ cleared });
  });

  /** 同步服务凭据（客户端本地服务配置用）；轮换后旧 Key 立即失效。 */
  app.post("/service-key/rotate", async c => {
    const key = deps.scheduler.rotateServiceKey();
    deps.audit(c.var.user.userId, "task_platform_key_rotate", "同步服务凭据已轮换");
    return c.json({ serviceKey: key });
  });

  /** 读取当前同步服务凭据（非轮换；无 Key 时自动生成，供客户端 client-sync.json 配置）。 */
  app.get("/service-key", async c => {
    const key = deps.scheduler.currentServiceKey();
    deps.audit(c.var.user.userId, "task_platform_key_read", "读取同步服务凭据（客户端配置）");
    return c.json({ serviceKey: key });
  });

  return app;
}

// HttpError re-export guard: keep route file free of business logic while preserving
// the 4xx semantics used by readJson/clamp.
export { HttpError };
