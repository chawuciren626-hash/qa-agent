import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ADMIN_ASSISTANT_PROJECT } from "../services/project-service.js";

/** The administrator's assistant runs in one isolated central Project. */
export const CENTRAL_ASSISTANT_PROJECT = ADMIN_ASSISTANT_PROJECT;

export function centralAssistantPath(method: string, path: string): boolean {
  if (path === "/api/events") return method === "GET";
  if (path === "/api/projects") return method === "GET" || method === "POST";
  if (path.startsWith(`/api/projects/${CENTRAL_ASSISTANT_PROJECT}/`)) return true;
  return /^\/api\/sessions\/[a-zA-Z0-9_-]+(?:\/.*)?$/.test(path);
}

/** Upstream plugin reads and schema-driven settings, behind the administrator guard. */
export function accountCenterPluginPath(method: string, path: string): boolean {
  if (method === "GET" && (
    path === "/api/plugins" || path === "/api/plugins/registry" ||
    /^\/api\/plugins\/registry\/(readme|archive)$/.test(path) ||
    /^\/api\/plugins\/[^/]+\/(files|readme|archive)$/.test(path)
  )) return true;
  if (path === "/api/admin/plugin-config") return method === "GET" || method === "PUT";
  return path === "/api/admin/plugin-config/action" && method === "POST";
}

/** Central deployment: identity, public configuration and the administrator's assistant. */
export function accountCenterPath(method: string, path: string): boolean {
  if (centralAssistantPath(method, path) || accountCenterPluginPath(method, path)) return true;
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
    if (!accountCenterPath(c.req.method, c.req.path)) return c.json({ error: { code: "account_center_only", message: "此服务仅开放服务端管理、管理员助手及其专属会话接口。" } }, 404);
    return centralAssistantPath(c.req.method, c.req.path) ? next() : cap(c, next);
  };
}
