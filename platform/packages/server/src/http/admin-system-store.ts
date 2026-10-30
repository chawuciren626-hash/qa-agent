import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";

export const ADMIN_MENU_KEYS = ["overview", "chat", "agents", "models", "plugins", "skills", "users", "roles", "menus", "audit"] as const;
export type AdminMenuKey = typeof ADMIN_MENU_KEYS[number];
export type AdminMenuItem = { key: string; name: string; path: string; group: "main" | "sys"; icon: string; color: string; visible: boolean; builtin: boolean };
const names = ["概览", "管理员助手", "Agent管理", "模型配置", "插件管理", "技能管理", "用户管理", "角色管理", "菜单管理", "操作日志"];
const colors = ["#5a8dea", "#8a7ff0", "#2866a4", "#36ae83", "#dea52e", "#d85ca5", "#5a8dea", "#8a7ff0", "#98a3b3", "#36ae83"];
const systemKeys = new Set(["users", "roles", "menus", "audit"]);
const requiredKeys = new Set(["users", "roles", "menus"]);
const defaultMenus = (): AdminMenuItem[] => ADMIN_MENU_KEYS.map((key, index) => ({
  key, name: names[index]!, path: key === "chat" ? "/chat/new" : `/${key}`,
  group: systemKeys.has(key) ? "sys" : "main", icon: key, color: colors[index]!, visible: true, builtin: true,
}));
const invalid = (message: string): never => { throw new HttpError(400, "invalid_admin_system", message); };
const menuId = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

export class AdminSystemStore {
  constructor(private readonly db: DatabaseSync, private readonly audit: (actor: string, action: string, id: string) => void, private readonly modules: readonly string[]) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS public_roles(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,modules TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS public_role_members(user_id TEXT PRIMARY KEY,role_id TEXT NOT NULL REFERENCES public_roles(id));
      CREATE TABLE IF NOT EXISTS public_admin_menus(id INTEGER PRIMARY KEY CHECK(id=1),items TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS public_role_menus(id INTEGER PRIMARY KEY CHECK(id=1),items TEXT NOT NULL);
    `);
  }

  menuItems(): AdminMenuItem[] {
    const row = this.db.prepare("SELECT items FROM public_admin_menus WHERE id=1").get();
    if (!row) return defaultMenus();
    try {
      const saved = JSON.parse(String(row.items)) as unknown;
      if (!Array.isArray(saved)) return defaultMenus();
      // The old menu format only stored key and visibility. Keep its order and switches.
      if (saved.every(item => item && typeof item === "object" && !("name" in item))) {
        const defaults = defaultMenus();
        const byKey = new Map(defaults.map(item => [item.key, item]));
        return saved.flatMap(item => {
          const original = byKey.get(item.key);
          return original ? [{ ...original, visible: requiredKeys.has(item.key) ? true : item.visible !== false }] : [];
        });
      }
      return this.validMenus(saved);
    } catch { return defaultMenus(); }
  }

  private validMenus(value: unknown): AdminMenuItem[] {
    if (!Array.isArray(value) || value.length < ADMIN_MENU_KEYS.length || value.length > 60) return invalid("菜单列表不完整。");
    const seen = new Set<string>();
    const items = value.map(raw => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("菜单格式无效。");
      const item = raw as Record<string, unknown>;
      if (!menuId(item.key) || seen.has(item.key as string) ||
          typeof item.name !== "string" || !item.name.trim() || item.name.length > 24 ||
          typeof item.path !== "string" || !/^\/[a-zA-Z0-9/_-]{0,120}$/.test(item.path) ||
          !["main", "sys"].includes(String(item.group)) ||
          typeof item.icon !== "string" || !menuId(item.icon) ||
          typeof item.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(item.color) ||
          typeof item.visible !== "boolean" || typeof item.builtin !== "boolean") return invalid("菜单字段无效。");
      seen.add(item.key as string);
      const builtin = ADMIN_MENU_KEYS.includes(item.key as AdminMenuKey);
      if (builtin !== item.builtin || (requiredKeys.has(item.key as string) && !item.visible)) return invalid("内置菜单不可删除，必要入口不可隐藏。");
      return { key: item.key as string, name: item.name.trim(), path: item.path, group: item.group as "main" | "sys",
        icon: item.icon as string, color: item.color as string, visible: item.visible, builtin: item.builtin };
    });
    if (ADMIN_MENU_KEYS.some(key => !seen.has(key))) return invalid("内置菜单不可删除。");
    return items;
  }

  setMenus(actor: string, value: unknown): AdminMenuItem[] {
    const items = this.validMenus(value);
    const old = this.menuItems();
    const removed = old.filter(item => !item.builtin && !items.some(next => next.key === item.key));
    const assigned = this.ordinaryMenus();
    this.db.prepare("INSERT INTO public_admin_menus(id,items) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET items=excluded.items").run(JSON.stringify(items));
    if (removed.length) this.db.prepare("INSERT INTO public_role_menus(id,items) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET items=excluded.items")
      .run(JSON.stringify(assigned.filter(key => !removed.some(item => item.key === key))));
    this.audit(actor, "menus", "admin_navigation");
    return items;
  }

  createMenu(actor: string, value: unknown) {
    const input = value as Partial<AdminMenuItem>;
    const items = this.menuItems();
    const key = `custom_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const next = this.setMenus(actor, [...items, { ...input, key, builtin: false }]);
    return next.find(item => item.key === key)!;
  }

  ordinaryMenus(): string[] {
    const row = this.db.prepare("SELECT items FROM public_role_menus WHERE id=1").get();
    const keys = this.menuItems().filter(item => item.group === "main" && item.visible).map(item => item.key);
    if (!row) return keys;
    try {
      const saved = JSON.parse(String(row.items));
      return Array.isArray(saved) ? saved.filter((key: unknown) => typeof key === "string" && this.menuItems().some(item => item.key === key && item.visible)) : keys;
    } catch { return keys; }
  }
  setOrdinaryMenus(actor: string, value: unknown): string[] {
    if (!Array.isArray(value) || value.some(key => typeof key !== "string") || new Set(value).size !== value.length) return invalid("菜单分配无效。");
    const all = new Set(this.menuItems().map(item => item.key));
    if (value.some(key => !all.has(key))) return invalid("包含不存在的菜单。");
    this.db.prepare("INSERT INTO public_role_menus(id,items) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET items=excluded.items").run(JSON.stringify(value));
    this.audit(actor, "role_menus", "ordinary");
    return value;
  }

  roleSummary() {
    const users = this.db.prepare("SELECT user_id AS userId,is_admin AS isAdmin FROM users ORDER BY user_id").all();
    return { roles: [
      { id: "admin", name: "管理员", description: "拥有全部菜单与权限，不受菜单分配限制", members: users.filter(user => user.isAdmin).map(user => String(user.userId)), menus: this.menuItems().map(item => item.key) },
      { id: "ordinary", name: "普通用户", description: "按菜单分配结果使用工作台功能", members: users.filter(user => !user.isAdmin).map(user => String(user.userId)), menus: this.ordinaryMenus() },
    ], users };
  }
  assignUsers(actor: string, roleId: string, value: unknown) {
    if (!["admin", "ordinary"].includes(roleId) || !Array.isArray(value) || value.some(id => typeof id !== "string") || new Set(value).size !== value.length) return invalid("用户分配无效。");
    const users = this.db.prepare("SELECT user_id AS userId,is_admin AS isAdmin FROM users").all();
    const known = new Set(users.map(user => user.userId));
    if (value.some(id => !known.has(id))) return invalid("包含不存在的用户。");
    if (roleId === "ordinary" && value.includes("admin") || roleId === "admin" && !value.includes("admin")) return invalid("内置管理员账号必须保留管理员角色。");
    const selected = new Set(value);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const user of users) {
        const nextAdmin = roleId === "admin" ? selected.has(user.userId) : !selected.has(user.userId);
        this.db.prepare("UPDATE users SET is_admin=? WHERE user_id=?").run(nextAdmin ? 1 : 0, String(user.userId));
      }
      this.audit(actor, "role_assign", roleId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.roleSummary();
  }

  // Retain legacy role grants for existing users until their permissions are explicitly changed.
  roleModules(userId: string): string[] | null {
    const row = this.db.prepare("SELECT r.modules FROM public_role_members m JOIN public_roles r ON r.id=m.role_id WHERE m.user_id=?").get(userId);
    return row ? JSON.parse(String(row.modules)) as string[] : null;
  }
  members() { return this.db.prepare("SELECT user_id AS userId,role_id AS roleId FROM public_role_members ORDER BY user_id").all(); }
  saveRole(actor: string, value: unknown, id?: string) {
    const data = value as { name?: unknown; modules?: unknown };
    if (typeof data?.name !== "string" || !data.name.trim() || data.name.length > 40 ||
        !Array.isArray(data.modules) || data.modules.some(module => typeof module !== "string" || !this.modules.includes(module))) return invalid("角色名称或权限无效。");
    const roleId = id ?? randomUUID();
    const modules = [...new Set([...data.modules, "models"])];
    if (id && !this.db.prepare("SELECT 1 FROM public_roles WHERE id=?").get(id)) throw new HttpError(404, "role_missing", "角色不存在。");
    try {
      if (id) this.db.prepare("UPDATE public_roles SET name=?,modules=? WHERE id=?").run(data.name.trim(), JSON.stringify(modules), id);
      else this.db.prepare("INSERT INTO public_roles VALUES (?,?,?,?)").run(roleId, data.name.trim(), JSON.stringify(modules), new Date().toISOString());
    } catch { throw new HttpError(409, "role_exists", "角色名称已存在。"); }
    this.audit(actor, id ? "role_update" : "role_create", roleId);
    return { id: roleId, name: data.name.trim(), modules };
  }
  assignRole(actor: string, userId: string, roleId: string | null) {
    const user = this.db.prepare("SELECT is_admin AS isAdmin FROM users WHERE user_id=?").get(userId);
    if (!user) throw new HttpError(404, "user_missing", "用户不存在。");
    if (user.isAdmin || roleId !== null && !this.db.prepare("SELECT 1 FROM public_roles WHERE id=?").get(roleId)) return invalid("角色分配无效。");
    if (roleId === null) this.db.prepare("DELETE FROM public_role_members WHERE user_id=?").run(userId);
    else this.db.prepare("INSERT INTO public_role_members VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET role_id=excluded.role_id").run(userId, roleId);
    this.audit(actor, "role_assign", userId);
  }
  deleteRole(actor: string, id: string) {
    if (!this.db.prepare("SELECT 1 FROM public_roles WHERE id=?").get(id)) throw new HttpError(404, "role_missing", "角色不存在。");
    if (this.db.prepare("SELECT 1 FROM public_role_members WHERE role_id=?").get(id)) throw new HttpError(409, "role_in_use", "请先移除该角色的用户。");
    this.db.prepare("DELETE FROM public_roles WHERE id=?").run(id);
    this.audit(actor, "role_delete", id);
  }
}
