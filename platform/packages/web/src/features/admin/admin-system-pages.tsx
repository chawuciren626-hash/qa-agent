import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button, Modal, PageFrame, PageHeader } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import "./admin-system-pages.css";

export const ADMIN_MENU_KEYS = ["overview", "chat", "agents", "models", "plugins", "skills", "users", "roles", "menus", "audit"] as const;
export type AdminMenuKey = typeof ADMIN_MENU_KEYS[number];
export type AdminMenuItem = { key: string; name: string; path: string; group: "main" | "sys"; icon: string; color: string; visible: boolean; builtin: boolean };
export const SYSTEM_MENU_KEYS = new Set<AdminMenuKey>(["users", "roles", "menus", "audit"]);
export const ADMIN_MENU_LABELS: Record<AdminMenuKey, string> = {
  overview: "概览", chat: "管理员助手", agents: "Agent管理", models: "模型配置", plugins: "插件管理",
  skills: "技能管理", users: "用户管理", roles: "角色管理", menus: "菜单管理", audit: "操作日志",
};
const palette = ["#5a8dea", "#8a7ff0", "#2866a4", "#36ae83", "#dea52e", "#d85ca5", "#98a3b3"];
export const defaultAdminMenus = (): AdminMenuItem[] => ADMIN_MENU_KEYS.map((key, index) => ({
  key, name: ADMIN_MENU_LABELS[key], path: key === "chat" ? "/chat/new" : `/${key}`,
  group: SYSTEM_MENU_KEYS.has(key) ? "sys" : "main", icon: key,
  color: palette[index % palette.length]!, visible: true, builtin: true,
}));
/** Older central management services persist only key and visible. Keep their order and switches. */
export function normalizeAdminMenus(value: unknown): AdminMenuItem[] {
  const defaults = defaultAdminMenus();
  if (!Array.isArray(value) || value.length === 0) return defaults;
  const byKey = new Map(defaults.map(item => [item.key, item]));
  const seen = new Set<string>();
  const items: AdminMenuItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<AdminMenuItem>;
    if (typeof item.key !== "string" || seen.has(item.key)) continue;
    const original = byKey.get(item.key);
    if (!original && (typeof item.name !== "string" || typeof item.path !== "string" ||
        !["main", "sys"].includes(String(item.group)) || typeof item.icon !== "string" ||
        typeof item.color !== "string")) continue;
    items.push({
      ...(original ?? item as AdminMenuItem),
      ...item,
      name: typeof item.name === "string" ? item.name : original!.name,
      path: typeof item.path === "string" ? item.path : original!.path,
      group: item.group === "main" || item.group === "sys" ? item.group : original!.group,
      icon: typeof item.icon === "string" ? item.icon : original!.icon,
      color: typeof item.color === "string" ? item.color : original!.color,
      visible: item.visible !== false,
      builtin: original ? true : item.builtin === false,
    });
    seen.add(item.key);
  }
  for (const item of defaults) if (!seen.has(item.key)) items.push(item);
  return items;
}
type Role = { id: "admin" | "ordinary"; name: string; description: string; members: string[]; menus: string[] };
type User = { userId: string; isAdmin: boolean };
const message = (cause: unknown) => cause instanceof Error ? cause.message : "操作失败";
const avatar = (name: string) => <span className="sys-avatar">{name.slice(0, 1).toUpperCase()}</span>;
const menuSymbols: Record<string, ReactNode> = {
  overview: <><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></>,
  chat: <><path d="M4 5h16v12H9l-5 4V5Z"/><path d="M8 10h8M8 13h5"/></>,
  agents: <><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></>,
  models: <><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"/></>,
  plugins: <><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0-2.8Z"/><circle cx="7.5" cy="7.5" r="1"/></>,
  skills: <><path d="m12 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></>,
  users: <><circle cx="9" cy="7" r="4"/><path d="M1 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2M16 3a4 4 0 0 1 0 8M23 21v-2a4 4 0 0 0-3-4"/></>,
  roles: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/></>,
  menus: <path d="M4 6h16M4 12h16M4 18h10"/>,
  audit: <><path d="M7 3h10l3 3v15H4V3h3z"/><path d="M8 11h8M8 15h8M8 19h5"/></>,
};
function MenuGlyph({ icon }: { icon: string }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{menuSymbols[icon] ?? menuSymbols.menus}</svg>; }

export function AdminRolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [menus, setMenus] = useState<AdminMenuItem[]>(defaultAdminMenus);
  const [dialog, setDialog] = useState<{ role: Role["id"]; kind: "users" | "menus" } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const [roleData, menuData, userData] = await Promise.all([
      controlRequest("/api/control/admin/roles"),
      controlRequest("/api/control/admin/menus"),
      controlRequest("/api/admin/users"),
    ]);
    setRoles(roleData.roles); setMenus(normalizeAdminMenus(menuData.items)); setUsers(userData.users);
  }, []);
  useEffect(() => { void load().catch(cause => setError(message(cause))); }, [load]);
  const open = (role: Role, kind: "users" | "menus") => {
    setDialog({ role: role.id, kind }); setSelected(kind === "users" ? role.members : role.menus);
    setQuery(""); setError(""); setNotice("");
  };
  const toggle = (key: string) => setSelected(previous => previous.includes(key) ? previous.filter(item => item !== key) : [...previous, key]);
  const save = async () => {
    if (!dialog) return;
    if (dialog.kind === "users" && dialog.role === "ordinary" &&
        users.some(user => !user.isAdmin && !selected.includes(user.userId)) &&
        !window.confirm("未选中的普通用户将转为管理员。确认更改这些账号的角色？")) return;
    setBusy(true); setError("");
    try {
      if (dialog.kind === "users") await controlRequest(`/api/control/admin/roles/${dialog.role}/users`, "PUT", { userIds: selected });
      else await controlRequest("/api/control/admin/roles/ordinary/menus", "PUT", { menuKeys: selected });
      await load(); setDialog(null); setNotice("角色分配已保存。");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const shownUsers = useMemo(() => users.filter(user => user.userId.toLowerCase().includes(query.trim().toLowerCase())), [users, query]);
  return <PageFrame width="xl" className="sys-page"><PageHeader title="角色管理" description="系统内置「管理员」和「普通用户」两个角色。为角色分配用户和可见菜单后，用户按角色权限使用系统；管理员始终拥有全部权限。" />
    {error && !dialog && <p role="alert" className="sys-error">{error}</p>}{notice && <p role="status" className="sys-notice">{notice}</p>}
    <div className="sys-card sys-table-wrap"><table className="sys-table"><thead><tr><th>角色</th><th>成员</th><th>可见菜单</th><th>操作</th></tr></thead><tbody>
      {roles.map(role => <tr key={role.id}><td><div className="sys-role-name">{avatar(role.name)}<div><strong>{role.name}</strong><span className="sys-badge">内置角色</span><small>{role.description}</small></div></div></td><td><strong>{role.members.length}</strong> 人</td><td>{role.id === "admin" ? "全部（不受限）" : `${role.menus.length} / ${menus.length} 个`}</td><td><div className="sys-actions"><button type="button" onClick={() => open(role, "users")}>用户分配</button><button type="button" disabled={role.id === "admin"} title={role.id === "admin" ? "管理员始终可见全部菜单" : undefined} onClick={() => open(role, "menus")}>菜单分配</button></div></td></tr>)}
    </tbody></table></div><p className="sys-hint">「用户分配」把账号加入或移出该角色；「菜单分配」决定普通用户可见的菜单。两个角色均为内置，不可删除或新建。</p>
    <Modal open={dialog !== null} title={dialog ? `${dialog.kind === "users" ? "分配用户" : "分配菜单"} · ${roles.find(role => role.id === dialog.role)?.name ?? ""}` : ""} onClose={() => setDialog(null)} widthClass="sm:max-w-lg" footer={<><Button onClick={() => setDialog(null)}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>保存分配</Button></>}>
      {dialog?.kind === "users" ? <><input className="sys-input sys-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用户 ID…" aria-label="搜索用户 ID" /><p className="sys-hint">已选 {selected.length} 人</p><div className="sys-picker">{shownUsers.map(user => <label key={user.userId} className="sys-pick"><input type="checkbox" checked={selected.includes(user.userId)} disabled={user.userId === "admin"} onChange={() => toggle(user.userId)} />{avatar(user.userId)}<span>{user.userId}</span><small>{user.isAdmin ? "管理员" : "普通用户"}</small></label>)}{shownUsers.length === 0 && <p className="sys-empty">没有匹配的用户</p>}</div></> :
        <><p className="sys-hint">已选 {selected.length} 个菜单</p>{(["main", "sys"] as const).map(group => <div key={group}><h3 className="sys-group-title">{group === "main" ? "主菜单" : "系统管理"}</h3>{menus.filter(item => item.group === group).map(item => <label key={item.key} className="sys-pick"><input type="checkbox" checked={selected.includes(item.key)} onChange={() => toggle(item.key)} /><span>{item.name}</span><small>{item.path}</small></label>)}</div>)}</>}
      {error && <p role="alert" className="sys-error">{error}</p>}
    </Modal>
  </PageFrame>;
}

export function AdminMenusPage() {
  const [items, setItems] = useState<AdminMenuItem[]>(defaultAdminMenus);
  const [editing, setEditing] = useState<AdminMenuItem | null>(null);
  const [form, setForm] = useState<AdminMenuItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  useEffect(() => { void controlRequest("/api/control/admin/menus").then(response => setItems(normalizeAdminMenus(response.items))).catch(cause => setError(message(cause))); }, []);
  const persist = async (next: AdminMenuItem[]): Promise<boolean> => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await controlRequest("/api/control/admin/menus", "PUT", { items: next });
      setItems(normalizeAdminMenus(result.items)); setNotice("菜单已保存。"); window.dispatchEvent(new Event("admin-menus-changed")); return true;
    } catch (cause) { setError(message(cause)); return false; }
    finally { setBusy(false); }
  };
  const move = (key: string, target: string) => {
    if (key === target) return;
    const from = items.findIndex(item => item.key === key), to = items.findIndex(item => item.key === target);
    if (from < 0 || to < 0 || items[from]?.group !== items[to]?.group) return;
    const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item!); void persist(next);
  };
  const open = (item?: AdminMenuItem, group: "main" | "sys" = "main") => {
    setEditing(item ?? null);
    setForm(item ? { ...item } : { key: `custom_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, name: "", path: "/", group, icon: "menus", color: palette[0]!, visible: true, builtin: false });
    setError("");
  };
  const save = async () => {
    if (!form?.name.trim() || !/^\/[a-zA-Z0-9/_-]{0,120}$/.test(form.path)) { setError("请填写名称和有效的站内路径。"); return; }
    if (await persist(editing ? items.map(item => item.key === editing.key ? form : item) : [...items, form])) setForm(null);
  };
  const remove = (item: AdminMenuItem) => {
    if (item.builtin || !window.confirm(`删除菜单「${item.name}」？删除后可重新创建。`)) return;
    void persist(items.filter(other => other.key !== item.key));
  };
  return <PageFrame width="xl" className="sys-page"><PageHeader title="菜单管理" description="新增、编辑、删除和排序管理后台菜单；内置菜单可编辑名称与颜色，但不可删除。" actions={<Button variant="primary" onClick={() => open()}>＋ 新增菜单</Button>} />
    {error && !form && <p role="alert" className="sys-error">{error}</p>}{notice && <p role="status" className="sys-notice">{notice}</p>}
    {(["main", "sys"] as const).map(group => {
      const list = items.filter(item => item.group === group);
      return <section key={group} className="sys-menu-section"><div className="sys-menu-head"><div><strong>{group === "main" ? "主菜单" : "系统管理"}</strong><small>{group === "main" ? "日常使用的高频入口" : "管理员专属配置入口"}</small></div><button type="button" onClick={() => open(undefined, group)}>＋</button></div>
        <div className="sys-card">{list.map((item, index) => <div key={item.key} className={`sys-menu-row${dragged === item.key ? " dragging" : ""}`} draggable={!busy} onDragStart={() => setDragged(item.key)} onDragEnd={() => setDragged(null)} onDragOver={event => event.preventDefault()} onDrop={() => { if (dragged) move(dragged, item.key); setDragged(null); }}>
          <span className="sys-drag" title="拖拽排序">⠿</span><span className="sys-order">{index + 1}</span><span className="sys-menu-icon" style={{ backgroundColor: item.color }}><MenuGlyph icon={item.icon}/></span><strong>{item.name}</strong><code>{item.path}</code>{item.builtin && <span className="sys-badge">内置</span>}
          <span className="sys-spacer" /><label className="sys-show"><input type="checkbox" checked={item.visible} disabled={busy || ["users", "roles", "menus"].includes(item.key)} onChange={event => void persist(items.map(other => other.key === item.key ? { ...other, visible: event.target.checked } : other))} />显示</label>
          <button type="button" onClick={() => open(item)}>编辑</button><button type="button" className="danger" disabled={item.builtin || busy} title={item.builtin ? "内置菜单不可删除" : undefined} onClick={() => remove(item)}>删除</button>
          <button type="button" className="sys-move" disabled={index === 0 || busy} aria-label={`${item.name}上移`} onClick={() => move(item.key, list[index - 1]!.key)}>↑</button><button type="button" className="sys-move" disabled={index === list.length - 1 || busy} aria-label={`${item.name}下移`} onClick={() => move(item.key, list[index + 1]!.key)}>↓</button>
        </div>)}{list.length === 0 && <p className="sys-empty">该分组暂无菜单</p>}</div>
      </section>;
    })}
    <p className="sys-hint">⠿ 拖拽行可排序，或使用 ↑ ↓ 微调；关闭「显示」后该菜单对普通用户隐藏，管理员始终可见。</p>
    <Modal open={form !== null} title={editing ? `编辑菜单 · ${editing.name}` : "新增菜单"} onClose={() => setForm(null)} widthClass="sm:max-w-lg" footer={<><Button onClick={() => setForm(null)}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>保存</Button></>}>
      {form && <div className="sys-form"><label>菜单名称<input className="sys-input" maxLength={24} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label>路径<input className="sys-input" value={form.path} onChange={event => setForm({ ...form, path: event.target.value })} /></label><label>所属分组<select className="sys-input" value={form.group} onChange={event => setForm({ ...form, group: event.target.value as "main" | "sys" })}><option value="main">主菜单</option><option value="sys">系统管理</option></select></label><label>图标<select className="sys-input" value={form.icon} onChange={event => setForm({ ...form, icon: event.target.value })}>{ADMIN_MENU_KEYS.map(key => <option key={key} value={key}>{ADMIN_MENU_LABELS[key]}</option>)}</select></label><div><span>图标颜色</span><div className="sys-colors">{palette.map(color => <button key={color} type="button" className={form.color === color ? "active" : ""} style={{ backgroundColor: color }} aria-label={color} onClick={() => setForm({ ...form, color })}><MenuGlyph icon={form.icon}/></button>)}</div></div><label className="sys-checkbox"><input type="checkbox" checked={form.visible} disabled={["users", "roles", "menus"].includes(form.key)} onChange={event => setForm({ ...form, visible: event.target.checked })} />立即显示</label></div>}
      {error && <p role="alert" className="sys-error">{error}</p>}
    </Modal>
  </PageFrame>;
}
