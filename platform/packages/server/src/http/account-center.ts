import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/** Central deployment: identity, public configuration and UI preferences only. */
export function accountCenterPath(method: string, path: string): boolean {
  if (path.startsWith("/api/control/") && ["GET", "POST", "PUT", "DELETE"].includes(method)) return true;
  if (path === "/api/auth/admin-login" && method === "POST") return true;
  if (path === "/api/account-client/config" && method === "GET") return true;
  if (method === "GET" && /^\/(?:admin|user)(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(path)) return true;
  if (method === "GET" && ["/api/install", "/api/auth/registration", "/api/me", "/api/me/prefs", "/api/admin/users"].includes(path)) return true;
  if (method === "POST" && ["/api/auth/login", "/api/auth/logout", "/api/auth/register", "/api/me/sessions/revoke", "/api/admin/users"].includes(path)) return true;
  if (method === "PUT" && ["/api/me/password", "/api/me/profile", "/api/me/prefs"].includes(path)) return true;
  if (method === "PUT" && /^\/api\/admin\/users\/[a-z][a-z0-9_]{1,31}\/status$/.test(path)) return true;
  if (method === "POST" && /^\/api\/admin\/users\/[a-z][a-z0-9_]{1,31}\/(password|sessions\/revoke)$/.test(path)) return true;
  return method === "GET" && (["/", "/login", "/accounts", "/favicon.ico", "/penguin-logo.svg", "/aith-logo.svg"].includes(path) || /^\/assets\/[a-zA-Z0-9._/-]+$/.test(path));
}

export function accountCenterGate(enabled: boolean | undefined): MiddlewareHandler {
  const cap = bodyLimit({ maxSize: 2 * 1024 * 1024 });
  return async (c, next) => {
    if (!enabled) return next();
    if (!accountCenterPath(c.req.method, c.req.path)) return c.json({ error: { code: "account_center_only", message: "此服务管理账号和公共配置；项目、任务和文件请通过 Web 用户视图连接本机服务。" } }, 404);
    return cap(c, next);
  };
}
