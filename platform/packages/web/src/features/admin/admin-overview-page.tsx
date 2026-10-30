import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { controlRequest } from "../../api/control";
import { useAuth } from "../../state/auth";
import type { Publication } from "./publications-page";

type AuditEvent = { id: number; actor: string; action: string; resource_id: string; created_at: string };
const kinds = [
  { key: "agents", title: "智能体数量", path: "/agents" },
  { key: "models", title: "模型配置", path: "/models" },
  { key: "plugins", title: "插件数量", path: "/plugins" },
  { key: "skills", title: "技能数量", path: "/skills" },
] as const;
const actionNames: Record<string, string> = {
  save: "保存配置草稿", publish: "发布公共配置", withdraw: "下架公共配置",
  permissions: "修改功能权限", delete_draft: "删除草稿",
};

export function AdminOverviewPage() {
  const { accountClient } = useAuth();
  const [resources, setResources] = useState<Publication[]>([]);
  const [users, setUsers] = useState<{ userId: string }[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = async () => {
    setLoading(true); setError("");
    try {
      const [catalog, accounts, audit] = await Promise.all([
        controlRequest("/api/control/admin/resources"),
        controlRequest((accountClient ? "/api/account-client" : "") + "/api/admin/users"),
        controlRequest("/api/control/admin/audit"),
      ]);
      setResources(catalog.resources ?? []);
      setUsers(accounts.users ?? []);
      setEvents(audit.events ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "概览加载失败");
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [accountClient]);
  const summary = useMemo(() => kinds.map(kind => {
    const items = resources.filter(resource => resource.kind === kind.key);
    return { ...kind, total: items.length, published: items.filter(resource => resource.published).length };
  }), [resources]);
  const maximum = Math.max(1, ...summary.map(item => item.total));

  return <section className="admin-overview" aria-label="平台概览">
    <div className="admin-page-head"><div><h1>概览</h1><p>平台公共资源统计；用户项目、任务与个人数据保留在各自电脑。</p></div><button type="button" onClick={() => void load()} disabled={loading}>刷新</button></div>
    {error && <p role="alert" className="admin-error">{error}</p>}
    <div className="admin-stat-grid">
      <Link className="admin-stat-card" to="/users"><span>用户数量</span><strong>{loading ? "…" : users.length}</strong><small>中央账号</small></Link>
      {summary.map(item => <Link className="admin-stat-card" to={item.path} key={item.key}><span>{item.title}</span><strong>{loading ? "…" : item.total}</strong><small>已发布 {item.published}</small></Link>)}
      <Link className="admin-stat-card" to="/audit"><span>操作日志</span><strong>{loading ? "…" : events.length}</strong><small>最近 100 条操作</small></Link>
    </div>
    <div className="admin-chart-card"><div className="admin-chart-head"><strong>公共配置分布</strong><span>仅统计中央目录，不包含用户本机数据</span></div><div className="admin-chart-bars">{summary.map(item => <Link to={item.path} key={item.key} className="admin-chart-bar"><span>{item.title}</span><div><i style={{ width: `${item.total / maximum * 100}%` }} /></div><b>{item.total}</b></Link>)}</div></div>
    <div className="admin-recent-head"><h2>最近动态</h2><Link to="/audit">查看全部 →</Link></div>
    <div className="admin-table-wrap"><table><thead><tr><th>时间</th><th>事件</th><th>对象</th><th>操作人</th></tr></thead><tbody>{events.slice(0, 8).map(event => <tr key={event.id}><td>{new Date(event.created_at).toLocaleString("zh-CN")}</td><td>{actionNames[event.action] ?? event.action}</td><td className="admin-mono">{event.resource_id}</td><td>{event.actor}</td></tr>)}{!loading && events.length === 0 && <tr><td colSpan={4}>暂无管理操作记录</td></tr>}</tbody></table></div>
  </section>;
}
