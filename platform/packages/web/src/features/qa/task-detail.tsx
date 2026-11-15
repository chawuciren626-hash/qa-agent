import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { apiFetch } from "../../api/client";
import { postTask } from "../../api/endpoints";
import { workspaceFilePreviewUrl } from "../../api/endpoints";
import { useAuth } from "../../state/auth";
import { useProject } from "../../state/project";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CaseReviewTable } from "./case-review-table";
import { normalizeStageMarkdown, splitStageMarkdown } from "./stage-markdown";
import { localizeGeneratedMarkdown, localizedAgent, localizedReason } from "./stage-localization";
import { ExecutionResults } from "./execution-results";
import { DefectResults } from "./defect-results";
import { ArtifactPreview, previewKind, type ArtifactPreviewData } from "./artifact-preview";
import "./task-detail.css";

type RunIndex = { id: string; status: string };
type TaskIndex = { session: { sessionId: string; title: string; agentId: string }; runs: RunIndex[] };
type Stage = { id: string; status: string; agent: string; reason: string; revisionId: string; summary: string; questions: string[]; limitations: string[]; pendingConfirmationId: string; reviewMarkdown?: string; history: { status: string; reason: string; at: string }[] };
type Artifact = { path: string; name: string; stage: string; type: string; size: number; available: boolean; verified: boolean | null; updatedAt?: string };
type Detail = { runId: string; status: string; workflowMode: string; reviewMode: string; executionPlatform: string; stages: Stage[]; artifacts: Artifact[] };
const names: Record<string, string> = { analysis: "需求分析", test_points: "场景与测试点", test_cases: "用例设计", execution: "测试执行", api_execution: "接口执行", defects: "缺陷分析", report: "测试报告" };
const defaultStageIds = ["analysis", "test_points", "test_cases", "execution", "api_execution", "defects", "report"];
const states: Record<string, string> = { planned: "待开始", in_progress: "进行中", completed: "已交付", awaiting_confirmation: "待审核", pending_confirmation: "待审核", pending: "待审核", confirmed: "已确认", blocked: "阻塞", failed: "失败", revision_requested: "待返修", skipped: "未纳入", approved: "已确认", rejected: "已拒绝" };
const statusName = (value: string) => states[value] ?? value;
const fileUrl = (sessionId: string, file: string, download: boolean) => `/api/sessions/${encodeURIComponent(sessionId)}/files/content?path=${encodeURIComponent(file)}${download ? "&download=1" : ""}`;
const formattedSize = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${Math.ceil(size / 1024)} KB` : `${size} B`;
const artifactTime = (value?: string) => { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")} ${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}:${String(date.getSeconds()).padStart(2,"0")}`; };
type ExecutionTab = "web" | "api" | "app" | "miniprogram";
const executionTabs: { id: ExecutionTab; label: string }[] = [{ id: "web", label: "Web 自动化" }, { id: "api", label: "接口自动化" }, { id: "app", label: "App 自动化" }, { id: "miniprogram", label: "小程序自动化" }];
const executionTabFor = (id: string, platform: string): ExecutionTab => id === "api_execution" ? "api" : platform === "android" ? "app" : platform === "miniprogram" ? "miniprogram" : "web";

export function StageMarkdown({ markdown, label }: { markdown: string; label: string }) {
  const sections = splitStageMarkdown(localizeGeneratedMarkdown(normalizeStageMarkdown(markdown)));
  return <article className="qtd-markdown" aria-label={label}>{sections.map((section, index) =>
    <section className={`qtd-markdown-section qtd-markdown-section-${section.level}${section.level === 2 && sections[index + 1]?.level === 3 ? " qtd-markdown-section-parent" : ""}`} key={index}><ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown></section>
  )}</article>;
}

export function QaTaskDetail() {
  const { previewIsolated } = useAuth();
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const { currentProject, setCurrentAgentId } = useProject();
  const projectId = currentProject?.projectId;
  const [task, setTask] = useState<TaskIndex | null>(null);
  const [runId, setRunId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [stageId, setStageId] = useState("");
  const [type, setType] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<ArtifactPreviewData | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [runListRefresh, setRunListRefresh] = useState(0);
  const [approving, setApproving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [notice, setNotice] = useState("");
  const [stageTab, setStageTab] = useState<"result" | "artifacts">("result");
  const [executionTab, setExecutionTab] = useState<ExecutionTab>("web");
  const [markdown, setMarkdown] = useState("");
  const [markdownError, setMarkdownError] = useState("");
  const [caseEditing, setCaseEditing] = useState(false);
  const [preferredStage, setPreferredStage] = useState("");
  useEffect(() => { setRunId(""); setDetail(null); setPreferredStage(""); }, [projectId, sessionId]);
  useEffect(() => {
    let active = true;
    setTask(null); setError(""); setLoading(true);
    if (!projectId || !sessionId) { setRunId(""); setLoading(false); return; }
    void apiFetch<{ tasks: TaskIndex[] }>(`/api/projects/${encodeURIComponent(projectId)}/agents/qa/overview`).then(response => {
      if (!active) return;
      const found = response.tasks.find(item => item.session.sessionId === sessionId) ?? null;
      setTask(found); setRunId(previous => found?.runs.some(run => run.id === previous) ? previous : found?.runs[0]?.id ?? "");
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "读取任务失败"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, sessionId, runListRefresh]);
  useEffect(() => {
    let active = true;
    setDetail(null); setStageId(""); setType("");
    if (!projectId || !runId || !sessionId) return;
    void apiFetch<Detail>(`/api/projects/${encodeURIComponent(projectId)}/agents/qa/tasks/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`).then(value => {
      if (!active) return;
      setDetail(value);
      const selectedStage = value.stages.find(stage => stage.id === preferredStage) ?? value.stages.find(stage => stage.status === "awaiting_confirmation" || stage.status === "in_progress") ?? value.stages[0];
      setStageId(selectedStage?.id ?? "");
      setExecutionTab(executionTabFor(selectedStage?.id ?? "", value.executionPlatform));
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "读取运行详情失败"); });
    return () => { active = false; };
  }, [projectId, sessionId, runId, refresh]);
  const isExecutionStage = stageId === "execution" || stageId === "api_execution";
  const executionStageId = executionTab === "api" ? "api_execution" : "execution";
  const executionMatch = isExecutionStage && detail?.stages.some(item => item.id === executionStageId) === true && (executionTab === "api" || executionTabFor("execution", detail?.executionPlatform ?? "web") === executionTab);
  const stage = detail?.stages.find(item => item.id === (executionMatch ? executionStageId : stageId));
  const visibleStages = detail?.stages.filter((item, _index, items) => item.id !== "api_execution" || !items.some(other => other.id === "execution")) ?? [];
  const artifacts = useMemo(() => detail?.artifacts.filter(item => (!isExecutionStage || executionMatch) && item.stage === (executionMatch ? executionStageId : stageId) && (!type || item.type === type)) ?? [], [detail, stageId, isExecutionStage, executionMatch, executionStageId, type]);
  const markdownArtifact = detail?.artifacts.find(item => !isExecutionStage && stageId !== "defects" && item.stage === (executionMatch ? executionStageId : stageId) && item.available && item.verified === true && (isExecutionStage ? item.path.endsWith(executionTab === "api" ? "/execution/api/test_brief.md" : "/execution/test_brief.md") : item.name.toLowerCase().endsWith(".md")));
  useEffect(() => {
    const controller = new AbortController();
    setMarkdown(""); setMarkdownError("");
    if (!markdownArtifact) { setMarkdown(isExecutionStage && !executionMatch ? "" : stage?.reviewMarkdown ?? ""); return; }
    if (markdownArtifact.size > 512 * 1024) { setMarkdownError("文档较大，请在阶段产物中下载原文件查看。"); return; }
    void fetch(fileUrl(sessionId, markdownArtifact.path, false), { credentials: "same-origin", signal: controller.signal }).then(async response => {
      if (!response.ok) throw Error("分析原文读取失败。");
      const value = await response.text();
      if (value.length > 512 * 1024) throw Error("文档较大，请在阶段产物中下载原文件查看。");
      if (!controller.signal.aborted) setMarkdown(value);
    }).catch(cause => { if (!controller.signal.aborted) setMarkdownError(cause instanceof Error ? cause.message : "分析原文读取失败。"); });
    return () => controller.abort();
  }, [sessionId, markdownArtifact?.path, markdownArtifact?.size, stage?.reviewMarkdown, isExecutionStage, executionMatch, refresh]);
  const openChat = () => { if (task) setCurrentAgentId(task.session.agentId); navigate(`/chat/${encodeURIComponent(sessionId)}`); };
  const approveStage = async () => {
    if (!stage?.pendingConfirmationId || !projectId || approving || caseEditing) return;
    setApproving(true); setError(""); setNotice("");
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/agents/qa/tasks/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stage.id)}/approve`, { method: "POST", body: { confirmationId: stage.pendingConfirmationId } });
      setRefresh(value => value + 1);
      try { await postTask(sessionId, { input: [{ type: "text", text: `我已在任务详情页确认运行 ${runId} 的 ${names[stage.id] ?? stage.id} 阶段结果。请检查运行清单与已保存的阶段审核记录，按原计划进入下一阶段；不要把本次结果审核当成测试环境操作授权。` }], queueIfBusy: true }); }
      catch { setNotice("任务会话暂未自动继续，请打开任务会话继续。"); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "阶段审核失败，请刷新后重试。"); }
    finally { setApproving(false); }
  };
  const reviseStage = async () => {
    if (!stage?.pendingConfirmationId || !projectId || !feedback.trim() || approving) return;
    setApproving(true); setError(""); setNotice("");
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/agents/qa/tasks/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stage.id)}/revise`, { method: "POST", body: { confirmationId: stage.pendingConfirmationId, feedback: feedback.trim() } });
      setRefresh(value => value + 1); setShowFeedback(false); setFeedback("");
      try { await postTask(sessionId, { input: [{ type: "text", text: `我在任务详情页对运行 ${runId} 的 ${names[stage.id] ?? stage.id} 阶段提出疑问或修改：\n${feedback.trim()}\n返修决定和原文已写入运行记录。请核对当前状态与旧版归档，重新分析并交付该阶段结果，等待我再次确认；不要自动推进后续阶段，也不要重复执行任何测试环境操作。` }], queueIfBusy: true }); setNotice("修改意见已登记，任务会话已开始重新分析。"); }
      catch { setNotice("修改意见已登记。任务会话暂未自动继续，请打开任务会话处理返修。"); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "提交修改失败，请刷新后重试。"); }
    finally { setApproving(false); }
  };
  const askExecutionQuestion = async () => {
    if (!stage || !feedback.trim() || approving) return;
    setApproving(true); setError(""); setNotice("");
    try {
      await postTask(sessionId, { input: [{ type: "text", text: `我对运行 ${runId} 的 ${names[stage.id] ?? stage.id} 执行结果有疑问：\n${feedback.trim()}\n请核对现有证据并在任务会话中答疑。当前结果保持待审核；不要把疑问当成执行授权，也不要重复测试环境操作。如果结果需重新执行，请明确提出新运行计划。` }], queueIfBusy: true });
      setNotice("疑问已发送到任务会话；当前结果仍等待确认。"); setShowFeedback(false); setFeedback("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "发送疑问失败。"); }
    finally { setApproving(false); }
  };
  const showPreview = async (item: Artifact) => {
    setPreviewError("");
    const kind = previewKind(item.name);
    if (!kind) { setPreviewError("此格式暂不支持在线预览，请下载原文件查看。"); return; }
    if (kind === "html") { setPreview({ name: item.name, kind, text: "", url: workspaceFilePreviewUrl(sessionId, item.path), isolated: previewIsolated }); return; }
    if (item.size > 200 * 1024) { setPreviewError("文件较大，请下载原文件查看。"); return; }
    try {
      const response = await fetch(fileUrl(sessionId, item.path, false), { credentials: "same-origin" });
      if (!response.ok) throw Error("预览文件读取失败。");
      setPreview({ name: item.name, kind, text: (await response.text()).slice(0, 200 * 1024) });
    } catch (cause) { setPreviewError(cause instanceof Error ? cause.message : "预览失败"); }
  };
  return <main className="qa-task-detail" aria-label="测试任务详情">
    <header className="qtd-top"><button type="button" aria-label="返回项目视图" onClick={() => navigate("/qa/project")}>←</button><div><h1>{task?.session.title || "任务详情"}</h1><small>{sessionId}</small></div><button type="button" className="qtd-chat" onClick={openChat} disabled={!task}>打开任务会话</button></header>
    {error && <p role="alert" className="qtd-message qtd-error">{error}</p>}
    {notice && <p role="status" className="qtd-message">{notice}</p>}
    {loading && <p role="status" className="qtd-message">正在读取任务…</p>}
    {!loading && !task && !error && <p className="qtd-message">当前项目没有这个任务。</p>}
    {task && <div className="qtd-runbar"><label>本次运行 <select aria-label="选择任务运行" value={runId} disabled={task.runs.length === 0} onChange={event => { setRunId(event.target.value); setPreferredStage(""); setStageTab("result"); }}><option value="" disabled>请选择运行</option>{task.runs.map(run => <option key={run.id} value={run.id}>{run.id}</option>)}</select></label><button type="button" onClick={() => { setRunListRefresh(value => value + 1); setRefresh(value => value + 1); }}>刷新运行</button></div>}
    {task && task.runs.length === 0 && <div className="qtd-wrap"><p className="qtd-placeholder-caption">这项任务尚无已登记的运行。以下为默认阶段示意，实际阶段会按任务计划确定；可从任务会话开始测试。</p><nav className="qtd-flow" aria-label="默认流程阶段">{defaultStageIds.map((id, index) => <div className="qtd-flow-item" key={id}>{index > 0 && <span className="qtd-sep">››</span>}<div className="qtd-step"><span className="qtd-dot">{index + 1}</span><span><strong>{names[id]}</strong><small>未开始</small></span></div></div>)}</nav></div>}
    {task && task.runs.length > 0 && <div className="qtd-wrap qtd-run-detail">
      {!detail && !error && <p role="status" className="qtd-message">正在读取运行详情…</p>}
      {detail && <>
        <nav className="qtd-flow" aria-label="运行阶段">{visibleStages.map((item, index) => <div className="qtd-flow-item" key={item.id}>{index > 0 && <span className="qtd-sep">››</span>}<button type="button" className={`qtd-step ${item.id === stageId || item.id === "execution" && stageId === "api_execution" ? "current" : ""}`} aria-current={item.id === stageId || item.id === "execution" && stageId === "api_execution" ? "step" : undefined} onClick={() => { setStageId(item.id); setPreferredStage(item.id); setExecutionTab(executionTabFor(item.id, detail.executionPlatform)); setType(""); setStageTab("result"); }}><span className={`qtd-dot ${["completed", "confirmed"].includes(item.status) ? "done" : ""}`}>{["completed", "confirmed"].includes(item.status) ? "✓" : index + 1}</span><span><strong>{item.id === "execution" || item.id === "api_execution" ? "测试执行" : names[item.id] ?? item.id}</strong><small>{statusName(item.status)}</small></span></button></div>)}</nav>
        {stage ? <section className="qtd-panel"><div className="qtd-panel-head"><div className="qtd-panel-title"><h2>{isExecutionStage ? "测试执行" : names[stage.id] ?? stage.id}</h2><span>{isExecutionStage && !executionMatch ? "本次未纳入" : <>{statusName(stage.status)}{stage.agent && ` · ${localizedAgent(stage.agent)}`}{stage.revisionId && ` · 修订 ${stage.revisionId}`}</>}</span></div>
          {(!isExecutionStage || executionMatch) && stage.pendingConfirmationId && currentProject?.role === "owner" && <div className="qtd-review-actions"><button type="button" disabled={approving || caseEditing || detail.artifacts.some(item => item.stage === stage.id && (!item.available || item.verified === false))} onClick={() => void approveStage()}>{approving ? "正在确认…" : "确认当前版本并继续"}</button><button type="button" aria-expanded={showFeedback} disabled={approving} onClick={() => setShowFeedback(value => !value)}>有疑问或需要修改</button></div>}
        </div>
          {isExecutionStage && <div className="qtd-tabs qtd-execution-tabs" role="tablist" aria-label="测试执行类型">{executionTabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={executionTab === item.id} onClick={() => { setExecutionTab(item.id); setStageTab("result"); setType(""); setMarkdown(""); setMarkdownError(""); setShowFeedback(false); if (detail.stages.some(entry => entry.id === (item.id === "api" ? "api_execution" : "execution"))) setPreferredStage(item.id === "api" ? "api_execution" : "execution"); }}>{item.label}</button>)}</div>}
          {showFeedback && (!isExecutionStage || executionMatch) && stage.pendingConfirmationId && currentProject?.role === "owner" && <div className="qtd-feedback"><label htmlFor="qtd-feedback">疑问或修改意见</label><textarea id="qtd-feedback" value={feedback} onChange={event => setFeedback(event.target.value)} maxLength={4000} rows={4} placeholder="写明需要澄清或修改的内容。"/><button type="button" disabled={approving || !feedback.trim()} onClick={() => void (['execution','api_execution'].includes(stage.id) ? askExecutionQuestion() : reviseStage())}>{['execution','api_execution'].includes(stage.id) ? "提交疑问，等待答复" : "提交并重新分析"}</button></div>}
          {<div className="qtd-stage-toolbar"><div className="qtd-tabs" role="tablist" aria-label="阶段内容"><button type="button" role="tab" aria-selected={stageTab === "result"} onClick={() => setStageTab("result")}>结果</button><button type="button" role="tab" aria-selected={stageTab === "artifacts"} onClick={() => setStageTab("artifacts")}>阶段产物</button></div>{stageTab === "artifacts" && <label className="qtd-artifact-filter">产物类型 <select aria-label="筛选产物类型" value={type} onChange={event => setType(event.target.value)}><option value="">全部类型</option>{["文档", "用例", "数据", "报告"].map(value => <option key={value}>{value}</option>)}</select></label>}</div>}
          <div className="qtd-panel-body" key={`${stage.id}:${isExecutionStage ? executionTab : stageTab}`} aria-label="阶段结果与产物">
          {isExecutionStage && stageTab === "result" ? <div className="qtd-result qtd-execution-result">{!executionMatch ? <p className="qtd-message">本次运行未纳入所选执行类型。</p> : <ExecutionResults projectId={projectId!} sessionId={sessionId} runId={runId} stageId={stage.id} artifacts={detail.artifacts} refresh={refresh}/>}</div> : stageTab === "result" && <div className="qtd-result">{stage.id === "defects" && <DefectResults projectId={projectId!} sessionId={sessionId} runId={runId} artifacts={detail.artifacts} refresh={refresh}/>} {stage.id === "test_cases" && <CaseReviewTable endpoint={`/api/projects/${encodeURIComponent(projectId!)}/agents/qa/tasks/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cases`} canEdit={currentProject?.role === "owner" && !approving && !!stage.pendingConfirmationId} refresh={refresh} onBusyChange={setCaseEditing} onSaved={() => { setPreferredStage("test_cases"); setRefresh(value => value + 1); setNotice("用例已保存，阶段结果等待确认。"); }}/>}{(stage.summary || stage.reason && !["completed","confirmed","approved"].includes(stage.status) || stage.questions.length > 0 || stage.limitations.length > 0) && <div className="qtd-summary">{stage.summary && <p>{stage.summary}</p>}{stage.reason && !["completed","confirmed","approved"].includes(stage.status) && <p>当前原因：{localizedReason(stage.reason)}</p>}{stage.questions.length > 0 && <div><strong>待澄清问题</strong><ul>{stage.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></div>}{stage.limitations.length > 0 && <div><strong>限制与未覆盖范围</strong><ul>{stage.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</div>}{stage.id !== "test_cases" && stage.id !== "defects" && markdown && <StageMarkdown markdown={markdown} label="阶段分析原文"/>}{stage.id !== "test_cases" && stage.id !== "defects" && markdownArtifact && !markdown && !markdownError && <p className="qtd-message">正在读取阶段分析原文…</p>}{markdownError && <p role="alert" className="qtd-message qtd-error">{markdownError}</p>}{stage.id !== "test_cases" && stage.id !== "defects" && !markdownArtifact && !markdown && !stage.summary && !stage.reason && stage.questions.length === 0 && <p className="qtd-message">当前阶段尚无已校验的文字结果。</p>}</div>}
          {stageTab === "artifacts" && <><div className="qtd-table-wrap"><table><thead><tr><th>产物名称</th><th>更新时间</th><th>读取与校验</th><th>本次范围</th><th>操作</th></tr></thead><tbody>{artifacts.length ? artifacts.map(item => <tr key={item.path}><td><strong>{item.name}</strong><small>{item.type} · {item.available ? formattedSize(item.size) : "大小未知"}</small></td><td>{artifactTime(item.updatedAt)}</td><td><span className={`qtd-file-status ${!item.available || item.verified === false ? "bad" : ""}`}>{!item.available ? "文件不可读取" : item.verified === false ? "与交付校验不符" : item.verified ? "交付校验通过" : "已登记，可读取"}</span></td><td>本次运行已登记</td><td><div className="qtd-actions"><button type="button" disabled={!item.available} onClick={() => void showPreview(item)}>预览</button>{item.available && <a href={fileUrl(sessionId, item.path, true)} download>下载</a>}</div></td></tr>) : <tr><td colSpan={5} className="qtd-empty">这个阶段没有已登记的对应产物。</td></tr>}</tbody></table></div>
          {previewError && <p role="alert" className="qtd-message qtd-error">{previewError}</p>}
          <footer className="qtd-panel-foot">共 {artifacts.length} 项产物 · 完整结构请下载原文件查看</footer></>}
          {(!isExecutionStage || executionMatch) && stage.history.length > 0 && <div className="qtd-history"><h3>审阅历史</h3>{stage.history.map((entry, index) => <p key={index}>{entry.at ? new Date(entry.at).toLocaleString("zh-CN") : "时间未记录"} · {statusName(entry.status)}{entry.reason && ` · ${localizedReason(entry.reason)}`}</p>)}</div>}
          </div>
        </section> : <p className="qtd-message">本次运行没有可显示的阶段。</p>}
      </>}
    </div>}
    {preview && <div className="qtd-mask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPreview(null); }}><div className="qtd-modal qtd-artifact-modal" role="dialog" aria-modal="true" aria-label={`预览 ${preview.name}`}><header><strong>{preview.name}</strong><div className="qtd-preview-head-actions">{preview.kind === "html" && preview.url && <a href={preview.url} target="_blank" rel="noopener noreferrer">新窗口打开</a>}<button type="button" onClick={() => setPreview(null)} aria-label="关闭预览">✕</button></div></header><ArtifactPreview preview={preview}/><footer><button type="button" onClick={() => setPreview(null)}>关闭</button></footer></div></div>}
  </main>;
}
