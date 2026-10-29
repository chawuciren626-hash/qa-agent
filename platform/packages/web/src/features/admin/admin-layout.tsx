import { AppLayout } from "../../components/layout/app-layout";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Button, PageFrame, PageHeader } from "@prismshadow/penguin-ui";
import { useAuth } from "../../state/auth";
import { useProject } from "../../state/project";
import { controlRequest } from "../../api/control";
import { AccountCenter } from "../../pages/account-center";
import { PublicationsPage, RESOURCE_NAMES } from "./publications-page";
import { CentralResourcesPage } from "./central-resources-page";
import { AdminOverviewPage } from "./admin-overview-page";
import type { ManagedKind } from "../../lib/managed-resources";
import { useUpdateBadges } from "../../lib/use-update-badges";
import { SettingsDialog } from "../settings/settings-dialog";
import { rememberedWorkspace, rememberWorkspace } from "../../lib/local-workspace";
import brandLogo from "../../../../../../penguin/ui/aith-logo.svg?url";
import brandLogoLight from "../../../../../../penguin/ui/aith-logo-light.svg?url";
import "./admin-layout.css";

const modules: Record<string, string> = { chat: "测试任务", projects: "项目视图", library: "项目资料", schedules: "定时任务", agents: "多智能体", models: "模型库", plugins: "插件市场", skills: "技能", machines: "机器管理", usage: "成本中心", benchmark: "评估中心" };
const entries = {
  overview: "概览",
  agents: "多智能体管理",
  models: "模型配置",
  plugins: "插件管理",
  users: "用户管理",
  skills: "技能管理",
  permissions: "功能权限",
  audit: "发布记录",
};
const navIcons: Record<string, ReactNode> = {
  overview: <><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></>,
  agents: <><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></>,
  models: <><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"/></>,
  plugins: <><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1"/></>,
  users: <><circle cx="9" cy="7" r="4"/><path d="M1 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2M16 3.2a4 4 0 0 1 0 7.6M23 21v-2a4 4 0 0 0-3-3.9"/></>,
  skills: <><path d="m12 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></>,
  permissions: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
  audit: <><path d="M7 3h10l3 3v15H4V3h3zM8 11h8M8 15h8M8 19h5"/></>,
};

function AdminNavigation({ central, userView }: { central: boolean; userView: string | null }) {
  const { user, logout } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const location = useLocation();
  const section = location.pathname.split("/")[1] || "overview";
  const active = section === "publications" ? location.pathname.split("/")[2] : section;
  const row = ([key, title]: [string, string]) => <Link key={key} className={`admin-nav-item${active === key ? " active" : ""}`} to={`/${key}`} aria-current={active === key ? "page" : undefined}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{navIcons[key]}</svg>{title}</Link>;
  return <aside className="admin-side" aria-label="管理员导航">
    <div className="admin-brand"><span className="admin-brand-mark" aria-hidden="true"><img className="admin-logo-default" src={brandLogo} alt="" draggable={false}/><img className="admin-logo-light" src={brandLogoLight} alt="" draggable={false}/></span><strong>AITestHarness</strong></div>
    <div className="admin-side-scroll"><nav>{Object.entries(entries).map(row)}</nav></div>
    <details className="admin-account"><summary><span className="admin-avatar">{(user?.displayName ?? user?.userId ?? "A").slice(0, 1).toUpperCase()}</span><span className="admin-account-name">{user?.displayName ?? user?.userId}</span><span className="admin-account-role">管理员</span></summary><div className="admin-account-menu"><p>当前：管理员视图</p><a href={central ? "/user/" : userView ?? "/user/"}>切换到用户视图</a><button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setSettingsOpen(true); }}>设置</button><button type="button" onClick={() => void logout().then(() => window.location.assign("/admin/login"))}>退出登录</button></div></details>
    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} accountCenter={central} />
    {!central && <span className="admin-local-hint">公共配置与本机项目分开保存</span>}
  </aside>;
}

function userViewUrl(): string | null {
  return rememberedWorkspace();
}

function AdminChrome({ children }: { children: ReactNode }) {
  const userView = userViewUrl();
  return <div className="admin-shell"><AdminNavigation central userView={userView}/><main className="admin-main">{children}</main></div>;
}

/** The identity server stays a publication store, never a remote user workspace. */
export function AdminHostGate({ children }: { children: ReactNode }) {
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
  if (!central) return <div className="admin-web-only"><h1>管理后台仅在 Web 端开放</h1><p>桌面客户端只提供用户视图。请在浏览器访问中央管理后台。</p>{adminOrigin && <a href={new URL("/admin/overview", adminOrigin).href} target="_blank" rel="noopener noreferrer">打开 Web 管理后台 ↗</a>}</div>;
  const section = location.pathname.split("/")[1] || "agents";
  const kind = (section === "publications" ? location.pathname.split("/")[2] : section) as ManagedKind;
  return <AdminChrome>{section === "overview" ? <AdminOverviewPage /> : section === "users" ? <AdminAccountsPage /> : section === "permissions" ? <AdminPermissionsPage /> : section === "audit" ? <AdminAuditPage /> : kind in RESOURCE_NAMES ? <CentralResourcesPage key={kind} kind={kind} /> : <PageFrame>未知管理模块。</PageFrame>}</AdminChrome>;
}

export function AdminLayout() {
  const { currentProject, projects, setCurrentProjectId } = useProject();
  const location = useLocation();
  const section = location.pathname.split("/")[1] as ManagedKind;
  const navigation = <AdminNavigation central={false} userView={userViewUrl() ?? "/user/"}/>;
  const toolbar = <div className="admin-tools"><label>本机配置项目 <select aria-label="管理后台配置项目" value={currentProject?.projectId || ""} onChange={event => setCurrentProjectId(event.target.value)}>{projects.map(project => <option key={project.projectId} value={project.projectId}>{project.name || project.projectId}</option>)}</select></label>{section in RESOURCE_NAMES && <Link to={`/publications/${section}`}>{RESOURCE_NAMES[section]}授权与发布 →</Link>}</div>;
  return <AppLayout navigation={navigation} toolbar={toolbar} />;
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

export function AdminAuditPage() {
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { void controlRequest("/api/control/admin/audit").then(response => setEvents(response.events)).catch(cause => setError(cause.message)); }, []);
  return <PageFrame><PageHeader title="发布记录" />{error && <p role="alert">{error}</p>}<div className="space-y-3">{events.map(event => <div key={event.id} className="rounded border p-3 text-sm">{new Date(event.created_at).toLocaleString()} · {event.actor} · {({ save: "保存草稿/授权", publish: "发布", withdraw: "下架", permissions: "修改权限" } as Record<string, string>)[event.action] || event.action}<p className="opacity-60">{event.resource_id}</p></div>)}</div></PageFrame>;
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
