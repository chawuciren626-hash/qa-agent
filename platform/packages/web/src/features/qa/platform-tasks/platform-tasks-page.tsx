/**
 * 平台任务列表页（项目内一级页，T3 口径）。
 *
 * 四件套行操作（2026-11-20 确认）：
 *   编辑   平台任务=补充性字段（T4）；本地任务=全量字段
 *   查看   右侧详情抽屉（平台资料·AI 分析结论·测试进展三段式）
 *   AI分析 平台任务=失败重试/重新分析（T2）；本地任务=可选增强（T5）
 *   开始测试 创建真实测试工作会话并打开既有全流程阶段页；平台任务未分析禁用（TLQ-1），
 *           本地任务不强制（T5）
 *
 * 来源双轨：platform（任务平台映射）/ local（本地新建），徽章区分。
 * 列表仅展示平台同步任务与用户创建的本地任务。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { useProject, projectDisplayName } from "../../../state/project";
import { ENV_END_LABELS } from "../project-management/types";
import {
  analyzeTask,
  deleteTaskAttachment,
  editTask,
  getTaskDetail,
  listTaskAttachments,
  listTasks,
  startTask,
  uploadTaskAttachment,
  type AiSummary,
  type TaskAttachment,
  type TaskDetail,
  type TaskListItem,
} from "./api";
import "./platform-tasks.css";

const STATUS_LABEL: Record<string, string> = {
  pending_analysis: "待分析",
  ready: "可开始",
  in_progress: "进行中",
  impact_pending: "待确认影响",
  result_returned: "已回传",
  terminated: "已终止",
};
const SEGMENTS: Array<[string, string]> = [
  ["all", "全部"],
  ["pending_analysis", "待分析"],
  ["ready", "可开始"],
  ["in_progress", "进行中"],
  ["impact_pending", "待确认影响"],
  ["result_returned", "已回传"],
  ["terminated", "已终止"],
];
const PRIORITY_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };
const RUN_STATUS_LABEL: Record<string, string> = {
  planned: "预登记",
  running: "运行中",
  in_progress: "进行中",
  completed: "已完成",
  failed: "失败",
  unknown: "未知",
};
const RUN_KIND_LABEL: Record<string, string> = {
  run: "常规", execution: "功能执行", api_execution: "接口执行",
  regression: "回归", retest: "复测", design: "设计", legacy: "历史",
};

type EditTarget =
  | { kind: "platform"; id: string; title: string; notes: { localTitleNote: string; localTestFocusNote: string } }
  | { kind: "local"; id: string; title: string; description: string; envBaseUrl: string; account: string };

type LocalTaskPayload = { title: string; description: string; envBaseUrl: string; account: string };

export function PlatformTasksPage() {
  const navigate = useNavigate();
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId ?? null;
  const [items, setItems] = useState<TaskListItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [seg, setSeg] = useState("all");
  const [includeTerm, setIncludeTerm] = useState(false);
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerDetail, setDrawerDetail] = useState<TaskDetail | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await listTasks(projectId, includeTerm);
      setItems(data.items);
      setCounts(data.counts);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载平台任务失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [projectId, includeTerm]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = items.filter((i) => (seg === "all" ? true : i.status === seg));
  const countOf = (key: string) => (key === "all" ? items.length : counts[key] ?? 0);

  const openDrawer = async (id: string) => {
    if (!projectId) return;
    setDrawerId(id);
    setDrawerDetail(null);
    try {
      setDrawerDetail(await getTaskDetail(projectId, id));
    } catch (e) {
      toastError(e instanceof Error ? e.message : "加载详情失败");
      setDrawerId(null);
    }
  };

  const doAnalyze = async (task: TaskListItem) => {
    if (!projectId) return;
    setAnalyzing((prev) => new Set(prev).add(task.id));
    try {
      const result = await analyzeTask(projectId, task.id);
      toastSuccess(
        result.degraded
          ? `「${task.title}」AI 分析未走模型（${result.degraded.reason}），已回填演示结论`
          : `「${task.title}」AI 分析完成：结构化结论已回填`
      );
      if (drawerId === task.id) void openDrawer(task.id);
      await reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "AI 分析失败，请重试");
    } finally {
      setAnalyzing((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  const doStart = async (task: TaskListItem) => {
    if (!projectId) return;
    setStarting(task.id);
    try {
      const result = await startTask(projectId, task.id);
      toastSuccess(
        task.mainSessionId
          ? "已打开既有测试工作会话"
          : `已创建测试工作会话并进入全流程阶段页（需求分析→场景与测试点→用例设计→测试执行→缺陷分析→测试报告）`
      );
      await reload();
      navigate(`/chat/${result.sessionId}`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "开始测试失败，请重试");
    } finally {
      setStarting(null);
    }
  };

  const openEdit = (task: TaskListItem) => {
    if (task.source === "local") {
      setEditTarget({ kind: "local", id: task.id, title: task.title, description: "", envBaseUrl: "", account: "" });
      // 全量字段回填：详情加载后覆盖空值（异步 fire-and-forget）
      if (projectId) {
        void getTaskDetail(projectId, task.id)
          .then((d) => {
            setEditTarget((prev) =>
              prev && prev.kind === "local" && prev.id === task.id
                ? { ...prev, description: d.task.description ?? "", envBaseUrl: d.task.envBaseUrl ?? "", account: d.task.account ?? "" }
                : prev
            );
          })
          .catch(() => undefined);
      }
    } else {
      setEditTarget({ kind: "platform", id: task.id, title: task.title, notes: { localTitleNote: "", localTestFocusNote: "" } });
      // 抽屉里可能已有备注：详情加载后回填（异步 fire-and-forget）
      if (projectId) {
        void getTaskDetail(projectId, task.id)
          .then((d) => {
            setEditTarget((prev) =>
              prev && prev.kind === "platform" && prev.id === task.id
                ? { ...prev, notes: { localTitleNote: d.task.localTitleNote, localTestFocusNote: d.task.localTestFocusNote } }
                : prev
            );
          })
          .catch(() => undefined);
      }
    }
  };

  // 编辑保存：平台任务=补充性字段；本地任务=全量字段。新建走独立整页（platform-task-create-page）。
  const saveEdit = async (payload: { platform?: { localTitleNote: string; localTestFocusNote: string }; local?: LocalTaskPayload }) => {
    if (!projectId || !editTarget) return;
    try {
      if (editTarget.kind === "platform" && payload.platform) {
        const result = await editTask(projectId, editTarget.id, payload.platform);
        toastSuccess(
          result.analysisStale
            ? "已保存补充性字段（不被平台同步覆盖）。资料已修改，建议点「AI 分析」重新分析。"
            : "已保存补充性字段。"
        );
        setEditTarget(null);
        await reload();
      } else if (editTarget.kind === "local" && payload.local) {
        const result = await editTask(projectId, editTarget.id, payload.local);
        toastSuccess(result.analysisStale ? "本地任务已保存。内容有修改，建议重新 AI 分析。" : "本地任务已保存。");
        setEditTarget(null);
        await reload();
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : "保存失败，请重试");
    }
  };

  if (!projectId) {
    return (
      <main className="qpm-page">
        <div className="qpm-scroll">
          <div className="qpm-empty-card">
            <p className="qpm-empty-title">还没有进入项目</p>
            <p className="qpm-empty-sub">任务按项目隔离，先在顶部项目切换器中选择项目，或去项目管理新建。</p>
            <button type="button" className="qpm-btn-main" onClick={() => navigate("/qa/projects")}>去项目管理</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="qpm-page qpt-page" aria-label="测试任务">
      <div className="qpm-scroll">
        <header className="qpm-head">
          <div>
            <h1>测试任务</h1>
            <p>
              {currentProject ? projectDisplayName(currentProject) : "—"} · 来源「平台同步」+ 本地新建 ·
              平台数据由 AITestHarness 定时拉取（1 分钟/次），任务平台不主动推送
            </p>
          </div>
          <div className="qpm-head-actions">
            <button type="button" className="qpm-btn-main" onClick={() => navigate("/qa/project/platform-tasks/new")}>＋ 新建任务</button>
          </div>
        </header>

        {loadError && (
          <div className="qpm-error" role="alert">
            <p>{loadError}</p>
            <button type="button" className="qpm-btn-ghost" onClick={() => void reload()}>重试</button>
          </div>
        )}

        <div className="qpt-segbar" role="tablist" aria-label="状态筛选">
          {SEGMENTS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`qpt-seg${seg === key ? " is-active" : ""}`}
              aria-pressed={seg === key}
              onClick={() => setSeg(key)}
            >
              {label}<span className="qpt-seg-n">{countOf(key)}</span>
            </button>
          ))}
          <label className="qpt-term-toggle">
            <input type="checkbox" checked={includeTerm} onChange={(e) => setIncludeTerm(e.target.checked)} />
            显示已终止
          </label>
        </div>

        {loading ? (
          <p className="qpt-loading">加载中…</p>
        ) : visible.length === 0 ? (
          <div className="qpm-empty-card">
            <p className="qpm-empty-title">当前筛选下没有任务</p>
            <p className="qpm-empty-sub">平台同步任务会随交接包到达自动出现；也可以点「新建任务」自己建一个。</p>
            <button type="button" className="qpm-btn-main" onClick={() => navigate("/qa/project/platform-tasks/new")}>＋ 新建任务</button>
          </div>
        ) : (
          <table className="qpt-table">
            <thead>
              <tr>
                <th>任务号</th><th>任务名称</th><th>优先级</th><th>包版本</th><th>轮次</th>
                <th>AI 建议</th><th>状态</th><th className="qpt-ops-head">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => {
                const analyzingThis = analyzing.has(task.id);
                return (
                  <tr key={task.id}>
                    <td>
                      <span className="qpt-tno" title={task.sourceUrl || "本地任务"}>
                        {task.taskNo}
                        {task.sourceUrl && <a href={task.sourceUrl} target="_blank" rel="noreferrer" aria-label="打开平台任务" onClick={(e) => e.stopPropagation()}>↗</a>}
                      </span>
                    </td>
                    <td>
                      <div className="qpt-title">
                        {task.edited && <span className="qpt-edit-dot" title="本地补充字段已编辑" />}
                        <b>{task.title}</b>
                        {task.edited && <span className="qpt-edit-tag">已编辑</span>}
                      </div>
                      <div className="qpt-sub">
                        <span className={`qpt-src qpt-src-${task.source}`}>{task.source === "local" ? "本地" : "平台"}</span>
                        {task.productLines.length > 0
                          ? task.productLines.map((l) => `${l.isPrimary ? "" : "关联 "}${l.name}`).join(" · ")
                          : task.source === "local" ? "本地任务" : "—"}
                      </div>
                    </td>
                    <td>
                      {task.source === "local"
                        ? <span className="qpt-muted" title="本地任务不手工定级，以 AI 建议优先级为准">—</span>
                        : <span className={`qpt-pri qpt-pri-${task.priority}`}>{PRIORITY_LABEL[task.priority] ?? task.priority}</span>}
                    </td>
                    <td className="qpt-mono">{task.packageVersion != null ? `v${task.packageVersion}` : "—"}</td>
                    <td>{task.roundNo != null ? `第 ${task.roundNo} 轮` : "—"}</td>
                    <td>
                      {task.status === "pending_analysis" && !task.suggestedPriority
                        ? <span className="qpt-muted">—</span>
                        : task.suggestedPriority
                          ? <span className="qpt-ai">{PRIORITY_LABEL[task.suggestedPriority] ?? task.suggestedPriority}</span>
                          : <span className="qpt-muted">—</span>}
                    </td>
                    <td><span className={`qpt-pill qpt-st-${task.status}`}>{STATUS_LABEL[task.status] ?? task.status}</span></td>
                    <td>
                      <div className="qpt-ops">
                        <button type="button" className="qpt-op" onClick={() => openEdit(task)}>编辑</button>
                        <button type="button" className="qpt-op" onClick={() => void openDrawer(task.id)}>查看</button>
                        {task.status !== "result_returned" && task.status !== "terminated" && (
                          task.status === "pending_analysis" && !task.suggestedPriority ? (
                            <button
                              type="button"
                              className="qpt-op qpt-op-accent"
                              disabled={analyzingThis}
                              onClick={() => void doAnalyze(task)}
                            >
                              {analyzingThis ? "分析中…" : task.analysisSource === null && task.status === "pending_analysis" ? "重试分析" : "AI 分析"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="qpt-op qpt-op-accent"
                              disabled={analyzingThis}
                              onClick={() => void doAnalyze(task)}
                            >
                              {analyzingThis ? "分析中…" : "重新分析"}
                            </button>
                          )
                        )}
                        {task.status === "ready" && (
                          <button type="button" className="qpt-op qpt-op-main" disabled={starting === task.id} onClick={() => void doStart(task)}>
                            {starting === task.id ? "启动中…" : "开始测试"}
                          </button>
                        )}
                        {task.status === "in_progress" && (
                          <button
                            type="button"
                            className="qpt-op qpt-op-main"
                            disabled={!task.mainSessionId}
                            title={task.mainSessionId ? undefined : "会话尚未绑定"}
                            onClick={() => task.mainSessionId && navigate(`/chat/${task.mainSessionId}`)}
                          >
                            进入测试工作
                          </button>
                        )}
                        {task.status === "pending_analysis" && (
                          <button type="button" className="qpt-op" disabled title="AI 分析未完成，开始测试不可用（TLQ-1）">开始测试</button>
                        )}
                        {task.status === "impact_pending" && (
                          <button type="button" className="qpt-op qpt-op-main" onClick={() => void openDrawer(task.id)}>确认影响</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {drawerId && (
        <>
          <div className="qpt-mask" onClick={() => setDrawerId(null)} />
          <TaskDrawer
            detail={drawerDetail}
            projectId={projectId}
            onClose={() => setDrawerId(null)}
            onAnalyze={(t) => void doAnalyze(t)}
            analyzing={drawerId ? analyzing.has(drawerId) : false}
          />
        </>
      )}

      {editTarget && projectId && (
        <EditModal
          target={editTarget}
          projectId={projectId}
          onClose={() => setEditTarget(null)}
          onSave={saveEdit}
        />
      )}
    </main>
  );
}

/** 任务附件管理（B1-3b）：列表 + 上传 + 删除；正文只在分析上下文出现，明细不含内容。 */
function TaskAttachments({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [items, setItems] = useState<TaskAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void listTaskAttachments(projectId, taskId)
      .then((r) => { if (alive) setItems(r.attachments); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, taskId]);

  const reload = async () => {
    const r = await listTaskAttachments(projectId, taskId);
    setItems(r.attachments);
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 60 * 1024) { toastError(`「${file.name}」超过 60KB 上限，未上传`); continue; }
        if (!file.type.startsWith("text/") && !/\.(md|txt|json|csv|tsv|html?|xml|ya?ml|log|ini|conf)$/i.test(file.name)) {
          toastError(`「${file.name}」不是文本类文件，未上传`);
          continue;
        }
        const contentText = await file.text();
        if (!contentText.trim()) { toastError(`「${file.name}」内容为空，未上传`); continue; }
        const bytes = new TextEncoder().encode(contentText);
        let binary = "";
        bytes.forEach((b) => { binary += String.fromCharCode(b); });
        await uploadTaskAttachment(projectId, taskId, {
          filename: file.name,
          mime: file.type || "text/plain",
          dataBase64: btoa(binary),
        });
      }
      await reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "附件上传失败");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const remove = async (attachmentId: string, filename: string) => {
    setBusy(true);
    try {
      await deleteTaskAttachment(projectId, taskId, attachmentId);
      await reload();
      toastSuccess(`附件「${filename}」已删除`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "附件删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="qpt-dw-sec">
      <h3>附件 <small className="qpt-att-hint">文本类 · 单件 ≤60KB · 最多 10 件 · 作为 AI 分析补充输入</small></h3>
      {items.length === 0 ? (
        <p className="qpt-muted">暂无附件。</p>
      ) : (
        <ul className="qpt-att-list">
          {items.map((item) => (
            <li key={item.attachmentId} className="qpt-att-item">
              <span className="qpt-att-name">{item.filename}</span>
              <small>{Math.ceil(item.sizeBytes / 1024)}KB</small>
              <button type="button" onClick={() => void remove(item.attachmentId, item.filename)} disabled={busy}>删除</button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.txt,.json,.csv,.tsv,.html,.htm,.xml,.yaml,.yml,.log,.ini,.conf,.diff,.patch,.text"
        disabled={busy || items.length >= 10}
        onChange={(e) => void upload(e.target.files)}
        aria-label="上传附件"
      />
    </section>
  );
}

function TaskDrawer({ detail, projectId, onClose, onAnalyze, analyzing }: {
  detail: TaskDetail | null;
  projectId: string;
  onClose: () => void;
  onAnalyze: (task: TaskListItem) => void;
  analyzing: boolean;
}) {
  if (!detail) {
    return (
      <aside className="qpt-drawer" aria-label="任务详情">
        <header className="qpt-dw-head">
          <h2>加载中…</h2>
          <button type="button" className="qpt-dw-close" onClick={onClose}>✕</button>
        </header>
      </aside>
    );
  }
  const t = detail.task;
  const isLocal = t.source === "local";
  const s = detail.summary;
  // 执行通道分组（B5-2）：类型 × 环境 相同的运行归入同一通道。
  const channelGroups: Array<[string, typeof detail.progress.runs]> = [];
  for (const run of detail.progress.runs) {
    const channel = `${RUN_KIND_LABEL[run.kind] ?? run.kind} · ${run.env || "未绑定环境"}`;
    const group = channelGroups.find(([label]) => label === channel);
    if (group) group[1].push(run);
    else channelGroups.push([channel, [run]]);
  }
  return (
    <aside className="qpt-drawer" aria-label="任务详情">
      <header className="qpt-dw-head">
        <div>
          <h2>{t.title} <span className={`qpt-pill qpt-st-${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span></h2>
          <small className="qpt-dw-no">
            {isLocal ? `${t.id} · 本地任务` : `${t.id} · 包版本 v${t.packageVersion} · 第 ${t.roundNo} 轮`}
          </small>
        </div>
        <button type="button" className="qpt-dw-close" onClick={onClose}>✕</button>
      </header>
      <div className="qpt-dw-body">
        <section className="qpt-dw-sec">
          <h3>{isLocal ? "任务信息" : "平台资料"}</h3>
          <dl className="qpt-fgrid">
            <div><dt>{isLocal ? "任务来源" : "产品线"}</dt><dd>{isLocal ? "本地新建" : t.productLines.map((l) => `${l.isPrimary ? "" : "关联 "}${l.name}`).join(" · ") || "—"}</dd></div>
            <div><dt>反馈类型</dt><dd>{t.feedbackType || "—"}</dd></div>
            <div><dt>优先级</dt><dd><span className={`qpt-pri qpt-pri-${t.priority}`}>{PRIORITY_LABEL[t.priority] ?? t.priority}</span></dd></div>
            <div><dt>预估工时</dt><dd>{t.estimatedHours != null ? `${t.estimatedHours}h` : "—"}</dd></div>
          </dl>
          {isLocal ? (
            <>
              <div className="qpt-local-note"><b>需求描述 / 测试背景</b><p>{t.description || "（未填写）"}</p></div>
              <dl className="qpt-fgrid">
                <div><dt>涉及端</dt><dd>{t.ends.length ? t.ends.map((e) => ENV_END_LABELS[e] ?? e).join(" · ") : "—"}</dd></div>
                <div><dt>变更关联</dt><dd className="qpt-mono">{t.changeSource || "（未关联）"}</dd></div>
                <div><dt>测试环境</dt><dd className="qpt-mono">{t.envBaseUrl || "（未填写）"}</dd></div>
                <div><dt>登录账号</dt><dd>{t.account || "（未填写）"}</dd></div>
              </dl>
            </>
          ) : (
            <>
              {t.localEditedAt && (t.localTitleNote || t.localTestFocusNote) && (
                <div className="qpt-local-note">
                  <b>本地补充字段（T4，不被同步覆盖）</b>
                  {t.localTitleNote && <p>标题备注：{t.localTitleNote}</p>}
                  {t.localTestFocusNote && <p>测试重点备注：{t.localTestFocusNote}</p>}
                </div>
              )}
              {t.sourceUrl && (
                <p className="qpt-deeplink">平台深链：<a href={t.sourceUrl} target="_blank" rel="noreferrer">{t.sourceUrl} ↗</a></p>
              )}
            </>
          )}
          <TaskAttachments projectId={projectId} taskId={t.id} />
        </section>

        <section className="qpt-dw-sec">
          <h3>AI 分析结论 <span className="qpt-ai-tag">AI 建议</span></h3>
          {s ? (
            <>
              {s.requirement_summary && (
                <div className="qpt-sum-block"><h4>需求内容整理</h4><p className="qpt-reason">{s.requirement_summary}</p></div>
              )}
              <div className="qpt-sum-block"><h4>需求要点</h4><ul>{s.requirement_points.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
              <div className="qpt-sum-block"><h4>建议测试范围</h4><ul>{s.suggested_test_scope.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
              {(s.test_environment || s.test_account || s.test_password) && (
                <div className="qpt-sum-block">
                  <h4>测试环境与账号</h4>
                  <dl className="qpt-fgrid">
                    <div><dt>测试环境</dt><dd className="qpt-mono">{s.test_environment || "—"}</dd></div>
                    <div><dt>测试账号</dt><dd>{s.test_account || "—"}</dd></div>
                    <div><dt>测试密码</dt><dd>{s.test_password || "—"}</dd></div>
                  </dl>
                  <p className="qpt-reason">以上只整理任务填写内容中已提供的信息，未提供即为 —。</p>
                </div>
              )}
              <div className="qpt-sum-block">
                <h4>建议优先级：{PRIORITY_LABEL[s.suggested_priority] ?? s.suggested_priority}</h4>
                <p className="qpt-reason">{s.priority_reason}</p>
              </div>
              {s.risks.length > 0 && <div className="qpt-sum-block"><h4>风险点</h4><ul className="qpt-risk">{s.risks.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
              {s.open_questions.length > 0 && <div className="qpt-sum-block"><h4>待确认问题</h4><ul className="qpt-openq">{s.open_questions.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
              <p className="qpt-sum-foot">
                分析时间 {s.analyzed_at || "—"} · 来源：{s.source === "requirement_analysis" ? "模型分析（任务填写内容）" : s.source === "demo" ? "演示产出（模型不可用时的回退）" : s.source}
              </p>
            </>
          ) : (
            <div className="qpt-sum-empty">
              {isLocal
                ? "尚未分析：点「AI 分析」整理需求内容、测试环境与账号等结构化数据（可选）。"
                : t.status === "pending_analysis"
                  ? "尚未分析：点「AI 分析」由模型整理任务内容并产出结构化结论（T2）。"
                  : "暂无分析结论。"}
              {t.status !== "result_returned" && t.status !== "terminated" && (
                <button type="button" className="qpt-op qpt-op-accent" disabled={analyzing} onClick={() => onAnalyze(t)}>
                  {analyzing ? "分析中…" : s || t.suggestedPriority ? "重新分析" : isLocal ? "AI 分析" : "重试分析"}
                </button>
              )}
            </div>
          )}
        </section>

        <section className="qpt-dw-sec">
          <h3>测试进展 <small className="qpt-att-hint">按执行通道（类型 × 环境）分组</small></h3>
          {detail.progress.runs.length > 0 ? (
            channelGroups.map(([channel, channelRuns]) => (
              <div key={channel} className="qpt-channel">
                <h4 className="qpt-channel-head">{channel}</h4>
                {channelRuns.map((r) => (
              <div className="qpt-run" key={r.runId}>
                <div className="qpt-run-l1">
                  <span className="qpt-mono">{r.runId}</span>
                  <span className={`qpt-pill qpt-st-${r.status}`}>{RUN_STATUS_LABEL[r.status] ?? r.status}</span>
                  {r.env && <span className="qpt-pill qpt-run-env">{r.env}</span>}
                </div>
                <div className="qpt-run-l2 qpt-mono">{Object.keys(r.counts ?? {}).length ? JSON.stringify(r.counts) : (r.status === "planned" ? "预登记：等待执行发起" : "—")}</div>
              </div>
                ))}
              </div>
            ))
          ) : (
            <p className="qpt-muted">
              暂无测试运行记录。
              {isLocal && "点「开始测试」将创建测试工作会话并打开既有全流程阶段页。"}
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}

function EditModal({ target, projectId, onClose, onSave }: {
  target: EditTarget;
  projectId: string;
  onClose: () => void;
  onSave: (payload: { platform?: { localTitleNote: string; localTestFocusNote: string }; local?: LocalTaskPayload }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [localTitleNote, setLocalTitleNote] = useState(target.kind === "platform" ? target.notes.localTitleNote : "");
  const [localTestFocusNote, setLocalTestFocusNote] = useState(target.kind === "platform" ? target.notes.localTestFocusNote : "");
  const [title, setTitle] = useState(target.kind === "local" ? target.title : "");
  const [description, setDescription] = useState(target.kind === "local" ? target.description : "");
  const [envBaseUrl, setEnvBaseUrl] = useState(target.kind === "local" ? target.envBaseUrl : "");
  const [account, setAccount] = useState(target.kind === "local" ? target.account : "");
  const isLocalForm = target.kind === "local";

  const submit = async () => {
    if (isLocalForm) {
      if (!title.trim()) {
        toastError("任务名称必填");
        return;
      }
      if (!description.trim()) {
        toastError("需求描述必填：它是 AI 分析的主输入");
        return;
      }
    }
    setBusy(true);
    try {
      await onSave(
        isLocalForm
          ? { local: { title: title.trim(), description: description.trim(), envBaseUrl: envBaseUrl.trim(), account: account.trim() } }
          : { platform: { localTitleNote: localTitleNote.trim(), localTestFocusNote: localTestFocusNote.trim() } }
      );
    } finally {
      setBusy(false);
    }
  };

  const heading = target.kind === "platform" ? "编辑补充性字段" : "编辑本地任务";
  return (
    <div className="qpt-modal" role="dialog" aria-modal="true" aria-label={heading}>
      <div className="qpt-mbox">
        <header className="qpt-m-head">
          <h2>{heading}</h2>
          <button type="button" className="qpt-dw-close" onClick={onClose} disabled={busy}>✕</button>
        </header>
        <div className="qpt-m-body">
          <p className="qpt-m-hint">
            {target.kind === "platform"
              ? "平台交接包为不可变版本快照，这里只能编辑本地补充性字段；保存后作为 AI 分析的附加输入，且不会被平台后续同步覆盖（T4）。"
              : "本地任务字段全部本地可编辑，不影响任何平台数据；内容修改后建议重新 AI 分析。"}
          </p>
          {isLocalForm ? (
            <>
              <label className="qpt-field"><span>任务名称 *</span>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：导入模板边界值回归" disabled={busy} />
              </label>
              <label className="qpt-field"><span>测试环境 URL <small>选填；默认取项目环境，开始测试时自动绑定</small></span>
                <input type="text" value={envBaseUrl} onChange={(e) => setEnvBaseUrl(e.target.value)}
                  placeholder="例如 http://gateway.example.com" disabled={busy} />
              </label>
              <label className="qpt-field"><span>登录账号 <small>选填；作为 AI 分析上下文，密码请在会话内输入</small></span>
                <input type="text" value={account} onChange={(e) => setAccount(e.target.value)}
                  placeholder="例如 qa_tester" disabled={busy} />
              </label>
              <label className="qpt-field"><span>需求描述 / 测试背景 * <small>AI 分析主输入</small></span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
                  placeholder="描述要测什么、背景与预期" disabled={busy} />
              </label>
            </>
          ) : (
            <>
              <p className="qpt-m-readonly-label">平台原文（只读）：{target.title}</p>
              <label className="qpt-field"><span>本地标题备注 <small>仅本地列表展示，不改平台任务名</small></span>
                <textarea value={localTitleNote} onChange={(e) => setLocalTitleNote(e.target.value)} rows={2} />
              </label>
              <label className="qpt-field"><span>测试重点备注 <small>拼接进 AI 分析上下文，优先级低于包原文</small></span>
                <textarea value={localTestFocusNote} onChange={(e) => setLocalTestFocusNote(e.target.value)} rows={3} />
              </label>
            </>
          )}
        </div>
        <footer className="qpt-m-foot">
          <button type="button" className="qpt-op" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="qpt-op qpt-op-main" disabled={busy} onClick={() => void submit()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export type { AiSummary };
