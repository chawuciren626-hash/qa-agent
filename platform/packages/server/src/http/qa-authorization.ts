import type { AccountClientGate } from "../auth/runtime-state.js";
/** Product permissions are enforced before both HTTP and socket route dispatch. */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/middleware.js";
import type { Access } from "../mechanisms/projects.js";
import { HttpError } from "./errors.js";
import { qaEnabled } from "../services/qa-engine.js";

export function qaAuthorization(access: Access, central?:AccountClientGate): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!qaEnabled || !c.var.user) return next();
    let path: string;
    try { path = decodeURIComponent(c.req.path); }
    catch { throw new HttpError(400, "invalid_path", "Invalid request path."); }
    const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (c.var.user.isAdmin) {
      const project = /^\/api\/projects\/([^/]+)\/agents\/qa(?:\/|$)/.exec(path);
      if (write && project && access.requireProjectAccess(c.var.user.userId, project[1]!).ownerUserId !== c.var.user.userId) {
        throw new HttpError(403, "project_owner_required", "管理员不能代替项目创建者修改测试资料或确认规则。");
      }
      return next();
    }
    const deny = () => { throw new HttpError(403, "qa_admin_required", "能力由管理员统一配置，用户可读取和使用。"); };
    // Central identity adds module and resource checks; local route ownership rules
    // remain the authority for each project operation.
    if (central) await central.authorizeUserPath(c.var.user.userId, path, c.req.method);
    if (/^\/(?:api\/machines|server)(?:\/|$)/.test(path)) deny();
    const match = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) return next();
    const [, projectId, tail = ""] = match;
    // Check membership first so an outsider sees the same 404 for every project resource.
    const membership = access.requireProjectAccess(c.var.user.userId, projectId!);
    const own = () => membership.ownerUserId === c.var.user.userId;
    if (/^(?:usage|benchmarks|machines)(?:\/|$)/.test(tail)) deny();
    if (write && /^agents(?:\/[^/]+)?\/?$/.test(tail)) deny();
    if (write && /^agents\/qa\/initialize$/.test(tail)) {
      if (!own()) deny(); // Installs the fixed testing template, never arbitrary role definitions.
      return next();
    }
    if (write && /^models(?:\/|$)/.test(tail) && !own()) deny();
    // Personal uploads and round selections are not open to users. Keep historical
    // resources readable; capability changes go through administrator configuration.
    if (/^agents\/qa\/personal-resources(?:\/|$)/.test(tail)) {
      if (write) deny();
      return next();
    }
    const agent = /^agents\/([^/]+)\/(.*)$/.exec(tail);
    if (agent && write) {
      const action = agent[2]!;
      if (/^(?:skills|hooks)\/template-placeholder$/.test(action)) deny();
      // Personal library data is already scoped by authenticated account inside its service.
      if (action.startsWith("memory/library")) return next();
      // Legacy mutation endpoints write shared Agent capabilities, not personal resources.
      if (/^(?:skills|plugins|hooks|mcp-servers)(?:\/|$)/.test(action)) deny();
      if (/^schedules(?:\/|$)/.test(action)) {
        if (!own()) deny();
      } else if (/^(?:config|prompt|import|export|api|vault|memory|workbenches)(?:\/|$)/.test(action)) {
        deny();
      }
    }
    return next();
  };
}
