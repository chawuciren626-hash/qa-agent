import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import type { SessionInfo } from "@prismshadow/penguin-server/api";
import { apiFetch } from "../../api/client";
import { useAuth } from "../../state/auth";
import { useProject, projectDisplayName } from "../../state/project";
import { workspaceFilePreviewUrl } from "../../api/endpoints";
import { ResultEvidenceFields } from "./result-evidence";
import { localizeActualResult } from "./task-results";
import { ArtifactPreview } from "./artifact-preview";
import { redactPreview } from "./artifact-preview";
import { localizedValue } from "./stage-localization";
import { DEFECT_SEVERITY_ORDER, severityLabel, severitySummary } from "./quality-traceability-model";
import { breakNumberedItems } from "./structured-text";
import "./task-detail.css";
import { qaRead, qaScope, qaProjectForSession, qaTaskStatus, qaWorkspaceGroups } from "../../../../../../penguin/ui/workspace-ui.mjs";

type CaseResult = { case_id: string; title: string; status: string; expected: string; actual_result: string; evidence_paths: string[] };
type ProjectCase = { id: string; title: string; type: string; status: string; module?: string; priority?: string; expected?: string; results?: CaseResult[] };
type ProjectDefect = { id: string; title: string; severity: string; source: string; detail?: { category?: string; lifecycle_status?: string; related_cases?: string[]; steps_to_reproduce?: string; expected_result?: string; actual_result?: string; impact?: string; recommendation?: string; evidence_refs?: string[] } };
type Run = { id: string; status: string; executionPlatform?: "web" | "android" | "miniprogram"; stages: { id: string; status: string }[]; artifacts: { path: string; category: string }[]; caseCount?: number; defectCount?: number; executed?: number; passed?: number; failed?: number; cases?: ProjectCase[]; defects?: ProjectDefect[]; activities?: { type: string; stage: string; at: string }[] };
type Task = { session: SessionInfo; runs: Run[]; unavailable: number; truncated: boolean };
const stages: Record<string,string> = { analysis: "需求分析", test_points: "测试点", test_cases: "测试用例", execution: "Web 执行", api_execution: "接口执行", defects: "缺陷分析", report: "报告" };
const statuses: Record<string,string> = { planned: "待执行", in_progress: "执行中", completed: "已完成", awaiting_confirmation: "待审核", pending_confirmation: "待审核", pending: "待审核", blocked: "阻塞", failed: "失败", skipped: "未纳入", confirmed: "已确认", revision_requested: "待修订", created: "已创建", ready: "就绪", cancelled: "已取消" };
const flow = ["analysis", "test_points", "test_cases", "automation", "defects", "report"];
const executionNodes = [{ id: "web", label: "Web 自动化" }, { id: "api", label: "接口自动化" }, { id: "app", label: "App 自动化" }, { id: "miniprogram", label: "小程序自动化" }] as const;
const flowName: Record<string, string> = { ...stages, automation: "自动化执行", web: "Web 自动化", api: "接口自动化", app: "App 自动化", miniprogram: "小程序自动化" };
const count = (tasks: Task[], field: "caseCount" | "defectCount") => tasks.reduce((sum, task) => sum + task.runs.reduce((n, run) => n + (run[field] ?? 0), 0), 0);
const fullTime = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }) : "时间未记录";
function stageStatus(run: Run | undefined, id: string): string {
  if (!run) return "planned";
  if (id === "automation") {
    const included = executionNodes.map(node => stageStatus(run, node.id)).filter(status => status !== "skipped");
    if (!included.length) return "skipped";
    if (included.some(status => ["failed", "blocked"].includes(status))) return "failed";
    if (included.some(status => ["in_progress", "awaiting_confirmation", "pending_confirmation"].includes(status))) return "in_progress";
    return included.every(status => ["completed", "confirmed"].includes(status)) ? "completed" : "planned";
  }
  if (["web", "app", "miniprogram"].includes(id)) return (run.executionPlatform ?? "web") === (id === "app" ? "android" : id === "miniprogram" ? "miniprogram" : "web") ? run.stages.find(stage => stage.id === "execution")?.status ?? "skipped" : "skipped";
  if (id === "api") return run.stages.find(stage => stage.id === "api_execution")?.status ?? "skipped";
  return run.stages.find(stage => stage.id === id)?.status ?? "planned";
}
const stageTone = (status: string) => ["completed", "confirmed"].includes(status) ? "done" : ["in_progress", "awaiting_confirmation", "pending_confirmation"].includes(status) ? "running" : ["failed", "blocked"].includes(status) ? "error" : "idle";
function TaskExpansion({ task, run, onDetail }: { task: Task; run?: Run; onDetail: () => void }) {
  const started = flow.some(id => !["planned", "skipped"].includes(stageStatus(run, id)));
  const defects = (run?.defects ?? []).slice(0, 5);
  const activities = run?.activities ?? [];
  const executed = run?.executed ?? 0;
  const designedExecuted = run?.cases?.filter(item => item.results?.some(result => ["passed", "failed", "partial", "completed"].includes(result.status))).length ?? 0;
  const untestedDesign = Math.max(0,(run?.caseCount ?? 0)-designedExecuted);
  const stageEvent = (id: string) => activities.find(event => event.stage === (id === "api" ? "api_execution" : ["web", "app", "miniprogram", "automation"].includes(id) ? "execution" : id));
  const severityStats = severitySummary(run?.defects ?? []);
  const severityRows: [string, number][] = [
    ...DEFECT_SEVERITY_ORDER.filter(level => severityStats.levels[level] > 0).map(level => [severityLabel(level), severityStats.levels[level]] as [string, number]),
    ...(severityStats.unknown ? [["未评估", severityStats.unknown] as [string, number]] : []),
    ...(severityStats.unrecorded ? [["未记录", severityStats.unrecorded] as [string, number]] : []),
  ];
  return <section id={`qp-task-expansion-${task.session.sessionId}`} className="qp-expansion" aria-label={`${task.session.title || "任务"}详情`}>
    <div className="qp-expansion-main">
      <div className="qp-panel"><div className="qp-panel-heading"><h3>执行动态</h3><button onClick={onDetail}>查看完整记录</button></div>
        {started ? <ol className="qp-timeline">{flow.map(id => { const status = stageStatus(run, id); const event = stageEvent(id); return <li className={`qp-timeline-item qp-${stageTone(status)}${id === "automation" ? " qp-timeline-parent" : ""}`} key={id}><div className="qp-timeline-row"><span className="qp-timeline-dot"/><strong>{flowName[id]}</strong><small>{statuses[status] ?? (status === "planned" ? "未开始" : status)}</small>{event && <time dateTime={event.at}>{fullTime(event.at)}</time>}</div>{id === "automation" && <ol className="qp-timeline-children">{executionNodes.map(node => { const childStatus = stageStatus(run, node.id); const childEvent = childStatus === "skipped" ? undefined : stageEvent(node.id); return <li className={`qp-timeline-child qp-${stageTone(childStatus)}`} key={node.id}><span className="qp-timeline-dot"/><strong>{node.label}</strong><small>{statuses[childStatus] ?? childStatus}</small>{childEvent && <time dateTime={childEvent.at}>{fullTime(childEvent.at)}</time>}</li>; })}</ol>}</li>; })}</ol> : <p className="qp-panel-empty">该任务尚未开始执行</p>}
      </div>
      <div className="qp-panel"><div className="qp-panel-heading"><h3>质量概览</h3></div>
        {executed ? <div className="qp-quality"><div><div className="qp-rate" style={{background:`conic-gradient(#22c55e ${Math.round((run?.passed ?? 0) / executed * 100)}%, #e5e7eb 0)`}}><strong>{Math.round((run?.passed ?? 0) / executed * 100)}%</strong></div><small>已执行记录通过率</small><p>通过 {run?.passed ?? 0} · 失败 {run?.failed ?? 0} · 已执行记录 {executed}</p><p>{run?.caseCount ? `设计用例已执行 ${designedExecuted} / ${run.caseCount} · 未测 ${untestedDesign}` : "设计用例及未测数量未登记"}</p></div><div><strong>各阶段产出</strong><p>设计用例 {run?.caseCount ?? 0} 条 · 执行记录 {executed} 条</p><div className="qp-output-bar"><span style={{width:`${run?.caseCount ? Math.min(100, designedExecuted / run.caseCount * 100) : 0}%`}} /></div><p>结果以已校验的任务产物为准</p></div><div><strong>缺陷严重度</strong>{severityRows.length ? severityRows.map(([name, value]) => <p key={name}>{name} {value}</p>) : <p>暂无缺陷</p>}<small>共 {run?.defectCount ?? 0} 个缺陷{severityStats.unknown || severityStats.unrecorded ? "；未评估/未记录不代表低风险" : ""}</small></div></div> : <p className="qp-panel-empty">该任务尚未产生执行数据</p>}
      </div>
    </div>
    <div className="qp-expansion-side">
      <div className="qp-panel"><div className="qp-panel-heading"><h3>缺陷产物速览</h3><span>共 {run?.defectCount ?? 0} 个</span></div>{defects.length ? <ul className="qp-defect-list">{defects.map((defect, index) => <li key={`${defect.id}-${index}`}><strong>{defect.title || defect.id}</strong><small>{defect.id} · {severityLabel(defect.severity)} · {flowName[defect.source] ?? defect.source}</small></li>)}</ul> : <p className="qp-panel-empty">该任务暂无缺陷</p>}</div>
      <div className="qp-panel"><div className="qp-panel-heading"><h3>最近动态</h3></div>{activities.length ? <ul className="qp-activity-list">{activities.slice(0, 5).map((activity, index) => <li key={index}><strong>{flowName[activity.stage] || activity.stage || "任务"}</strong> · {localizedValue(activity.type)}<small>{fullTime(activity.at)}</small></li>)}</ul> : <p className="qp-panel-empty">暂无动态</p>}</div>
    </div>
  </section>;
}

export function QaProjectView() {
  const { currentProject, setCurrentAgentId } = useProject();
  const { user, previewIsolated } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState("tasks");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ kind: "case"; task: Task; run: Run; item: ProjectCase } | { kind: "defect"; task: Task; run: Run; item: ProjectDefect } | { kind: "report"; task: Task; run: Run; path: string } | null>(null);
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
  const tabs = [["tasks", "任务与节点", visible.length], ["cases", "项目用例", count(visible, "caseCount")], ["defects", "缺陷清单", count(visible, "defectCount")], ["reports", "测试报告", countFiles(visible, "reports")]] as const;
  const artifacts = visible.flatMap(task => task.runs.flatMap(run => run.artifacts.map(file => ({ task, run, file }))));
  const matchingArtifacts = artifacts.filter(a => a.file.category === tab);
  const projectCases = visible.flatMap(task => task.runs.flatMap(run => (run.cases ?? []).map(item => ({ task, run, item }))));
  const projectDefects = visible.flatMap(task => task.runs.flatMap(run => (run.defects ?? []).map(item => ({ task, run, item }))));
  const total = tab === "tasks" ? visible.length : tab === "cases" ? projectCases.length : tab === "defects" ? projectDefects.length : matchingArtifacts.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * pageSize;
  useEffect(() => { setPage(1); setExpanded(null); setSelected(null); }, [id, tab, filter, statusFilter, query, pageSize]);
  useEffect(() => { if (data) setPage(currentPage); }, [data, currentPage]);
  useEffect(() => { if (scrollArea.current) scrollArea.current.scrollTop = 0; }, [currentPage, id, tab, filter, statusFilter, query, pageSize]);
  const open = (task: Task) => { setCurrentAgentId(task.session.agentId); navigate(`/chat/${encodeURIComponent(task.session.sessionId)}`); };
  const detail = (task: Task) => navigate(`/qa/project/tasks/${encodeURIComponent(task.session.sessionId)}`);
  return <main className="qa-project-view h-full min-h-0 min-w-0 overflow-hidden p-5 md:p-8" aria-label="项目视图">
    <div className="qp-layout mx-auto">
      <div className="qp-fixed space-y-6">
      <header className="qp-head">
        <div><h1>项目视图</h1><p>{currentProject ? projectDisplayName(currentProject) : "未选择项目"} · 跨工作空间汇总测试任务及已有产物</p></div>
        <button className="qp-refresh" aria-label="刷新项目视图" title="刷新" disabled={!id || (!data && !error)} onClick={() => setRevision(n => n + 1)}>↻</button>
      </header>
      <div className="qp-stats">
        {[["工作空间", groups.projects.length, "▦", "workspaces"], ["测试任务", tasks.length, "✓", "tasks"], ["用例数量", count(tasks, "caseCount"), "▤", "cases"], ["缺陷数量", count(tasks, "defectCount"), "⚑", "defects"], ["HTML 报告", countFiles(tasks, "reports"), "▥", "reports"]].map(([label, value, icon, target]) => <button key={label} className="qp-stat" aria-pressed={tab === target} onClick={() => { if (target === "workspaces") { workspaceSelect.current?.focus(); } else { setTab(String(target)); setFilter(""); setStatusFilter(""); setQuery(""); } }}><span className={"qp-stat-icon qp-icon-" + target}>{icon}</span><span><strong>{data?.projectId === id ? value : "—"}</strong><small>{label}</small></span></button>)}
      </div>
      <div className="qp-tabs" role="tablist" aria-label="项目数据">
        {tabs.map(([value, label, count]) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}<span>{data ? count : "—"}</span></button>)}
      </div>
      <div className="qp-toolbar">
        <input aria-label="搜索任务名称或运行 ID" placeholder="搜索任务名称 / run id" value={query} onChange={e => setQuery(e.target.value)} />
        <select ref={workspaceSelect} aria-label="筛选工作空间" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部工作空间</option>{groups.projects.map(g => <option value={g.id} key={g.id}>{g.name}</option>)}</select>
        <select aria-label="筛选状态" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>{[["", "全部状态"], ["running", "运行中"], ["waiting", "待审核"], ["idle", "待继续 / 未开始 / 已停止"], ["done", "本轮已完成"], ["error", "执行失败"]].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select>
      </div>
      <p className="qp-note">会话完成不代表测试通过；此处缺陷数量按已校验的运行记录求和，同一缺陷可能跨运行重复。项目级缺陷当前状态请查看质量追溯页。</p>
      </div>
      <section ref={scrollArea} className="qp-scroll" aria-label="项目结果" tabIndex={0}>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      {!data && !error && <p role="status">正在读取项目任务…</p>}
      {tasks.some(t => t.unavailable || t.truncated) && <p role="status">部分运行记录或文件无法读取，或超出单任务 100 次运行的展示范围，当前汇总可能不完整。</p>}
      {data && tab === "tasks" && <div className="qp-results qp-cards">{visible.length === 0 && <p className="qp-empty">当前范围暂无测试任务。可调整筛选，或从左侧工作空间的“＋”开始任务。</p>}{visible.slice(offset, offset + pageSize).map(task => { const run = task.runs[0]; const taskId = task.session.sessionId; const isExpanded = expanded === taskId; const toggle = () => setExpanded(current => current === taskId ? null : taskId); const active = flow.findLast(id => stageTone(stageStatus(run, id)) !== "idle"); return <div className="qp-task-group" key={taskId}><article className={`qp-task qp-task-summary${isExpanded ? " qp-expanded" : ""}`} onClick={event => { if (!(event.target as HTMLElement).closest("button, a")) toggle(); }}>
        <div className="qp-task-top"><span className={`qp-status-dot qp-${taskState(task).kind}`} /><button type="button" className="qp-title qp-task-toggle" aria-expanded={isExpanded} aria-controls={`qp-task-expansion-${taskId}`} onClick={toggle}>{task.session.title || "未命名任务"}</button><span className="qp-run-chip">{run?.id ?? "暂无执行编号"}</span><time className="qp-task-time" dateTime={task.session.createdAt ?? task.session.lastActiveAt}>{fullTime(task.session.createdAt ?? task.session.lastActiveAt)}</time><button className="qp-source" onClick={() => open(task)}>打开会话</button><button className="qp-detail-action" onClick={() => detail(task)}>任务详情</button></div>
        <div className="qp-task-bottom"><div className="qp-mini-flow" aria-label="流程进度">{flow.map(id => <span key={id} className={`qp-${stageTone(stageStatus(run, id))}`} title={`${flowName[id]}：${statuses[stageStatus(run, id)] ?? "未开始"}`} />)}</div><span className={`qp-current-stage qp-${stageTone(stageStatus(run, active ?? ""))}`}>{active ? `${flowName[active]} · ${statuses[stageStatus(run, active)] ?? "未开始"}` : "全部未开始"}</span><span className="qp-task-numbers">用例 {run?.caseCount ?? 0} · 缺陷 {run?.defectCount ?? 0}</span></div>
      </article>{isExpanded && <TaskExpansion task={task} run={run} onDetail={() => detail(task)} />}</div>; })}</div>}
      {data && tab === "cases" && <div className="qp-record-wrap"><table className="qp-record-table"><thead><tr><th>用例编号</th><th>用例名称</th><th>类型</th><th>执行结果</th><th>所属任务</th><th>操作</th></tr></thead><tbody>{projectCases.slice(offset, offset + pageSize).map(({task, run, item}, index) => <tr key={`${task.session.sessionId}/${run.id}/${item.id}/${index}`}><td>{item.id || "—"}</td><td>{item.title || "未命名用例"}</td><td>{localizedValue(item.type || "—")}</td><td>{localizedValue(item.status || "未执行")}</td><td>{task.session.title || task.session.sessionId}</td><td><button onClick={() => setSelected({kind:"case",task,run,item})}>查看</button></td></tr>)}</tbody></table>{!projectCases.length && <p className="qp-empty">暂无用例数据</p>}</div>}
      {data && tab === "defects" && <div className="qp-record-wrap"><table className="qp-record-table"><thead><tr><th>缺陷编号</th><th>缺陷标题</th><th>严重度</th><th>来源阶段</th><th>所属任务</th><th>操作</th></tr></thead><tbody>{projectDefects.slice(offset, offset + pageSize).map(({task, run, item}, index) => <tr key={`${task.session.sessionId}/${run.id}/${item.id}/${index}`}><td>{item.id || "—"}</td><td>{item.title || "未命名缺陷"}</td><td>{severityLabel(item.severity)}</td><td>{flowName[item.source] || item.source || "—"}</td><td>{task.session.title || task.session.sessionId}</td><td><button onClick={() => setSelected({kind:"defect",task,run,item})}>查看</button></td></tr>)}</tbody></table>{!projectDefects.length && <p className="qp-empty">暂无缺陷数据</p>}</div>}
      {data && tab === "reports" && <div className="qp-results qp-cards">{!matchingArtifacts.length && <p className="qp-empty">当前范围暂无已登记的测试报告。</p>}{matchingArtifacts.slice(offset, offset + pageSize).map(({task, run, file}) => <article className="qp-task" key={task.session.sessionId + "/" + run.id + "/" + file.path}><a className="qp-file" href={"/api/sessions/" + encodeURIComponent(task.session.sessionId) + "/files/content?download=1&path=" + encodeURIComponent(file.path)}>{file.path.split(/[\\/]/).at(-1)}</a><div className="qp-meta"><span className="qp-workspace">{workspaceOf(task)?.name}</span><span>{task.session.title || task.session.sessionId} · {run.id}</span><button className="qp-source" onClick={() => setSelected({kind:"report",task,run,path:file.path})}>查看</button></div></article>)}</div>}
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
      </section>
    </div>
    {selected && createPortal(<div className="qtd-mask qp-project-mask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSelected(null); }}><section className={`qtd-modal${selected.kind === "report" ? " qtd-artifact-modal" : ""}`} role="dialog" aria-modal="true" aria-label={selected.kind === "case" ? "用例执行详情" : selected.kind === "defect" ? "缺陷详情" : "测试报告预览"}><header><strong>{selected.kind === "report" ? selected.path.split("/").at(-1) : `${selected.item.id} · ${selected.item.title}`}</strong><button type="button" aria-label="关闭详情" onClick={() => setSelected(null)}>×</button></header>
      {selected.kind === "case" && <div className="qtd-detail-fields"><div><strong>执行结果</strong><span>{localizedValue(selected.item.status)}</span></div><div><strong>预期结果</strong><span>{redactPreview(selected.item.expected || "—")}</span></div><div><strong>覆盖说明</strong><span>{selected.item.results?.length ? `关联 ${selected.item.results.length} 条执行断言；不代表全部设计步骤完成。` : "尚无关联执行记录"}</span></div>{selected.item.results?.map((result, index) => <section className="qtd-assertion" key={`${result.case_id}-${index}`}><h4>{result.case_id || `断言 ${index + 1}`} · {result.status === "passed" ? "通过" : result.status === "failed" ? "不通过" : localizedValue(result.status)}</h4><div><strong>测试项</strong><span>{redactPreview(result.title || "—")}</span></div><div><strong>预期结果</strong><span>{redactPreview(result.expected || "—")}</span></div><div><strong>实际结果</strong><span>{redactPreview(localizeActualResult(result.actual_result))}</span></div><ResultEvidenceFields sessionId={selected.task.session.sessionId} runId={selected.run.id} references={result.evidence_paths}/></section>)}</div>}
      {selected.kind === "defect" && <div className="qtd-detail-fields">{[["缺陷现象", localizeActualResult(selected.item.detail?.actual_result)], ["复现步骤", selected.item.detail?.steps_to_reproduce], ["预期结果", selected.item.detail?.expected_result], ["影响范围", selected.item.detail?.impact], ["处理建议", selected.item.detail?.recommendation], ["分类", selected.item.detail?.category ? localizedValue(selected.item.detail.category) : ""], ["状态", selected.item.detail?.lifecycle_status ? localizedValue(selected.item.detail.lifecycle_status) : ""], ["严重程度", severityLabel(selected.item.severity)], ["关联用例", selected.item.detail?.related_cases?.join("、")]].map(([label, value]) => <div key={label}><strong>{label}</strong><span>{redactPreview(["复现步骤", "处理建议"].includes(label || "") ? breakNumberedItems(value || "—") : value || "—")}</span></div>)}<ResultEvidenceFields sessionId={selected.task.session.sessionId} runId={selected.run.id} references={selected.item.detail?.evidence_refs}/></div>}
      {selected.kind === "report" && <ArtifactPreview preview={{name:selected.path.split("/").at(-1) || "报告",kind:"html",text:"",url:workspaceFilePreviewUrl(selected.task.session.sessionId,selected.path),isolated:previewIsolated}}/>}
      <footer><button type="button" onClick={() => setSelected(null)}>关闭</button></footer></section></div>, document.body)}
  </main>;
}
