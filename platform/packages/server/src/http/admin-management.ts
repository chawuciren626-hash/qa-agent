import { ADMIN_ASSISTANT_PROJECT } from "../services/project-service.js";

/** Dedicated project whose assistant can use authenticated administration tools. */
export const ADMIN_ASSISTANT_PROJECT_ID = ADMIN_ASSISTANT_PROJECT;

/** Routes that expose the administrator's shared plugin configuration. */
export function adminPluginManagementPath(method: string, path: string): boolean {
  if (method === "GET" && (
    path === "/api/plugins" || path === "/api/plugins/registry" ||
    /^\/api\/plugins\/registry\/(readme|archive)$/.test(path) ||
    /^\/api\/plugins\/[^/]+\/(files|readme|archive)$/.test(path)
  )) return true;
  if (path === "/api/admin/plugin-config") return method === "GET" || method === "PUT";
  return path === "/api/admin/plugin-config/action" && method === "POST";
}
