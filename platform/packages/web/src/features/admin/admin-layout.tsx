import { AdminChannelsPage } from "./admin-channels-page";
import { AppLayout } from "../../components/layout/app-layout";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Button, ConfirmModal, PageFrame, PageHeader } from "@prismshadow/penguin-ui";
import { useAuth } from "../../state/auth";
import { apiErrorText } from "../../lib/api-error";
import { ChangePasswordDialog } from "../../components/account/change-password-dialog";
import { S } from "../../lib/strings";
import { isDesktopShellWindow } from "../../lib/account-menu";
import { useProject } from "../../state/project";
import { useSessions } from "../../state/sessions";
import { isSidebarRow } from "../../lib/session-grouping";
import { useNewChat } from "../chat/use-new-chat";
import { controlRequest } from "../../api/control";
import * as api from "../../api/endpoints";
import { AccountCenter } from "../../pages/account-center";
import { CentralAgentsPage } from "./central-agents-page";
import { CentralAgentSettingsPage } from "./central-agent-settings-page";
import { CentralPluginsPage } from "./central-plugins-page";
import { AdminSkillsPage } from "./admin-skills-page";
import { AdminToolsPage } from "./admin-tools-page";
import { AdminMcpPage } from "./admin-mcp-page";
import { AdminOverviewPage } from "./admin-overview-page";
import type { ManagedKind } from "../../lib/managed-resources";
import { useUpdateBadges } from "../../lib/use-update-badges";
import { SettingsDialog } from "../settings/settings-dialog";
import { AdminMenusPage, AdminRolesPage, defaultAdminMenus, normalizeAdminMenus } from "./admin-system-pages";
import type { AdminMenuItem } from "./admin-system-pages";
import { AdminAuditPage } from "./admin-audit-page";
import { AdminTaskPlatformPage } from "./admin-task-platform-page";
export { AdminAuditPage } from "./admin-audit-page";
import { discoverLocalWorkspace, rememberedWorkspace, rememberWorkspace } from "../../lib/local-workspace";
import brandLogo from "../../../../../../penguin/ui/aith-logo.svg?url";
import brandLogoLight from "../../../../../../penguin/ui/aith-logo-light.svg?url";
import "./admin-layout.css";

const CentralAssistantContext = createContext(false);

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
  tools: <><path d="M14.7 6.3a4 4 0 0 0 5 5L21 21H3l1.3-9.7a4 4 0 0 0 5-5"/><path d="M9 3h6M12 3v4"/><circle cx="12" cy="15" r="2"/></>,
  mcp: <><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M17 7.5h.01M17 16.5h.01"/></>,
  task_platform: <><path d="M4 7h11M4 12h7M4 17h9"/><path d="m15 4 4 3-4 3"/><path d="M20 17H9"/><path d="m9 20-4-3 4-3"/></>,
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

function AdminAccountMenu({ central, userView, variant }: { central: boolean; userView: string | null; variant?: "side" | "top" }) {
  const { user, logout, desktopMode, sessionVia, accountClient } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingLoginPassword, setSettingLoginPassword] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const startLogout = () => {
    setLogoutError("");
    if (!accountClient && user?.passwordIsInitial && isDesktopShellWindow({ desktopMode, sessionVia })) {
      setSettingLoginPassword(true);
    } else setConfirmingLogout(true);
  };
  const confirmLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError("");
    try {
      await logout();
      window.location.assign("/admin/login");
    } catch (error) {
      setLogoutError(apiErrorText(error));
    } finally {
      setLoggingOut(false);
    }
  };
  return <>
    <details className={`admin-account${variant === "top" ? " admin-account-top" : ""}`}>
      <summary>
        <span className="admin-avatar">{(user?.displayName ?? user?.userId ?? "A").slice(0, 1).toUpperCase()}</span>
        <span className="admin-account-name">{user?.displayName ?? user?.userId}</span>
        <span className="admin-account-role">管理员</span>
      </summary>
      <div className="admin-account-menu">
        <p>当前：管理员视图</p>
        <a href={central ? "/user/" : userView ?? "/user/"}>切换到用户视图</a>
        <button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setSettingsOpen(true); }}>设置</button>
        <button type="button" onClick={startLogout}>退出登录</button>
        {logoutError && <p role="alert">{logoutError}</p>}
      </div>
    </details>
    <ChangePasswordDialog open={settingLoginPassword} onClose={() => setSettingLoginPassword(false)} firstDesktopLogout onSaved={() => setConfirmingLogout(true)} />
    <ConfirmModal open={confirmingLogout} title={S.auth.logoutConfirmTitle} confirmLabel={S.auth.logout} cancelLabel={S.common.cancel} busy={loggingOut} onClose={() => { if (!loggingOut) setConfirmingLogout(false); }} onConfirm={() => void confirmLogout()}>
      <p className="text-sm text-gray-600 dark:text-gray-300">{S.auth.logoutConfirmBody}</p>
      {logoutError && <p role="alert" className="mt-2 text-sm text-red-600">{logoutError}</p>}
    </ConfirmModal>
    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} accountCenter={central} />
  </>;
}

function AdminNavigation({ central, userView, showAccount = true }: { central: boolean; userView: string | null; showAccount?: boolean }) {
  const [menuItems, setMenuItems] = useState<AdminMenuItem[]>(defaultAdminMenus);
  const location = useLocation();
  const section = location.pathname.split("/")[1] || "overview";
  const active = section === "publications" ? location.pathname.split("/")[2] : section;
  // 两个分组（平台管理 / 系统管理）各自可折叠：进入组内页面时自动展开，其余时候记忆用户的选择。
  const [collapsed, setCollapsed] = useState<Record<"main" | "sys", boolean>>({ main: false, sys: false });
  useEffect(() => {
    const refresh = () => { void controlRequest("/api/control/admin/menus").then(result => setMenuItems(normalizeAdminMenus(result.items))).catch(() => setMenuItems(defaultAdminMenus())); };
    refresh(); window.addEventListener("admin-menus-changed", refresh);
    return () => window.removeEventListener("admin-menus-changed", refresh);
  }, []);
  const activeGroup: "main" | "sys" | null = menuItems.some(item => item.group === "sys" && (active === item.key || location.pathname === item.path))
    ? "sys"
    : menuItems.some(item => item.group === "main" && (active === item.key || location.pathname === item.path)) ? "main" : null;
  useEffect(() => { if (activeGroup !== null) setCollapsed(current => current[activeGroup] ? { ...current, [activeGroup]: false } : current); }, [activeGroup]);
  const row = (item: AdminMenuItem) => {
    const selected = active === item.key || location.pathname === item.path;
    return <Link key={item.key} className={`admin-nav-item${selected ? " active" : ""}`} to={item.path} aria-current={selected ? "page" : undefined}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{navIcons[item.icon] ?? navIcons.menus}</svg>{item.name}</Link>;
  };
  const group = (id: "main" | "sys", label: string) => {
    const items = menuItems.filter(item => item.group === id);
    if (items.length === 0) return null;
    const open = !collapsed[id];
    return <div className={`admin-nav-group${id === "sys" ? " admin-nav-group-sys" : ""}`}>
      <button type="button" className="admin-nav-group-toggle" aria-expanded={open} onClick={() => setCollapsed(current => ({ ...current, [id]: !current[id] }))}>
        {label}<span aria-hidden="true">{open ? "⌄" : "›"}</span>
      </button>
      {open && <div className="admin-nav-group-children">{items.map(row)}</div>}
    </div>;
  };
  return <aside className="admin-side" aria-label="管理员导航">
    <div className="admin-brand"><span className="admin-brand-mark" aria-hidden="true"><img className="admin-logo-default" src={brandLogo} alt="" draggable={false}/><img className="admin-logo-light" src={brandLogoLight} alt="" draggable={false}/></span><strong>AITestHarness</strong></div>
    <div className="admin-side-scroll">
      <nav>
        {group("main", "平台管理")}
        {group("sys", "系统管理")}
      </nav>
      {active === "chat" && <AdminAssistantHistory />}
    </div>
    {showAccount && <AdminAccountMenu central={central} userView={userView} />}
  </aside>;
}

function userViewUrl(): string | null {
  return rememberedWorkspace();
}

/** 顶栏面包屑：管理后台 / 分组 / 当前页，从菜单结构自动生成；未知路由（如 Agent 详情）回退到段落名。 */
function AdminTopbar({ central, userView }: { central: boolean; userView: string | null }) {
  const [menuItems, setMenuItems] = useState<AdminMenuItem[]>(defaultAdminMenus);
  const location = useLocation();
  const section = location.pathname.split("/")[1] || "overview";
  const active = section === "publications" ? location.pathname.split("/")[2] : section;
  useEffect(() => {
    const refresh = () => { void controlRequest("/api/control/admin/menus").then(result => setMenuItems(normalizeAdminMenus(result.items))).catch(() => setMenuItems(defaultAdminMenus())); };
    refresh(); window.addEventListener("admin-menus-changed", refresh);
    return () => window.removeEventListener("admin-menus-changed", refresh);
  }, []);
  const activeItem = menuItems.find(item => active === item.key || location.pathname === item.path);
  const crumbs = [
    { label: "管理后台", path: "/overview" },
    ...(activeItem?.group === "sys" ? [{ label: "系统管理", path: null as string | null }] : []),
    { label: activeItem?.name ?? section, path: null as string | null },
  ];
  return <header className="admin-topbar">
    <nav className="admin-crumbs" aria-label="面包屑">
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`} className="admin-crumb">
          {index > 0 && <span className="admin-crumb-sep" aria-hidden="true">/</span>}
          {crumb.path !== null && index < crumbs.length - 1
            ? <Link to={crumb.path}>{crumb.label}</Link>
            : <span aria-current={index === crumbs.length - 1 ? "page" : undefined}>{crumb.label}</span>}
        </span>
      ))}
    </nav>
    <div className="admin-topbar-side">
      <AdminAccountMenu central={central} userView={userView} variant="top" />
    </div>
  </header>;
}

function AdminChrome({ children }: { children: ReactNode }) {
  const userView = userViewUrl();
  return <div className="admin-shell">
    <AdminNavigation central userView={userView} showAccount={false} />
    <div className="admin-col">
      <AdminTopbar central userView={userView} />
      <main className="admin-main">{children}</main>
    </div>
  </div>;
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

/** The administrator console and user workspace share this server and its database. */
export function AdminHostGate({ children }: { children: ReactNode }) {
  const { sessionVia } = useAuth();
  const location = useLocation();
  if (sessionVia === "desktop") return <div className="admin-web-only"><h1>管理后台仅在 Web 端开放</h1><p>请在浏览器中访问本服务的 /admin 路径。</p><a href="/admin/overview">打开管理后台 ↗</a></div>;
  const section = location.pathname.split("/")[1] || "agents";
  if (section === "chat") return <CentralAssistantContext.Provider value>{children}</CentralAssistantContext.Provider>;
  const kind = (section === "publications" ? location.pathname.split("/")[2] : section) as ManagedKind;
  return <AdminChrome>{section === "overview" ? <AdminOverviewPage /> : section === "users" ? <AdminAccountsPage /> : section === "roles" ? <AdminRolesPage /> : section === "menus" ? <AdminMenusPage /> : section === "permissions" ? <AdminPermissionsPage /> : section === "audit" ? <AdminAuditPage /> : section === "mcp" ? <AdminMcpPage /> : section === "task_platform" ? <AdminTaskPlatformPage /> : kind === "agents" ? (location.pathname.startsWith("/agents/") ? <CentralAgentSettingsPage /> : <CentralAgentsPage />) : kind === "plugins" ? <CentralPluginsPage /> : kind === "skills" ? <AdminSkillsPage central /> : section === "tools" ? <AdminToolsPage /> : /^\/channels\/?$/.test(location.pathname) ? <AdminChannelsPage /> : <PageFrame>未知管理模块。</PageFrame>}</AdminChrome>;
}

export function AdminLayout() {
  const centralAssistant = useContext(CentralAssistantContext);
  const { currentProject, projects, projectsLoading, reloadProjects, setCurrentProjectId } = useProject();
  const location = useLocation();
  // React Router strips the /admin basename before exposing useLocation().
  const section = location.pathname.split("/")[1] ?? "";
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
  const navigation = <AdminNavigation central={centralAssistant} userView={userViewUrl() ?? "/user/"}/>;
  if (needsConfigProject && (projectsLoading || creating || currentProject?.projectId !== configProjectId)) return <div className="admin-shell">{navigation}<main className="admin-main"><PageFrame><PageHeader title={section === "skills" ? "技能管理" : section === "chat" ? "管理员助手" : "智能体管理"} />{projectError ? <p role="alert">{projectError}</p> : <p role="status">正在准备管理员配置项目…</p>}</PageFrame></main></div>;
  return <AppLayout navigation={navigation} localHostFeatures={!centralAssistant} />;
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
    <div className="mb-6 flex flex-wrap gap-4">{Object.entries(modules).map(([key, title]) => <label key={key} className="flex gap-2"><input type="checkbox" disabled={!selected || busy || key==="models"} checked={key==="models" || grants.includes(key)} onChange={event => setGrants(event.target.checked ? [...grants, key] : grants.filter(grant => grant !== key))} />{title}{key==="models" && <span className="text-xs opacity-60">个人模型始终开放</span>}</label>)}</div>
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
  return <div className="account-center ac-login-view admin-login"><div className="layout"><aside className="brand-panel"><div className="brand-top"><img className="brand-logo" src={brandLogo} alt="" /><div className="brand-name">AITestHarness<small>软件测试智能体</small></div></div><div className="brand-middle"><h1 className="brand-headline">统一配置<br />集中<em>管理</em></h1><p className="brand-sub">沿用现有 Agent、模型、插件和技能能力，集中管理账号、授权与发布。</p><div className="feature-list"><div className="feature"><span className="feature-icon" aria-hidden="true">◇</span><div><div className="feature-title">功能配置 · 统一管理</div><div className="feature-desc">在一个工作台维护模型与智能体能力</div></div></div><div className="feature"><span className="feature-icon" aria-hidden="true">◎</span><div><div className="feature-title">账号权限 · 清晰可控</div><div className="feature-desc">管理用户角色、菜单与发布权限</div></div></div></div></div><div className="brand-foot">AITestHarness · 管理后台</div></aside><main className="form-panel"><div className="form-box"><div className="mobile-brand"><img className="brand-logo" src={brandLogo} alt="" /><b>AITestHarness</b></div><h2 className="form-title">管理员登录</h2><p className="form-desc">欢迎回来，登录后管理系统配置。</p><form onSubmit={async event => {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setError("");
    try { await controlRequest("/api/auth/admin-login", "POST", { userId: values.get("userId"), password: values.get("password") }); window.location.assign("/admin/overview"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败"); }
    finally { setBusy(false); }
  }}><div className="field"><label>账号<span className="input-wrap"><input name="userId" required autoComplete="username" placeholder="请输入管理员账号" /></span></label></div><div className="field"><label>密码<span className="input-wrap"><input name="password" required type="password" autoComplete="current-password" placeholder="请输入密码" /></span></label></div>{error && <p role="alert" className="ac-error">{error}</p>}<Button className="submit-btn" disabled={busy} type="submit">{busy ? "正在验证…" : "登录"}</Button></form><a className="admin-login-user-link" href="/user/login">前往用户端</a><div className="notice">管理后台仅供管理员使用。账号信息集中管理，项目和测试结果保留在本机。</div></div><footer className="form-foot">AITestHarness · 管理后台</footer></main></div></div>;
}
