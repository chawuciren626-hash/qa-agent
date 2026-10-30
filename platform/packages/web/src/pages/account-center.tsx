import { useEffect, useRef, useState } from "react";
import type { FormEvent, InputHTMLAttributes } from "react";
import "./account-center.css";

type User = { userId: string; isAdmin: boolean; disabled?: boolean; createdAt: string };
type Action = { kind: "disable" | "enable" | "revoke" | "reset" | "create"; userId: string };
const errors: Record<string, string> = {
  account_center_unavailable: "账号中心暂时无法连接，请恢复连接后重试。本地资料和已有任务保留。",
  owner_admin_required: "此账号不能认领本机管理员资料，请联系管理员。",
  invalid_credentials: "账号、密码不正确，或账号已停用。",
  user_exists: "该用户名已被使用。", registration_closed: "当前未开放注册，请联系管理员。",
  invalid_user_id: "用户名需为 2–32 位，以小写字母开头，仅含小写字母、数字和下划线。",
  invalid_password: "密码需为 8–128 位。", password_mismatch: "当前密码不正确。",
  too_many_attempts: "操作较频繁，请稍后重试。", cannot_disable_admin: "不能停用管理员账号。",
  unauthorized: "登录已失效，请重新登录。",
};
async function accountRequest(path: string, method = "GET", body?: unknown) {
  const r = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = r.status === 204 ? null : await r.json();
  if (!r.ok) throw new Error(errors[value?.error?.code] ?? "操作失败，请检查输入或稍后重试。");
  return value;
}


function Logo() {
  return <svg className="brand-logo" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#185FA5"/><path d="M32 14 48 50M32 14 16 50" stroke="white" strokeWidth="7" strokeLinecap="round"/><path d="m21 39 9 5 14-20" fill="none" stroke="#5DCAA5" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = { user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0", lock: "M5 11h14v10H5z M7 11V7a5 5 0 0 1 10 0v4", eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0", search: "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0 M17 17l5 5", plus: "M12 5v14 M5 12h14", check: "m5 12 4 4L20 5 M21 12a9 9 0 1 1-9-9", box: "m3 7 9-4 9 4-9 4-9-4v10l9 4 9-4V7 M12 11v10", info: "M12 11v6 M12 7v1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0", exit: "M9 3H3v18h6 M9 12h12 M16 7l5 5-5 5" };
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.info}/></svg>;
}
function PasswordField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (!props.value) setVisible(false); }, [props.value]);
  return <div className="field"><label><span>{label}</span><span className="input-wrap"><input {...props} aria-label={label} type={visible ? "text" : "password"} /><button type="button" className="eye-btn" aria-label={`${visible ? "隐藏" : "显示"}${label}`} aria-pressed={visible} onClick={() => setVisible(!visible)}><Icon name="eye"/></button></span></label></div>;
}
function Strength({ value }: { value: string }) {
  if (!value) return null;
  const score = value.length < 8 ? 0 : Math.min(3, 1 + Number(/[a-zA-Z]/.test(value) && /\d/.test(value)) + Number(/[^a-zA-Z0-9]/.test(value) && value.length >= 10));
  return <div className="strength show"><span className="bars">{[0,1,2].map(i => <span key={i} className={`bar ${i < score ? ["", "on-weak", "on-mid", "on-strong"][score] : ""}`}/>)}</span><span className="txt">强度提示：{["过短", "弱", "中", "强"][score]}</span></div>;
}

export function AccountCenter({ registrationEnabled, apiBase = "", onSignedIn, integrated = false }: { registrationEnabled: boolean; apiBase?: string; onSignedIn?: () => void; integrated?: boolean }) {
  const request = (path: string, method = "GET", body?: unknown) => accountRequest(apiBase + path, method, body);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [users, setUsers] = useState<User[]>([]);
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [actionName, setActionName] = useState("");
  const [actionPassword, setActionPassword] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newConfirm, setNewConfirm] = useState("");
  const [search, setSearch] = useState("");
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    try { const saved = localStorage.getItem("aitest.account.username"); if (saved) { setUsername(saved); setRemember(true); } } catch {}
  }, []);
  useEffect(() => { if (!user) { setAction(null); setActionPassword(""); setOldPassword(""); setNewPassword(""); setNewConfirm(""); setSearch(""); } }, [user]);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    document.title = "AITestHarness · 账号中心";
    void request("/api/me").then(v => setUser(v.user)).catch(() => setUser(null));
  }, []);
  useEffect(() => {
    if (!user) return;
    const refreshIdentity = () => {
      if (document.visibilityState !== "hidden") void fetch(apiBase + "/api/me", { credentials: "same-origin" }).then(r => { if (r.status === 401) { setUser(null); setNotice("登录已失效，请重新登录。"); } }).catch(() => {});
    };
    const interval = window.setInterval(refreshIdentity, 15000);
    window.addEventListener("focus", refreshIdentity);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", refreshIdentity); };
  }, [user]);
  const reload = async () => setUsers((await request("/api/admin/users")).users);
  useEffect(() => { if (user?.isAdmin && !integrated) void reload().catch(e => setError(e.message)); else setUsers([]); }, [user]);
  useEffect(() => {
    if (action) { setActionName(""); setActionPassword(""); setDialogError(""); dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [action]);

  const signIn = async (e: FormEvent) => {
    e.preventDefault(); setError(""); setNotice("");
    if (registering && password !== confirm) { setError("两次输入的密码不一致。"); return; }
    setBusy(true);
    try {
      if (registering) { await request("/api/auth/register", "POST", { userId: username.trim(), password }); setRegistering(false); }
      const result = await request("/api/auth/login", "POST", { userId: username.trim(), password });
      try { if (remember) localStorage.setItem("aitest.account.username", username.trim()); else localStorage.removeItem("aitest.account.username"); } catch {}
      setUser(result.user); setPassword(""); setConfirm(""); setRegistering(false); onSignedIn?.();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const signOut = async (all = false) => {
    setBusy(true); setError(""); setNotice("");
    try { await request(all ? "/api/me/sessions/revoke" : "/api/auth/logout", "POST", {}); setUser(null); setUsers([]); setOldPassword(""); setNewPassword(""); setNewConfirm(""); if (integrated) location.assign("/user/login"); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const changePassword = async (e: FormEvent) => {
    e.preventDefault(); setError(""); setNotice("");
    if (newPassword !== newConfirm) { setError("两次输入的新密码不一致。"); return; }
    setBusy(true);
    try {
      await request("/api/me/password", "PUT", { oldPassword, newPassword });
      setUser(null); setOldPassword(""); setNewPassword(""); setNewConfirm("");
      setNotice("密码已修改，所有账号中心登录会话已退出，请重新登录。");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const performAction = async (e: FormEvent) => {
    e.preventDefault(); if (!action) return; setBusy(true); setDialogError("");
    try {
      const base = `/api/admin/users/${encodeURIComponent(action.userId)}`;
      if (action.kind === "create") await request("/api/admin/users", "POST", { userId: actionName.trim(), password: actionPassword });
      else if (action.kind === "reset") await request(base + "/password", "POST", { password: actionPassword });
      else if (action.kind === "revoke") await request(base + "/sessions/revoke", "POST", {});
      else await request(base + "/status", "PUT", { disabled: action.kind === "disable" });
      setAction(null); setActionPassword(""); setNotice("账号操作已完成。"); await reload();
    } catch (e) { setDialogError((e as Error).message); } finally { setBusy(false); }
  };
  const actionTitle = action ? ({ create: "创建普通账号", reset: "重置密码", disable: "停用账号", enable: "启用账号", revoke: "退出全部设备" })[action.kind] : "";

  const alerts = <>{notice && <p className="ac-notice" role="status">{notice}</p>}{error && <p className="ac-error" role="alert">{error}</p>}</>;
  if (user === undefined && !integrated) return <div className="account-center ac-dashboard ac-loading" role="status">正在加载用户管理…</div>;
  if (user === null && !integrated) return <div className="account-center ac-dashboard ac-loading" role="alert">用户管理登录状态已失效，请刷新管理后台重新登录。</div>;
  if (!user) return <div className="account-center ac-login-view"><div className="layout">
    <aside className="brand-panel"><div className="brand-top"><Logo/><div className="brand-name">AITestHarness<small>软件测试智能体</small></div></div>
      <div className="brand-middle"><h1 className="brand-headline">让每一次测试<br/>都有 <em>AI</em> 全程护航</h1><p className="brand-sub">统一的账号管理，安心的本地工作体验。项目、会话、文件和测试结果保存在你的电脑。</p>
        <div className="feature-list">{[["box","测试工作 · 本地开展","项目、测试产物与个人配置由你掌握"],["user","账号统一 · 管理有序","管理员集中管理账号与登录权限"],["lock","本地优先 · 数据留在本机","业务数据与模型凭据不上传到账号中心"]].map(([icon,title,desc]) => <div className="feature" key={title}><div className="feature-icon"><Icon name={icon ?? "info"}/></div><div><div className="feature-title">{title}</div><div className="feature-desc">{desc}</div></div></div>)}</div>
      </div><div className="brand-foot">AITestHarness · 统一账号管理</div>
    </aside>
    <main className="form-panel"><div className="form-box"><div className="mobile-brand"><Logo/><b>AITestHarness</b></div><h2 className="form-title">{registering ? "注册普通账号" : "登录"}</h2><p className="form-desc">{registering ? "创建你的账号，管理员权限不开放注册。" : "欢迎回来，登录后管理你的账号。"}</p>{alerts}
    {user === undefined ? <p className="notice" role="status">正在检查登录状态…</p> : <><form onSubmit={e => void signIn(e)}>
      <div className="field"><label>用户名<span className="input-wrap"><span className="input-icon"><Icon name="user"/></span><input autoComplete="username" required maxLength={32} placeholder="请输入用户名" pattern={registering ? "[a-z][a-z0-9_]{1,31}" : undefined} value={username} onChange={e => setUsername(e.target.value)}/></span></label></div>
      {registering && <p className="pwd-rule">2–32 位，以小写字母开头，可含数字和下划线。</p>}
      <PasswordField label="密码" placeholder={registering ? "请输入 8–128 位密码" : "请输入密码"} autoComplete={registering ? "new-password" : "current-password"} required minLength={registering ? 8 : undefined} maxLength={128} value={password} onChange={e => setPassword(e.target.value)}/>
      {registering && <PasswordField label="确认密码" placeholder="请再次输入密码" autoComplete="new-password" required maxLength={128} value={confirm} onChange={e => setConfirm(e.target.value)}/>}
      <div className="form-aux"><label className="remember"><input type="checkbox" checked={remember} onChange={e => { setRemember(e.target.checked); if (!e.target.checked) try { localStorage.removeItem("aitest.account.username"); } catch {} }}/>记住用户名</label><button type="button" className="link" onClick={() => setNotice("忘记密码请联系管理员重置。")}>忘记密码？</button></div>
      <button className="submit-btn" disabled={busy}><Icon name="exit"/>{busy ? "正在处理…" : registering ? "注册并登录" : "登录"}</button>
    </form>{registrationEnabled && <><div className="divider">{registering ? "已有账号？" : "还没有账号？"}</div><div className="register-line"><button className="link" disabled={busy} onClick={() => { setRegistering(!registering); setError(""); setNotice(""); setPassword(""); setConfirm(""); }}>{registering ? "返回登录" : "注册账号"}</button></div></>}</>}
    <div className="notice"><Icon name="info"/><span>{integrated ? "账号信息由管理员集中管理，项目、文件与测试结果保留在本机。登录后进入完整工作台。" : "这里是独立账号中心。账号信息由管理员集中管理，测试业务数据保留本地；桌面统一登录尚未接入。"}</span></div></div><footer className="form-foot">AITestHarness · 账号中心</footer></main>
  </div></div>;

  const filtered = users.filter(u => u.userId.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="account-center ac-dashboard"><header className="topbar"><div className="brand"><Logo/><div className="brand-txt"><b>AITestHarness</b><span>软件测试智能体</span></div></div><div className="topbar-divider"/><span className="page-crumb">账号中心</span><div className="topbar-right">{integrated && <a className="logout-btn" href="/user/chat">返回工作台</a>}<div className="user-chip"><span className="avatar">{user.userId.charAt(0).toUpperCase()}</span><span>{user.userId}</span><span className="role-tag">{user.isAdmin ? "管理员" : "普通用户"}</span></div><button className="logout-btn" disabled={busy} onClick={() => void signOut()}><Icon name="exit"/>退出登录</button></div></header>
    <main className="container"><div className="page-head"><h1 className="page-title">账号中心</h1><p className="page-desc">统一管理账号与登录权限。<b>项目、会话、文件、测试结果和个人配置保存在你的电脑</b>，不上传到账号中心。</p></div>{alerts}
    {user.isAdmin && !integrated ? <section className="card"><div className="card-head"><h2 className="card-title">用户管理</h2><span className="count-badge">{users.length} 个账号</span><span className="spacer"/><label className="search-mini"><Icon name="search"/><input aria-label="搜索用户名" placeholder="搜索用户名" value={search} onChange={e => setSearch(e.target.value)}/></label><button className="btn-primary" disabled={busy} onClick={() => setAction({ kind: "create", userId: "" })}><Icon name="plus"/>创建普通账号</button></div>
      <div className="table-scroll" tabIndex={0} aria-label="用户列表，可横向滚动"><table><thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{filtered.map(u => <tr key={u.userId}><td><div className="u-cell"><span className={`u-avatar ${u.disabled ? "disabled" : u.isAdmin ? "admin" : "normal"}`}>{u.userId.charAt(0).toUpperCase()}</span><div><div className="u-name">{u.userId}</div><div className="u-sub">{u.userId === user.userId ? "当前登录账号" : "普通用户"}</div></div></div></td><td><span className={`role-badge ${u.isAdmin ? "admin" : "normal"}`}>{u.isAdmin ? "管理员" : "普通用户"}</span></td><td><span className={`status-pill ${u.disabled ? "off" : "ok"}`}><span className="dot"/>{u.disabled ? "已停用" : "正常"}</span></td><td className="time-cell">{new Date(u.createdAt).toLocaleDateString("zh-CN")}<small>{new Date(u.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</small></td><td>{u.isAdmin ? <span className="op-none">管理员账号受保护</span> : <div className="ops"><button className="op-btn danger" disabled={busy} onClick={() => setAction({ kind: u.disabled ? "enable" : "disable", userId: u.userId })}>{u.disabled ? "启用" : "停用"}</button><button className="op-btn" disabled={busy} onClick={() => setAction({ kind: "reset", userId: u.userId })}>重置密码</button><button className="op-btn danger" disabled={busy} onClick={() => setAction({ kind: "revoke", userId: u.userId })}>退出全部设备</button></div>}</td></tr>)}{!filtered.length && <tr><td colSpan={5} className="empty">{search ? "没有匹配的账号，请尝试其他用户名。" : "暂无账号"}</td></tr>}</tbody></table></div><div className="table-foot"><Icon name="info"/><span>停用账号会撤销账号中心的登录会话，保留账号记录；<b>不会删除</b>用户电脑上的资料。</span></div>
    </section> : <section className="card"><div className="card-head"><h2 className="card-title">账号已就绪</h2></div><p className="form-body">你可以在这里修改密码或退出设备。本地测试数据保持原样，可返回工作台继续使用完整功能。</p></section>}
    <div className="grid-2"><section className="card"><div className="card-head"><h2 className="card-title">修改我的密码</h2></div><form className="form-body" onSubmit={e => void changePassword(e)}>
      <PasswordField label="当前密码" placeholder="请输入当前密码" autoComplete="current-password" required value={oldPassword} onChange={e => setOldPassword(e.target.value)}/>
      <PasswordField label="新密码" placeholder="请输入新密码" autoComplete="new-password" required minLength={8} maxLength={128} value={newPassword} onChange={e => setNewPassword(e.target.value)}/><Strength value={newPassword}/><p className="pwd-rule">8–128 位，建议包含大小写字母、数字和符号。</p>
      <PasswordField label="确认新密码" placeholder="请再次输入新密码" autoComplete="new-password" required maxLength={128} value={newConfirm} onChange={e => setNewConfirm(e.target.value)}/><div className="form-foot"><button className="btn-primary" disabled={busy}>修改并重新登录</button><button className="btn-ghost" type="button" disabled={busy} onClick={() => void signOut(true)}>退出我的全部设备</button></div>
    </form></section><section className="card"><div className="card-head"><h2 className="card-title">账号与数据安全</h2></div><div className="info-body">{[["lock","业务数据保存在本机","项目、任务会话、测试产物、个人配置和模型凭据保留在你的电脑。"],["user","账号信息集中管理","账号身份、密码哈希与登录状态由账号中心管理。忘记密码请联系管理员。"],["check","管理登录会话","发现异常登录时，可退出账号中心的全部设备。修改密码后需要重新登录。"]].map(([icon,title,desc]) => <div className="info-item" key={title}><div className="info-ico"><Icon name={icon ?? "info"}/></div><div><b>{title}</b><p>{desc}</p></div></div>)}</div></section></div></main>
    <dialog ref={dialog} className="ac-dialog" aria-labelledby="action-title" onCancel={e => { if (busy) e.preventDefault(); else setAction(null); }}><h2 id="action-title">{actionTitle}{action?.userId ? ` · ${action.userId}` : ""}</h2><form onSubmit={e => void performAction(e)}>
      {action?.kind === "create" && <div className="field"><label>用户名<span className="input-wrap"><input required pattern="[a-z][a-z0-9_]{1,31}" maxLength={32} autoComplete="off" placeholder="小写字母、数字或下划线" value={actionName} onChange={e => setActionName(e.target.value)}/></span></label></div>}
      {(action?.kind === "create" || action?.kind === "reset") ? <PasswordField label={action.kind === "reset" ? "新密码" : "初始密码"} required minLength={8} maxLength={128} autoComplete="new-password" placeholder="请输入 8–128 位密码" value={actionPassword} onChange={e => setActionPassword(e.target.value)}/> : <p>{action?.kind === "enable" ? "启用后，用户需重新登录。" : "此操作会退出该用户在账号中心的全部登录会话。"}</p>}
      {dialogError && <p className="ac-error" role="alert">{dialogError}</p>}<div className="form-foot"><button type="button" className="btn-ghost" disabled={busy} onClick={() => setAction(null)}>取消</button><button className="btn-primary" disabled={busy}>{busy ? "处理中…" : "确认"}</button></div>
    </form></dialog></div>;
}
