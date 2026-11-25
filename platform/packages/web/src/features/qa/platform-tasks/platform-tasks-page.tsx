/**
 * 平台任务列表页（跨项目，2026-11-24 改版）。
 *
 * 口径变化：
 * - 列表是**全部项目的任务**。项目管理是独立模块（维护项目信息、环境、资料），
 *   在里面点项目视图/环境/资料不该反向筛掉别的模块的列表，所以本页不再读 currentProject
 *   作为过滤条件，改调 `/api/me/qa-platform-tasks` 按账号可访问项目聚合。
 * - 顶部筛选 = 搜索框（任务名称/任务号）+ 状态下拉 + 所属项目下拉，默认全部；
 *   原状态 tab 条（带计数）取消。页头的说明文字也去掉，只留标题与新建按钮。
 * - 「优先级」与「AI 建议」两列内容重复，只留优先级：平台任务用平台定的优先级，
 *   本地任务没有定级则以 AI 建议优先级落位（单元格标注来源）。
 *
 * 四件套行操作（2026-11-20 确认；2026-11-24 查看改全页路由、阶段页入口改名「任务详情」）：
 *   编辑     平台任务=补充性字段（T4）；本地任务=全量字段
 *   查看     任务档案详情全页 /qa/project/platform-tasks/:taskId
 *   任务详情 进入该任务的阶段工作台 /qa/project/tasks/:sessionId（全流程阶段页）
 *   AI分析   平台任务=失败重试/重新分析（T2）；本地任务=可选增强（T5）
 *   开始测试 创建真实测试工作会话并打开既有全流程阶段页；平台任务未分析禁用（TLQ-1）
 *
 * 跨项目行操作：接口仍按项目作用域，每行带 task.projectId；打开另一个项目的任务时
 * 先把该项目设为当前项目，页面里的 owner/member 判断才与任务归属一致。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { projectDisplayName, useProject } from "../../../state/project";
import { RetestScopeDrawer } from "../retest-scope-drawer";
import {
  analyzeTask,
  deleteTaskAttachment,
  editTask,
  getTaskDetail,
  listAllTasks,
  listTaskAttachments,
  startTask,
  uploadTaskAttachment,
  type AiSummary,
  type TaskAttachment,
  type TaskListItem,
} from "./api";
import "./platform-tasks.css";

const STATUS_LABEL: Record<string, string> = {
  pending_analysis: "待分析",
  ready: "可开始",
  in_progress: "进行中",
  impact_pending: "资料已更新",
  result_returned: "已回传",
  terminated: "已终止",
};
/** 状态下拉的顺序（与列表排序口径一致：越靠前越需要处理）。 */
const STATUS_ORDER_UI = ["pending_analysis", "ready", "in_progress", "impact_pending", "result_returned", "terminated"];
const PRIORITY_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };

type EditTarget = { kind: "platform" | "local"; id: string; projectId: string; title: string };

type LocalTaskPayload = { title: string; description: string; envBaseUrl: string; account: string };

/** 列表里显示的任务号：平台外部编号可能很长，表格内截断、title 给全量。 */
function shortTaskNo(task: TaskListItem): string {
  const raw = task.taskNo;
  const limit = task.source === "local" ? 14 : 20;
  return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
}

export function PlatformTasksPage() {
  const navigate = useNavigate();
  const { projects, currentProject, setCurrentProjectId } = useProject();
  const [items, setItems] = useState<TaskListItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [retestTarget, setRetestTarget] = useState<TaskListItem | null>(null);
  /** 服务端随列表下发的项目名（项目切换器未加载/缓存过期时的权威名称来源）。 */
  const [serverProjectNames, setServerProjectNames] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listAllTasks(true);
      setItems(data.items);
      setCounts(data.counts);
      setServerProjectNames(data.projectNames ?? {});
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载测试任务失败，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 所属项目名：服务端下发名 → 项目切换器里的名 → 项目 id（不隐藏任务）。 */
  const projectNameOf = (projectId: string) => {
    if (serverProjectNames[projectId]) return serverProjectNames[projectId];
    const found = projects.find((p) => p.projectId === projectId);
    return found ? projectDisplayName(found) : projectId;
  };
  /** 下拉选项：已登记项目 + 任务里出现但不在项目列表的项目（保证选项不缺）。 */
  const projectOptions = (() => {
    const known = projects.map((p) => ({ id: p.projectId, name: projectDisplayName(p) }));
    const extra = [...new Set(items.map((i) => i.projectId))]
      .filter((id) => !known.some((k) => k.id === id))
      .map((id) => ({ id, name: serverProjectNames[id] ?? id }));
    return [...known, ...extra].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  })();

  const keyword = query.trim().toLowerCase();
  const visible = items.filter((task) => {
    // 「全部」沿用原默认口径不含已终止；要看终止记录就选「已终止」。
    if (statusFilter === "all" && task.status === "terminated") return false;
    if (statusFilter !== "all" && task.status !== statusFilter) return false;
    if (projectFilter !== "all" && task.projectId !== projectFilter) return false;
    if (!keyword) return true;
    return `${task.title} ${task.taskNo}`.toLowerCase().includes(keyword);
  });
  const filtering = statusFilter !== "all" || projectFilter !== "all" || !!keyword;
  const resetFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setProjectFilter("all");
  };
  const activeCount = items.filter((i) => i.status !== "terminated").length;

  /** 打开另一个项目的任务前先切项目：页面里的 owner/member 判断要与任务归属一致。 */
  const focusProject = (projectId: string) => {
    if (currentProject?.projectId !== projectId) setCurrentProjectId(projectId);
  };

  /** 查看：任务档案详情全页。projectId 显式随查询参数传递——详情页不再依赖
   * 全局"当前项目"（切换器未加载/缓存过期时也能打开）。 */
  const openDetail = (task: TaskListItem) => {
    focusProject(task.projectId);
    navigate(`/qa/project/platform-tasks/${encodeURIComponent(task.id)}?projectId=${encodeURIComponent(task.projectId)}`);
  };

  /** 任务详情：进入该任务的阶段工作台（需求分析→…→测试报告）。 */
  const openStagePage = (task: TaskListItem) => {
    if (!task.mainSessionId) return;
    focusProject(task.projectId);
    navigate(`/qa/project/tasks/${encodeURIComponent(task.mainSessionId)}?projectId=${encodeURIComponent(task.projectId)}`);
  };

  const doAnalyze = async (task: TaskListItem) => {
    setAnalyzing((prev) => new Set(prev).add(task.id));
    try {
      const result = await analyzeTask(task.projectId, task.id);
      toastSuccess(
        result.degraded
          ? `「${task.title}」AI 分析未走模型（${result.degraded.reason}），已回填演示结论`
          : `「${task.title}」AI 分析完成：结构化结论已回填`
      );
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
    setStarting(task.id);
    try {
      const result = await startTask(task.projectId, task.id);
      toastSuccess(
        task.mainSessionId
          ? "已打开既有测试工作会话"
          : "已创建测试工作会话并进入全流程阶段页（需求分析→场景与测试点→用例设计→测试执行→缺陷分析→测试报告）"
      );
      focusProject(task.projectId);
      await reload();
      navigate(`/qa/project/tasks/${encodeURIComponent(result.sessionId)}`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "开始测试失败，请重试");
    } finally {
      setStarting(null);
    }
  };

  /* 编辑：字段回显由 EditModal 自己按 id 拉详情完成，这里只传 id/kind/项目，
     不再用「异步补 target」的方式（那会让弹窗 state 停在初始空值上）。 */
  const openEdit = (task: TaskListItem) => {
    setEditTarget({
      kind: task.source === "local" ? "local" : "platform",
      id: task.id,
      projectId: task.projectId,
      title: task.title,
    });
  };

  const saveEdit = async (payload: { platform?: { localTitleNote: string; localTestFocusNote: string }; local?: LocalTaskPayload }) => {
    if (!editTarget) return;
    const { projectId, id, kind } = editTarget;
    try {
      if (kind === "platform" && payload.platform) {
        const result = await editTask(projectId, id, payload.platform);
        toastSuccess(
          result.analysisStale
            ? "已保存补充性字段（不被平台同步覆盖）。资料已修改，建议点「AI 分析」重新分析。"
            : "已保存补充性字段。"
        );
        setEditTarget(null);
        await reload();
      } else if (kind === "local" && payload.local) {
        const result = await editTask(projectId, id, payload.local);
        toastSuccess(result.analysisStale ? "本地任务已保存。内容有修改，建议重新 AI 分析。" : "本地任务已保存。");
        setEditTarget(null);
        await reload();
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : "保存失败，请重试");
    }
  };

  return (
    <main className="qpm-page qpt-page" aria-label="测试任务">
      <div className="qpm-scroll">
        <header className="qpm-head">
          <div>
            <h1>测试任务</h1>
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

        <div className="qpt-toolbar" role="search">
          <label className="qpt-search">
            <span className="qpt-search-icon" aria-hidden="true">⌕</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索任务名称或任务号"
              aria-label="搜索任务名称或任务号"
            />
          </label>
          <label className="qpt-filter">
            <span>状态</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="按状态筛选">
              <option value="all">全部（不含已终止） · {activeCount}</option>
              {STATUS_ORDER_UI.map((key) => (
                <option key={key} value={key}>
                  {STATUS_LABEL[key]} · {counts[key] ?? 0}
                </option>
              ))}
            </select>
          </label>
          <label className="qpt-filter">
            <span>所属项目</span>
            <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="按所属项目筛选">
              <option value="all">全部项目</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          {filtering && (
            <button type="button" className="qpt-toolbar-reset" onClick={resetFilters}>重置</button>
          )}
          <span className="qpt-toolbar-count" role="status">
            {loading ? "加载中…" : `共 ${visible.length} 条${filtering ? ` / 全部 ${items.length} 条` : ""}`}
          </span>
        </div>

        {loading ? (
          <p className="qpt-loading">加载中…</p>
        ) : visible.length === 0 ? (
          <div className="qpm-empty-card">
            <p className="qpm-empty-title">{filtering ? "当前筛选下没有任务" : "还没有测试任务"}</p>
            <p className="qpm-empty-sub">
              {filtering
                ? "试试清空搜索词，或把状态、所属项目切回「全部」。"
                : "平台同步任务会随交接包到达自动出现；也可以点「新建任务」自己建一个。"}
            </p>
            {filtering
              ? <button type="button" className="qpm-btn-ghost" onClick={resetFilters}>清空筛选</button>
              : <button type="button" className="qpm-btn-main" onClick={() => navigate("/qa/project/platform-tasks/new")}>＋ 新建任务</button>}
          </div>
        ) : (
          <div className="qpt-table-wrap">
            <table className="qpt-table">
              <thead>
                <tr>
                  <th className="qpt-c-no">任务号</th>
                  <th className="qpt-c-name">任务名称</th>
                  <th className="qpt-c-project">所属项目</th>
                  <th className="qpt-c-pri">优先级</th>
                  <th className="qpt-c-ver">版本 / 轮次</th>
                  <th className="qpt-c-status">状态</th>
                  <th className="qpt-ops-head">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => {
                  const analyzingThis = analyzing.has(task.id);
                  // 优先级：平台任务用平台定的级别；本地任务不手工定级，取 AI 建议值并标注来源。
                  const priorityFromAi = task.source === "local";
                  const priority = (priorityFromAi ? task.suggestedPriority : task.priority) || task.priority || task.suggestedPriority || "";
                  const versionText = [
                    task.packageVersion != null ? `v${task.packageVersion}` : "",
                    task.roundNo != null ? `第 ${task.roundNo} 轮` : "",
                  ].filter(Boolean).join(" · ") || "—";
                  return (
                    <tr key={`${task.projectId}:${task.id}`}>
                      <td className="qpt-c-no">
                        <span className="qpt-tno" title={task.sourceUrl || task.taskNo}>
                          {shortTaskNo(task)}
                          {task.sourceUrl && (
                            <a href={task.sourceUrl} target="_blank" rel="noreferrer" aria-label="打开平台任务" onClick={(e) => e.stopPropagation()}>↗</a>
                          )}
                        </span>
                      </td>
                      <td className="qpt-c-name">
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
                      <td className="qpt-c-project">
                        <span className="qpt-project" title={task.projectId}>{projectNameOf(task.projectId)}</span>
                      </td>
                      <td className="qpt-c-pri">
                        {priority ? (
                          <span
                            className={`qpt-pri qpt-pri-${priority}`}
                            title={priorityFromAi ? "本地任务不手工定级，取 AI 建议优先级" : "平台任务优先级"}
                          >
                            {PRIORITY_LABEL[priority] ?? priority}
                            {priorityFromAi && <small className="qpt-pri-from">AI</small>}
                          </span>
                        ) : (
                          <span className="qpt-muted" title="尚未分析，暂无优先级">—</span>
                        )}
                      </td>
                      <td className="qpt-c-ver"><span className="qpt-mono">{versionText}</span></td>
                      <td className="qpt-c-status"><span className={`qpt-pill qpt-st-${task.status}`}>{STATUS_LABEL[task.status] ?? task.status}</span></td>
                      <td>
                        <div className="qpt-ops">
                          <button type="button" className="qpt-op" onClick={() => openEdit(task)}>编辑</button>
                          <button type="button" className="qpt-op" onClick={() => openDetail(task)}>查看</button>
                          {task.status !== "result_returned" && task.status !== "terminated" && (
                            <button
                              type="button"
                              className="qpt-op qpt-op-accent"
                              disabled={analyzingThis}
                              onClick={() => void doAnalyze(task)}
                            >
                              {analyzingThis ? "分析中…" : task.status === "pending_analysis" && !task.suggestedPriority ? "重试分析" : "重新分析"}
                            </button>
                          )}
                          {(task.status === "ready" || task.status === "impact_pending") && (
                            <button type="button" className="qpt-op qpt-op-main" disabled={starting === task.id} onClick={() => void doStart(task)}>
                              {starting === task.id ? "启动中…" : "开始测试"}
                            </button>
                          )}
                          {task.status === "in_progress" && (
                            <button
                              type="button"
                              className="qpt-op qpt-op-main"
                              disabled={!task.mainSessionId}
                              title={task.mainSessionId ? "进入阶段工作台" : "会话尚未绑定"}
                              onClick={() => openStagePage(task)}
                            >
                              任务详情
                            </button>
                          )}
                          {task.status === "pending_analysis" && (
                            <button type="button" className="qpt-op" disabled title="AI 分析未完成，开始测试不可用（TLQ-1）">开始测试</button>
                          )}
                          {task.status === "result_returned" && (
                            <button type="button" className="qpt-op qpt-op-accent" onClick={() => setRetestTarget(task)}>发起复测</button>
                          )}
                          {/* impact_pending 是同步层的"资料有新版本"机器状态，不是用户操作环节：
                              用户流程 = 新建→分析→开始测试；此状态只影响状态列展示与详情页资料，
                              不提供"确认影响"操作（2026-11-24 用户确认） */}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editTarget && (
        <EditModal target={editTarget} onClose={() => setEditTarget(null)} onSave={saveEdit} />
      )}

      {retestTarget && (
        <RetestScopeDrawer
          projectId={retestTarget.projectId}
          taskId={retestTarget.id}
          taskTitle={retestTarget.title}
          onClose={() => setRetestTarget(null)}
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

/**
 * 编辑弹窗：**自己按 id 拉详情**再填字段。
 *
 * 原实现由父组件异步补 target：弹窗用 useState(target.x) 初始化，详情回来时父组件换了
 * 新 target，但弹窗自己的 state 早已初始化完、不会重算 —— 于是字段全空（关掉重开才
 * 有时有值）。改成弹窗内取数：加载完成前不渲染表单，渲染时字段一定有值。
 */
function EditModal({ target, onClose, onSave }: {
  target: EditTarget;
  onClose: () => void;
  onSave: (payload: { platform?: { localTitleNote: string; localTestFocusNote: string }; local?: LocalTaskPayload }) => Promise<void>;
}) {
  const isLocalForm = target.kind === "local";
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [localTitleNote, setLocalTitleNote] = useState("");
  const [localTestFocusNote, setLocalTestFocusNote] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [envBaseUrl, setEnvBaseUrl] = useState("");
  const [account, setAccount] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError("");
    void getTaskDetail(target.projectId, target.id)
      .then((d) => {
        if (!alive) return;
        setTitle(d.task.title ?? "");
        setDescription(d.task.description ?? "");
        setEnvBaseUrl(d.task.envBaseUrl ?? "");
        setAccount(d.task.account ?? "");
        setLocalTitleNote(d.task.localTitleNote ?? "");
        setLocalTestFocusNote(d.task.localTestFocusNote ?? "");
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : "读取任务详情失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [target.projectId, target.id]);

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

  const heading = isLocalForm ? "编辑本地任务" : "编辑补充性字段";
  return (
    <div className="qpt-modal" role="dialog" aria-modal="true" aria-label={heading}>
      <div className="qpt-mbox">
        <header className="qpt-m-head">
          <h2>{heading}</h2>
          <button type="button" className="qpt-dw-close" onClick={onClose} disabled={busy}>✕</button>
        </header>
        <div className="qpt-m-body">
          {loading ? (
            <p className="qpt-muted">正在读取任务内容…</p>
          ) : loadError ? (
            <p className="qpt-m-error" role="alert">内容读取失败：{loadError}。请关闭后重试。</p>
          ) : (
            <>
              <p className="qpt-m-hint">
                {isLocalForm
                  ? "本地任务字段全部本地可编辑，不影响任何平台数据；内容修改后建议重新 AI 分析。"
                  : "平台交接包为不可变版本快照，这里只能编辑本地补充性字段；保存后作为 AI 分析的附加输入，且不会被平台后续同步覆盖（T4）。"}
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
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={10}
                      placeholder="描述要测什么、背景与预期" disabled={busy} />
                  </label>
                </>
              ) : (
                <>
                  <p className="qpt-m-readonly-label">平台原文（只读）：{title}</p>
                  <label className="qpt-field"><span>本地标题备注 <small>仅本地列表展示，不改平台任务名</small></span>
                    <textarea value={localTitleNote} onChange={(e) => setLocalTitleNote(e.target.value)} rows={2} disabled={busy} />
                  </label>
                  <label className="qpt-field"><span>测试重点备注 <small>拼接进 AI 分析上下文，优先级低于包原文</small></span>
                    <textarea value={localTestFocusNote} onChange={(e) => setLocalTestFocusNote(e.target.value)} rows={4} disabled={busy} />
                  </label>
                </>
              )}
            </>
          )}
        </div>
        <footer className="qpt-m-foot">
          <button type="button" className="qpt-op" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="qpt-op qpt-op-main" disabled={busy || loading || !!loadError} onClick={() => void submit()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export type { AiSummary };
