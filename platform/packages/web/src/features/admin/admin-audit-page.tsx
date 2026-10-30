import { useEffect, useState } from "react";
import { Button, PageFrame, PageHeader } from "@prismshadow/penguin-ui";
import { controlRequest } from "../../api/control";
import "./admin-system-pages.css";
import "./admin-audit-page.css";

type Event = { id: number; actor: string; action: string; resource_id: string; resource_kind?: string | null; resource_name?: string | null; created_at: string };
const actionNames: Record<string, string> = { publish: "发布", withdraw: "下架", save: "保存草稿", delete_draft: "保存草稿", permissions: "修改权限", role_assign: "修改权限", role_menus: "修改权限", role_create: "修改权限", role_update: "修改权限", role_delete: "修改权限", menus: "修改权限", login: "登录" };
const kindNames: Record<string, string> = { agents: "智能体", models: "模型", plugins: "插件", skills: "技能" };
const actionClass: Record<string, string> = { publish: "publish", withdraw: "withdraw", save: "draft", delete_draft: "draft", permissions: "perm", role_assign: "perm", role_menus: "perm", role_create: "perm", role_update: "perm", role_delete: "perm", menus: "perm", login: "login" };
const escapeCsv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export function AdminAuditPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [type, setType] = useState("");
  const [keyword, setKeyword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      const query = new URLSearchParams({ page: String(page), type, keyword });
      void controlRequest(`/api/control/admin/audit?${query}`).then(response => {
        if (active) { setEvents(response.events); setTotal(response.total); }
      }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "读取日志失败"); })
        .finally(() => { if (active) setLoading(false); });
    }, keyword ? 200 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [page, type, keyword]);
  const pages = Math.max(1, Math.ceil(total / 10));
  const exportCsv = () => {
    const rows = [["时间", "操作人", "动作", "对象", "资源 ID"], ...events.map(event => [
      new Date(event.created_at).toLocaleString("zh-CN"), event.actor, actionNames[event.action] ?? event.action,
      event.resource_name ? `${kindNames[event.resource_kind ?? ""] ?? "资源"}：${event.resource_name}` : event.resource_id,
      event.resource_id,
    ])];
    const blob = new Blob(["\uFEFF", rows.map(row => row.map(escapeCsv).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `admin-audit-page-${page}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  return <PageFrame width="xl" className="sys-page"><PageHeader title="操作日志" description="记录管理后台的关键操作，可按动作类型和关键字筛选。" actions={<Button disabled={events.length === 0} onClick={exportCsv}>导出当前页 CSV</Button>} />
    {error && <p role="alert" className="sys-error">{error}</p>}
    <div className="sys-card sys-table-wrap"><div className="audit-toolbar"><select value={type} aria-label="动作类型" onChange={event => { setType(event.target.value); setPage(1); }}><option value="">全部类型</option><option value="publish">发布</option><option value="withdraw">下架</option><option value="draft">保存草稿</option><option value="permissions">修改权限</option><option value="login">登录</option></select><input type="search" value={keyword} placeholder="搜索操作人或对象…" aria-label="搜索操作人或对象" onChange={event => { setKeyword(event.target.value); setPage(1); }} /><small>全部记录</small></div>
      <table className="sys-table audit-table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>资源 ID</th></tr></thead><tbody>{events.map(event => {
        const date = new Date(event.created_at);
        return <tr key={event.id}><td className="audit-time">{date.toLocaleDateString("zh-CN")}<small>{date.toLocaleTimeString("zh-CN", { hour12: false })}</small></td><td><span className="audit-actor"><span className="sys-avatar">{event.actor.slice(0, 1).toUpperCase()}</span>{event.actor}</span></td><td><span className={`audit-action ${actionClass[event.action] ?? "draft"}`}>{actionNames[event.action] ?? event.action}</span></td><td>{event.resource_name ? `${kindNames[event.resource_kind ?? ""] ?? "资源"}：${event.resource_name}` : event.action === "login" ? "—" : event.resource_id}</td><td><code className="audit-id" title={event.resource_id}>{event.resource_id}</code></td></tr>;
      })}{!loading && events.length === 0 && <tr><td colSpan={5} className="sys-empty">没有匹配的操作记录</td></tr>}</tbody></table>
      <div className="audit-footer"><span>共 {total} 条 · 第 {page} / {pages} 页</span><div><button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ 上一页</button><button className="current">{page}</button><button disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页 ›</button></div></div>
    </div>
  </PageFrame>;
}
