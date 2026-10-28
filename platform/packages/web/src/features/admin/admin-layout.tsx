import { AppLayout } from "../../components/layout/app-layout";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { Button, PageFrame, PageHeader } from "@prismshadow/penguin-ui";
import { useAuth } from "../../state/auth";
import { useProject } from "../../state/project";
import { controlRequest } from "../../api/control";
import { AccountCenter } from "../../pages/account-center";
import { PublicationsPage, RESOURCE_NAMES } from "./publications-page";
import type { ManagedKind } from "../../lib/managed-resources";
import { useUpdateBadges } from "../../lib/use-update-badges";
import "./admin-layout.css";

const modules: Record<string, string> = { chat: "测试任务", projects: "项目视图", library: "资料库", schedules: "定时任务", agents: "多智能体", models: "模型库", plugins: "插件市场", skills: "技能", machines: "机器管理", usage: "成本中心", benchmark: "评估中心" };
const entries = { agents: "智能体管理", models: "模型库", plugins: "插件管理", skills: "技能管理", users: "账号管理", permissions: "功能权限", audit: "发布记录" };

function AdminChrome({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const active = location.pathname.startsWith("/publications/") ? location.pathname.split("/")[2] : location.pathname.split("/")[1];
  return <div className="admin-shell"><header><strong>AITestHarness · 管理后台</strong><div><a href="/user/">用户工作台 ↗</a><span>{user?.userId}</span><Button size="sm" onClick={() => void logout().then(() => window.location.assign("/admin/login"))}>退出</Button></div></header><div className="admin-body"><nav aria-label="管理后台模块">{Object.entries(entries).map(([key, title]) => <Link key={key} className={active === key ? "active" : ""} to={`/${key}`}>{title}</Link>)}<p>配置编辑沿用现有功能<br/>公开内容按授权发布</p></nav><main>{children}</main></div></div>;
}

/** The identity server stays a publication store, never a remote user workspace. */
export function AdminHostGate({ children }: { children: ReactNode }) {
  const [central, setCentral] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const location = useLocation();
  useEffect(() => { void controlRequest("/api/account-client/config").then(config => setCentral(config.central === true)).catch(cause => setError(cause.message)); }, []);
  if (error) return <p role="alert">{error}</p>;
  if (central === null) return <p className="p-8">正在连接管理服务…</p>;
  if (!central) return children;
  const section = location.pathname.split("/")[1] || "agents";
  return <AdminChrome>{section === "users" ? <AdminAccountsPage /> : section === "permissions" ? <AdminPermissionsPage /> : section === "audit" ? <AdminAuditPage /> : <PublicationsPage central resourceKind={(section === "publications" ? location.pathname.split("/")[2] : section) as ManagedKind} />}</AdminChrome>;
}

export function AdminLayout() {
  const { currentProject, projects, setCurrentProjectId } = useProject();
  const { user, logout } = useAuth();
  const location = useLocation();
  const section = location.pathname.split("/")[1] as ManagedKind;
  const active = section === ("publications" as string) ? location.pathname.split("/")[2] : section;
  const navigation = <nav className="admin-local-nav" aria-label="管理后台模块"><strong>AITestHarness</strong><p>Web 管理后台</p>{Object.entries(entries).map(([key, title]) => <Link key={key} className={active === key ? "active" : ""} to={`/${key}`}>{title}</Link>)}<footer><a href="/user/">返回用户工作台 ↗</a><p>{user?.userId} · 管理员</p><Button size="sm" onClick={() => void logout().then(() => window.location.assign("/admin/login"))}>退出登录</Button></footer></nav>;
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
    <div className="mb-6 flex flex-wrap gap-5">{Object.entries(modules).map(([key, title]) => <label key={key} className="flex gap-2"><input type="checkbox" disabled={!selected || busy} checked={grants.includes(key)} onChange={event => setGrants(event.target.checked ? [...grants, key] : grants.filter(grant => grant !== key))} />{title}</label>)}</div>
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
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (user?.isAdmin) return <div className="p-8"><p>已登录管理员账号。</p><Button onClick={() => navigate("/agents", { replace: true })}>进入管理后台</Button></div>;
  return <div className="admin-login"><aside><strong>AITestHarness</strong><h1>统一配置<br />集中管理</h1><p>沿用现有智能体、模型、插件和技能能力<br />增加授权与发布管理</p></aside><form onSubmit={async event => {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setError("");
    try { await controlRequest("/api/auth/admin-login", "POST", { userId: values.get("userId"), password: values.get("password") }); window.location.assign("/admin/agents"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败"); }
    finally { setBusy(false); }
  }}><p>Web 管理后台 · 仅管理员</p><h2>管理员登录</h2><label>账号<input name="userId" required autoComplete="username" /></label><label>密码<input name="password" required type="password" autoComplete="current-password" /></label>{error && <p role="alert">{error}</p>}<Button disabled={busy} type="submit">{busy ? "正在验证…" : "登录"}</Button><a href="/user/login">前往用户端</a></form></div>;
}
