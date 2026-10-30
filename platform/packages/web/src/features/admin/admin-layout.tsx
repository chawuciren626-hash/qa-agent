import { AppLayout } from "../../components/layout/app-layout";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Button, PageFrame, PageHeader } from "@prismshadow/penguin-ui";
import { useAuth } from "../../state/auth";
import { useProject } from "../../state/project";
import { useSessions } from "../../state/sessions";
import { isSidebarRow } from "../../lib/session-grouping";
import { useNewChat } from "../chat/use-new-chat";
import { controlRequest } from "../../api/control";
import * as api from "../../api/endpoints";
import { AccountCenter } from "../../pages/account-center";
import { PublicationsPage, RESOURCE_NAMES } from "./publications-page";
import { CentralResourcesPage } from "./central-resources-page";
import { AdminOverviewPage } from "./admin-overview-page";
import type { ManagedKind } from "../../lib/managed-resources";
import { useUpdateBadges } from "../../lib/use-update-badges";
import { SettingsDialog } from "../settings/settings-dialog";
import { AdminMenusPage, AdminRolesPage, SYSTEM_MENU_KEYS, defaultAdminMenus, normalizeAdminMenus } from "./admin-system-pages";
import type { AdminMenuItem, AdminMenuKey } from "./admin-system-pages";
import { AdminAuditPage } from "./admin-audit-page";
export { AdminAuditPage } from "./admin-audit-page";
import { discoverLocalWorkspace, rememberedWorkspace, rememberWorkspace } from "../../lib/local-workspace";
import brandLogo from "../../../../../../penguin/ui/aith-logo.svg?url";
import brandLogoLight from "../../../../../../penguin/ui/aith-logo-light.svg?url";
import "./admin-layout.css";

const modules: Record<string, string> = { chat: "测试任务", projects: "项目视图", library: "项目资料", schedules: "定时任务", agents: "多智能体", models: "模型库", plugins: "插件市场", skills: "技能", machines: "机器管理" };
const navIcons: Record<string, ReactNode> = {
  overview: <><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></>,
  chat: <><path d="M4 5h16v12H9l-5 4V5Z"/><path d="M8 10h8M8 13h5"/></>,
  agents: <><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></>,
  models: <><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"/></>,
  plugins: <><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1"/></>,
  users: <><circle cx="9" cy="7" r="4"/><path d="M1 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2M16 3.2a4 4 0 0 1 0 7.6M23 21v-2a4 4 0 0 0-3-3.9"/></>,
  roles: <><circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><path d="M2 20v-2a6 6 0 0 1 12 0v2M15 15a5 5 0 0 1 7 5"/></>,
  menus: <><path d="M4 6h16M4 12h16M4 18h16"/></>,
  skills: <><path d="m12 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></>,
  permissions: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
  audit: <><path d="M7 3h10l3 3v15H4V3h3zM8 11h8M8 15h8M8 19h5"/></>,
};

function AdminAssistantHistory() {
  const { sessions } = useSessions();
  const newChat = useNewChat();
  const location = useLocation();
  const recent = sessions.filter(session => session.agentId === "default_agent" && isSidebarRow(session)).slice(0, 20);
  return <div className="admin-assistant-history"><div className="admin-assistant-history-head"><strong>最近会话</strong><button type="button" onClick={newChat}>＋ 新会话</button></div><nav aria-label="管理员助手会话">{recent.map(session => <Link key={session.sessionId} to={`/chat/${session.sessionId}`} className={location.pathname === `/chat/${session.sessionId}` ? "active" : ""} title={session.title || "未命名会话"}>{session.title || "未命名会话"}</Link>)}</nav>{recent.length === 0 && <p>暂无会话</p>}</div>;
}

function AdminNavigation({ central, userView }: { central: boolean; userView: string | null }) {
  const { user, logout } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuItems, setMenuItems] = useState<AdminMenuItem[]>(defaultAdminMenus);
  const location = useLocation();
  const section = location.pathname.split("/")[1] || "overview";
  const active = section === "publications" ? location.pathname.split("/")[2] : section;
  const [systemOpen, setSystemOpen] = useState(() => SYSTEM_MENU_KEYS.has(active as AdminMenuKey));
  useEffect(() => {
    const refresh = () => { void controlRequest("/api/control/admin/menus").then(result => setMenuItems(normalizeAdminMenus(result.items))).catch(() => setMenuItems(defaultAdminMenus())); };
    refresh(); window.addEventListener("admin-menus-changed", refresh);
    return () => window.removeEventListener("admin-menus-changed", refresh);
  }, []);
  useEffect(() => { if (SYSTEM_MENU_KEYS.has(active as AdminMenuKey)) setSystemOpen(true); }, [active]);
  const row = (item: AdminMenuItem) => {
    const selected = active === item.key || location.pathname === item.path;
    return <Link key={item.key} className={`admin-nav-item${selected ? " active" : ""}`} to={item.path} aria-current={selected ? "page" : undefined}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{navIcons[item.icon] ?? navIcons.menus}</svg>{item.name}</Link>;
  };
  const mainItems = menuItems.filter(item => item.group === "main");
  const systemItems = menuItems.filter(item => item.group === "sys");
  return <aside className="admin-side" aria-label="管理员导航">
    <div className="admin-brand"><span className="admin-brand-mark" aria-hidden="true"><img className="admin-logo-default" src={brandLogo} alt="" draggable={false}/><img className="admin-logo-light" src={brandLogoLight} alt="" draggable={false}/></span><strong>AITestHarness</strong></div>
    <div className="admin-side-scroll"><nav>{mainItems.map(row)}<div className="admin-nav-system"><button type="button" className="admin-nav-system-toggle" aria-expanded={systemOpen} onClick={() => setSystemOpen(!systemOpen)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v14H4zM8 9h8M8 13h8"/></svg>系统管理<span aria-hidden="true">{systemOpen ? "⌄" : "›"}</span></button>{systemOpen && <div className="admin-nav-system-children">{systemItems.map(row)}</div>}</div></nav>{!central && active === "chat" && <AdminAssistantHistory />}</div>
    <details className="admin-account"><summary><span className="admin-avatar">{(user?.displayName ?? user?.userId ?? "A").slice(0, 1).toUpperCase()}</span><span className="admin-account-name">{user?.displayName ?? user?.userId}</span><span className="admin-account-role">管理员</span></summary><div className="admin-account-menu"><p>当前：管理员视图</p><a href={central ? "/user/" : userView ?? "/user/"}>切换到用户视图</a><button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setSettingsOpen(true); }}>设置</button><button type="button" onClick={() => void logout().then(() => window.location.assign("/admin/login"))}>退出登录</button></div></details>
    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} accountCenter={central} />
  </aside>;
}

function userViewUrl(): string | null {
  return rememberedWorkspace();
}

function AdminChrome({ children }: { children: ReactNode }) {
  const userView = userViewUrl();
  return <div className="admin-shell"><AdminNavigation central userView={userView}/><main className="admin-main">{children}</main></div>;
}

/** Public resources live centrally; native Agent authoring uses the administrator's local project. */
function LocalAdminWorkspaceEntry({ path, title }: { path: string; title: string }) {
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void discoverLocalWorkspace(location.origin, rememberedWorkspace(), controller.signal).then(url => {
      if (!url || controller.signal.aborted) {
        if (!controller.signal.aborted) setError("本机服务未运行。请启动 AITestHarness 本机组件后重试。");
        return;
      }
      rememberWorkspace(url);
      window.location.replace(new URL(path, url).href);
    }).catch(() => { if (!controller.signal.aborted) setError("连接本机服务失败，请重试。"); });
    return () => controller.abort();
  }, []);
  return <PageFrame><PageHeader title={title} description="正在连接管理员本机工作区。" />
    {error ? <p role="alert">{error} <button type="button" onClick={() => location.reload()}>重试</button></p> : <p role="status">正在连接本机服务…</p>}
  </PageFrame>;
}

/** The identity server stays a publication store, never a remote user workspace. */
export function AdminHostGate({ children }: { children: ReactNode }) {
  const { sessionVia } = useAuth();
  const [central, setCentral] = useState<boolean | null>(null);
  const [adminOrigin, setAdminOrigin] = useState<string | null>(null);
  const [error, setError] = useState("");
  const location = useLocation();
  useEffect(() => { void controlRequest("/api/account-client/config").then(config => {
    setCentral(config.central === true);
    if (config.enabled && typeof config.origin === "string") {
      try {
        const url = new URL(config.origin);
        if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) setAdminOrigin(url.origin);
      } catch { /* Invalid management origin is ignored. */ }
    }
  }).catch(cause => setError(cause.message)); }, []);
  if (error) return <p role="alert">{error}</p>;
  if (central === null) return <p className="p-8">正在连接管理服务…</p>;
  if (!central && sessionVia === "desktop") return <div className="admin-web-only"><h1>管理后台仅在 Web 端开放</h1><p>请在浏览器访问管理后台。</p>{adminOrigin && <a href={new URL("/admin/overview", adminOrigin).href} target="_blank" rel="noopener noreferrer">打开 Web 管理后台 ↗</a>}</div>;
  if (!central) return <>{children}</>;
  const section = location.pathname.split("/")[1] || "agents";
  const kind = (section === "publications" ? location.pathname.split("/")[2] : section) as ManagedKind;
  return <AdminChrome>{section === "overview" ? <AdminOverviewPage /> : section === "users" ? <AdminAccountsPage /> : section === "roles" ? <AdminRolesPage /> : section === "menus" ? <AdminMenusPage /> : section === "permissions" ? <AdminPermissionsPage /> : section === "audit" ? <AdminAuditPage /> : kind === "agents" ? <LocalAdminWorkspaceEntry path="/admin/agents" title="智能体管理" /> : section === "chat" ? <LocalAdminWorkspaceEntry path={`/admin${location.pathname}`} title="管理员助手" /> : kind in RESOURCE_NAMES ? <CentralResourcesPage key={kind} kind={kind} /> : <PageFrame>未知管理模块。</PageFrame>}</AdminChrome>;
}

export function AdminLayout() {
  const { currentProject, projects, projectsLoading, reloadProjects, setCurrentProjectId } = useProject();
  const location = useLocation();
  const section = location.pathname.split("/")[2] ?? "";
  const [creating, setCreating] = useState(false);
  const [projectError, setProjectError] = useState("");
  const configProjectId = "admin_agent_catalog";
  const needsConfigProject = section === "agents" || section === "skills" || section === "chat";
  const catalogExists = projects.some(project => project.projectId === configProjectId);
  useEffect(() => {
    if (!needsConfigProject || projectsLoading || creating || projectError) return;
    if (catalogExists) { if (currentProject?.projectId !== configProjectId) setCurrentProjectId(configProjectId); return; }
    setCreating(true);
    void api.createProject({ projectId: configProjectId, name: "管理员智能体配置" })
      .catch(cause => { if (cause?.status !== 409) throw cause; })
      .then(() => reloadProjects())
      .catch(cause => setProjectError(cause instanceof Error ? cause.message : "创建管理员配置项目失败"))
      .finally(() => setCreating(false));
  }, [needsConfigProject, projectsLoading, creating, projectError, catalogExists, currentProject?.projectId, reloadProjects, setCurrentProjectId]);
  const navigation = <AdminNavigation central={false} userView={userViewUrl() ?? "/user/"}/>;
  if (needsConfigProject && (projectsLoading || creating || currentProject?.projectId !== configProjectId)) return <div className="admin-shell">{navigation}<main className="admin-main"><PageFrame><PageHeader title={section === "skills" ? "技能管理" : section === "chat" ? "管理员助手" : "智能体管理"} />{projectError ? <p role="alert">{projectError}</p> : <p role="status">正在准备管理员配置项目…</p>}</PageFrame></main></div>;
  return <AppLayout navigation={navigation} />;
}

export function AdminAccountsPage() {
  const { accountClient } = useAuth();
  return <div className="admin-accounts"><AccountCenter registrationEnabled={false} apiBase={accountClient ? "/api/account-client" : ""} /></div>;
}

export function AdminPermissionsPage() {
  const { accountClient } = useAuth();
  const [users, setUsers] = useState<{ userId: string; isAdmin: boolean }[]>([]);
  const [selected, setSelected] = useState("");
  const [grants, setGrants] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { void controlRequest((accountClient ? "/api/account-client" : "") + "/api/admin/users").then(response => setUsers(response.users)).catch(cause => setError(cause.message)); }, [accountClient]);
  useEffect(() => {
    let active = true; setGrants([]); setNotice("");
    if (!selected) return;
    setBusy(true);
    void controlRequest("/api/control/admin/permissions/" + encodeURIComponent(selected)).then(response => { if (active) setGrants(response.modules); }).catch(cause => { if (active) setError(cause.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [selected]);
  return <PageFrame><PageHeader title="功能权限" description="管理员保留全部模块；普通用户按授权显示和使用功能。" />
    <select aria-label="授权账号" className="mb-6 rounded border bg-transparent p-2" value={selected} onChange={event => setSelected(event.target.value)}><option value="">选择普通用户</option>{users.filter(user => !user.isAdmin).map(user => <option key={user.userId}>{user.userId}</option>)}</select>
    <div className="mb-6 flex flex-wrap gap-5">{Object.entries(modules).map(([key, title]) => <label key={key} className="flex gap-2"><input type="checkbox" disabled={!selected || busy || key==="models"} checked={key==="models" || grants.includes(key)} onChange={event => setGrants(event.target.checked ? [...grants, key] : grants.filter(grant => grant !== key))} />{title}{key==="models" && <span className="text-xs opacity-60">个人模型始终开放</span>}</label>)}</div>
    {error && <p role="alert" className="mb-4 text-red-600">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Button disabled={!selected || busy} onClick={async () => { setBusy(true); setError(""); try { await controlRequest("/api/control/admin/permissions/" + selected, "PUT", { modules: grants }); setNotice("权限已保存，用户后续操作会重新校验。"); } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); } finally { setBusy(false); } }}>保存权限</Button>
  </PageFrame>;
}

export function AdminLogin() {
  const { user } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const returnTo = new URLSearchParams(window.location.search).get("returnTo");
    if (returnTo) rememberWorkspace(returnTo);
  }, []);
  if (user?.isAdmin) return <Navigate to="/overview" replace />;
  return <div className="admin-login"><aside><strong>AITestHarness</strong><h1>统一配置<br />集中管理</h1><p>沿用现有智能体、模型、插件和技能能力<br />增加授权与发布管理</p></aside><form onSubmit={async event => {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setError("");
    try { await controlRequest("/api/auth/admin-login", "POST", { userId: values.get("userId"), password: values.get("password") }); window.location.assign("/admin/overview"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败"); }
    finally { setBusy(false); }
  }}><p>Web 管理后台 · 仅管理员</p><h2>管理员登录</h2><label>账号<input name="userId" required autoComplete="username" /></label><label>密码<input name="password" required type="password" autoComplete="current-password" /></label>{error && <p role="alert">{error}</p>}<Button disabled={busy} type="submit">{busy ? "正在验证…" : "登录"}</Button><a href="/user/login">前往用户端</a></form></div>;
}
