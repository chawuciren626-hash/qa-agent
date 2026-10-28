import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { SessionInfo } from "@prismshadow/penguin-server/api";
import { apiFetch } from "../../api/client";
import { useAuth } from "../../state/auth";
import { useProject, projectDisplayName } from "../../state/project";
import { qaRead, qaScope, qaProjectForSession, qaTaskStatus, qaWorkspaceGroups } from "../../../../../../penguin/ui/workspace-ui.mjs";
import { QaProjectEntry } from "./project-entry";

type Run = { id: string; status: string; stages: { id: string; status: string }[]; artifacts: { path: string; category: string }[] };
type Task = { session: SessionInfo; runs: Run[]; unavailable: number; truncated: boolean };
const stages: Record<string,string> = { analysis: "需求分析", test_points: "测试点", test_cases: "测试用例", execution: "Web 执行", api_execution: "接口执行", defects: "缺陷分析", report: "报告" };
const statuses: Record<string,string> = { planned: "待执行", in_progress: "执行中", completed: "已完成", awaiting_confirmation: "待审核", pending_confirmation: "待审核", blocked: "阻塞", failed: "失败", skipped: "未纳入", confirmed: "已确认", revision_requested: "待修订", created: "已创建", ready: "就绪", cancelled: "已取消" };

export function QaProjectView() {
  const { currentProject, setCurrentAgentId, agents } = useProject();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState("tasks");
  const [statusFilter, setStatusFilter] = useState("");
  const [view, setView] = useState("cards");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const scrollArea = useRef<HTMLElement>(null);
  const workspaceSelect = useRef<HTMLSelectElement>(null);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ projectId: string; tasks: Task[] } | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const id = currentProject?.projectId;
  const scope = qaScope(id, user?.userId);
  const [storedGroups, setGroups] = useState(() => qaRead(scope));
  useEffect(() => {
    const update = () => setGroups(qaRead(scope));
    update();
    window.addEventListener("aitest:projects", update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener("aitest:projects", update); window.removeEventListener("storage", update); };
  }, [scope]);
  useEffect(() => { setFilter(""); setQuery(""); setStatusFilter(""); }, [id]);
  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    if (id) apiFetch<{ projectId: string; tasks: Task[] }>(`/api/projects/${encodeURIComponent(id)}/agents/qa/overview`)
      .then(value => { if (alive) setData(value); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : "项目读取失败"); });
    return () => { alive = false; };
  }, [id, revision]);
  const tasks = data && data.projectId === id ? data.tasks : [];
  const groups = qaWorkspaceGroups(storedGroups, tasks.map(t => t.session));
  const workspaceOf = useCallback((task: Task) => qaProjectForSession(groups.projects, groups.bindings, task.session), [groups]);
  const taskState = (task: Task) => {
    const state = qaTaskStatus(task.session, { pending: task.session.pendingApprovalCount });
    if (state.kind === "running" || state.kind === "error" || state.kind === "waiting") return state;
    if (task.runs.some(r => r.stages.some(s => ["awaiting_confirmation", "pending_confirmation", "revision_requested"].includes(s.status)))) return { kind: "waiting", label: "待审核" };
    return state;
  };
  const visible = tasks.filter(t => (!filter || workspaceOf(t)?.id === filter) && (!statusFilter || taskState(t).kind === statusFilter) && [t.session.title, t.session.sessionId, ...t.runs.map(r => r.id)].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const countFiles = (items: Task[], category: string) => items.reduce((n, t) => n + t.runs.reduce((m, r) => m + r.artifacts.filter(a => a.category === category).length, 0), 0);
  const tabs = [["tasks", "任务与节点", visible.length], ["cases", "项目用例", countFiles(visible, "cases")], ["defects", "缺陷产物", countFiles(visible, "defects")], ["reports", "测试报告", countFiles(visible, "reports")]] as const;
  const artifacts = visible.flatMap(task => task.runs.flatMap(run => run.artifacts.map(file => ({ task, run, file }))));
  const matchingArtifacts = artifacts.filter(a => a.file.category === tab);
  const total = tab === "tasks" ? visible.length : matchingArtifacts.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * pageSize;
  useEffect(() => { setPage(1); }, [id, tab, filter, statusFilter, query, pageSize]);
  useEffect(() => { if (data) setPage(currentPage); }, [data, currentPage]);
  useEffect(() => { if (scrollArea.current) scrollArea.current.scrollTop = 0; }, [currentPage, id, tab, filter, statusFilter, query, pageSize]);
  const open = (task: Task) => { setCurrentAgentId(task.session.agentId); navigate(`/chat/${encodeURIComponent(task.session.sessionId)}`); };
  return <main className="qa-project-view h-full min-h-0 min-w-0 overflow-hidden p-5 md:p-8" aria-label="项目视图">
    <div className="qp-layout mx-auto max-w-6xl">
      <div className="qp-fixed space-y-6">
      <header className="qp-head">
        <div><h1>项目视图</h1><p>{currentProject ? projectDisplayName(currentProject) : "未选择项目"} · 跨工作空间汇总测试任务及已有产物</p></div>
        <button className="qp-refresh" aria-label="刷新项目视图" title="刷新" disabled={!id || (!data && !error)} onClick={() => setRevision(n => n + 1)}>↻</button>
      </header>
      {!agents.some(a => a.agentId === "test_agent") && <QaProjectEntry />}
      <div className="qp-stats">
        {[["工作空间", groups.projects.length, "▦", "workspaces"], ["测试任务", tasks.length, "✓", "tasks"], ["用例文件", countFiles(tasks, "cases"), "▤", "cases"], ["HTML 报告", countFiles(tasks, "reports"), "▥", "reports"]].map(([label, count, icon, target]) => <button key={label} className="qp-stat" aria-pressed={tab === target} onClick={() => { if (target === "workspaces") { workspaceSelect.current?.focus(); } else { setTab(String(target)); setFilter(""); setStatusFilter(""); setQuery(""); } }}><span className={"qp-stat-icon qp-icon-" + target}>{icon}</span><span><strong>{data?.projectId === id ? count : "—"}</strong><small>{label}</small></span></button>)}
      </div>
      <div className="qp-tabs" role="tablist" aria-label="项目数据">
        {tabs.map(([value, label, count]) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}<span>{data ? count : "—"}</span></button>)}
      </div>
      <div className="qp-toolbar">
        <input aria-label="搜索任务名称或运行 ID" placeholder="搜索任务名称 / run id" value={query} onChange={e => setQuery(e.target.value)} />
        <select ref={workspaceSelect} aria-label="筛选工作空间" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部工作空间</option>{groups.projects.map(g => <option value={g.id} key={g.id}>{g.name}</option>)}</select>
        <select aria-label="筛选状态" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>{[["", "全部状态"], ["running", "运行中"], ["waiting", "待审核"], ["idle", "待继续 / 未开始 / 已停止"], ["done", "本轮已完成"], ["error", "执行失败"]].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select>
        <div className="qp-view-toggle" role="group" aria-label="展示方式">{[["cards", "卡片"], ["list", "列表"]].map(([v,l]) => <button key={v} aria-pressed={view === v} onClick={() => setView(v!)}>{l}</button>)}</div>
      </div>
      <p className="qp-note">会话完成不代表测试通过；用例与缺陷按已登记产物文件统计。</p>
      {data && <nav className="qp-pagination" aria-label="项目结果分页">
        <span role="status">共 {total} 条 · {total ? offset + 1 : 0}–{Math.min(offset + pageSize, total)} 条</span>
        <label>每页 <select aria-label="每页条数" value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>{[10, 20, 50].map(size => <option key={size} value={size}>{size} 条</option>)}</select></label>
        <div className="qp-page-controls">
          <button disabled={currentPage === 1} onClick={() => setPage(1)}>首页</button>
          <button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
          <label>第 <select aria-label="跳转页码" value={currentPage} onChange={e => setPage(Number(e.target.value))}>{Array.from({length: pageCount}, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select> / {pageCount} 页</label>
          <button disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
          <button disabled={currentPage === pageCount} onClick={() => setPage(pageCount)}>末页</button>
        </div>
      </nav>}
      </div>
      <section ref={scrollArea} className="qp-scroll" aria-label="项目结果" tabIndex={0}>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      {!data && !error && <p role="status">正在读取项目任务…</p>}
      {tasks.some(t => t.unavailable || t.truncated) && <p role="status">部分运行记录或文件无法读取，或超出单任务 100 次运行的展示范围，当前汇总可能不完整。</p>}
      {data && tab === "tasks" && <div className={"qp-results qp-" + view}>{visible.length === 0 && <p className="qp-empty">当前范围暂无测试任务。可调整筛选，或从左侧工作空间的“＋”开始任务。</p>}{visible.slice(offset, offset + pageSize).map(task => <article key={task.session.sessionId} className="qp-task">
        <div className="qp-task-top"><span className={"qp-badge qp-" + taskState(task).kind}><i />{taskState(task).label}</span><button className="qp-title" onClick={() => open(task)}>{task.session.title || "未命名任务"}</button></div>
        <div className="qp-meta"><span className="qp-workspace">{workspaceOf(task)?.name ?? "默认工作空间"}</span><span className="qp-run" title={task.session.workspace}>{task.runs.length ? task.runs.map(r => r.id).join(" · ") : task.session.workspace || "暂无流程记录"}</span><div className="qp-counts"><span>用例 {countFiles([task], "cases")}</span><span>报告 {countFiles([task], "reports")}</span><span>缺陷 {countFiles([task], "defects")}</span>{Number.isFinite(Date.parse(task.session.lastActiveAt)) && <time dateTime={task.session.lastActiveAt}>{new Date(task.session.lastActiveAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>}</div></div>
        {!!task.runs.length && <details className="qp-details"><summary>流程节点 · {task.runs.length} 次运行</summary>{task.runs.map(run => <div className="qp-run-detail" key={run.id}><p>{run.id} · {statuses[run.status] ?? run.status}</p><div className="qp-stages">{run.stages.map(stage => <span className="qp-stage" key={stage.id}>{stages[stage.id] ?? stage.id}：{statuses[stage.status] ?? stage.status}</span>)}</div></div>)}</details>}
      </article>)}</div>}
      {data && tab !== "tasks" && <div className={"qp-results qp-" + view}>{!artifacts.some(a => a.file.category === tab) && <p className="qp-empty">当前范围暂无已登记的对应产物。</p>}{matchingArtifacts.slice(offset, offset + pageSize).map(({task, run, file}) => <article className="qp-task" key={task.session.sessionId + "/" + run.id + "/" + file.path}><a className="qp-file" href={"/api/sessions/" + encodeURIComponent(task.session.sessionId) + "/files/content?download=1&path=" + encodeURIComponent(file.path)}>{file.path.split(/[\\/]/).at(-1)}</a><div className="qp-meta"><span className="qp-workspace">{workspaceOf(task)?.name}</span><span>{task.session.title || task.session.sessionId} · {run.id}</span><button className="qp-source" onClick={() => open(task)}>打开所属任务 ↗</button></div></article>)}</div>}
      </section>
    </div>
  </main>;
}
