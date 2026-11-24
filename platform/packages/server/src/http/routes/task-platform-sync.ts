/**
 * 服务端 → 客户端同步下发路由（同步层方案 阶段 A）。
 *
 * 挂载：/api/sync/v1（与任务平台对接 /api/admin/task-platform、既有 QA 用户面分路由）。
 * 鉴权：Bearer 服务凭据（客户端本地服务持久持有；管理路由 /api/admin/task-platform 签发与配置）。
 * 端点：
 *   GET  /api/sync/v1/platform-tasks?user=<中央userId>&since=<updated_at>&limit=<n>  增量下发
 *   GET  /api/sync/v1/platform-tasks/:linkId/package?user=<中央userId>               完整包按需
 *   POST /api/sync/v1/platform-tasks/:linkId/state                                   状态登记
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson } from "../validate.js";
import { PlatformTaskSyncService, type StateRegistrationResult } from "../../integrations/task-platform/client-sync-service.js";

export interface TaskPlatformSyncRouteDeps {
  sync: PlatformTaskSyncService;
  /** 服务凭据（settings.task_platform_service_key；客户端持久持有）。 */
  verifyKey: (provided: string | undefined) => boolean;
}

function requireServiceKey(c: { req: { header(name: string): string | undefined } }, deps: TaskPlatformSyncRouteDeps): void {
  const provided = c.req.header("authorization");
  if (!provided?.startsWith("Bearer ") || !deps.verifyKey(provided.slice(7).trim())) {
    throw new HttpError(401, "sync_auth_failed", "同步凭据无效。");
  }
}

function requireUserId(c: { req: { query(name: string): string | undefined } }): string {
  const userId = c.req.query("user");
  if (!userId || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
    throw new HttpError(400, "sync_user_required", "缺少或非法的 user 参数（中央用户 ID）。");
  }
  return userId;
}

export function taskPlatformSyncRoutes(deps: TaskPlatformSyncRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    requireServiceKey(c, deps);
    await next();
  });

  app.get("/platform-tasks", async c => {
    const userId = requireUserId(c);
    const since = c.req.query("since") || null;
    const limit = Number(c.req.query("limit") ?? 50);
    const page = deps.sync.listIncremental(userId, since, Number.isFinite(limit) ? limit : 50);
    return c.json(page);
  });

  app.get("/platform-tasks/:linkId/package", async c => {
    const userId = requireUserId(c);
    const linkId = c.req.param("linkId");
    const pkg = deps.sync.getPackagePayload(linkId, userId);
    if (!pkg) throw new HttpError(404, "sync_package_not_found", "任务包不存在或无权访问。");
    return c.json({ package: pkg });
  });

  app.post("/platform-tasks/:linkId/state", async c => {
    const body = await readJson(c);
    const status = typeof body.status === "string" ? body.status : "";
    const userId = typeof body.user === "string" && body.user ? body.user : requireUserId(c);
    const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
    const result: StateRegistrationResult = deps.sync.registerState(c.req.param("linkId"), status, userId, expectedRevision);
    if (!result.applied) throw new HttpError(409, "sync_state_conflict", result.reason ?? "状态登记未生效。");
    return c.json(result);
  });

  return app;
}
