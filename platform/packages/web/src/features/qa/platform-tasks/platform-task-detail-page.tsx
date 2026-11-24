/**
 * 平台任务详情全页（/qa/project/platform-tasks/:taskId）。
 *
 * 结构（2026-11-24 确认的字段级结构化重排，替代原侧边抽屉）：
 *   ① 头部：任务标题/编号/版本/轮次/状态 + 返回列表
 *   ② 基本信息：产品线/反馈类型/优先级/复杂度/预估/提交人处理人/平台任务链接
 *   ③ 内容整理：交接包字段级结构化（ai_structured_result / final_content / 验收口径 / 遗漏字段）
 *   ④ 原始反馈：正文 + 富文本 + 补充意见（含操作人/时间）
 *   ⑤ 研发判断：自测提交记录（字段级 sections）+ 节点变更记录（含结构化 sections）+ 包附件/三份文档引用
 *      + 回归上下文（上轮失败问题/整改说明）
 *   ⑥ AI 分析结论（既有）
 *   ⑦ 测试进展（既有）
 *
 * 数据源：detail 接口的 task.packageDetail（交接包结构化资料全集，服务端激活/回填时落库）；
 * 老库回填前为 null → 回退 digest 字段展示（与本页研发判断板块兼容）。
 * 本地任务复用同一页面骨架（无平台资料板块）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toastError, toastSuccess } from "@prismshadow/penguin-ui";
import { useProject } from "../../../state/project";
import {
  analyzeTask,
  deleteTaskAttachment,
  getTaskDetail,
  listTaskAttachments,
  startTask,
  terminateTask,
  uploadTaskAttachment,
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
/** 变更/自测 sections 的标准 key 中文名（任务平台侧 allowed_keys 对齐）。 */
const SECTION_KEY_LABEL: Record<string, string> = {
  change_reason: "变更原因",
  affected_scope: "影响范围",
  validation_result: "验证结果",
  risk_note: "风险说明",
  version_info: "版本信息",
  test_address: "测试地址",
  affected_modules: "影响模块",
  known_risks: "已知风险",
  extra_notes: "补充说明",
  related_links: "相关链接",
};
/** 包附件类别的中文展示（file_category）。 */
const ATT_CATEGORY_LABEL: Record<string, string> = {
  schedule_design_document: "排期设计文档",
  schedule_material_attachment: "排期材料附件",
  development_judgment: "研发处理判断",
  requirement_clarification: "需求澄清材料",
  self_test_evidence: "自测凭证",
  other: "其他",
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const timeShort = (v: unknown): string => {
  const text = str(v);
  return text ? text.slice(0, 16).replace("T", " ") : "";
};
/** 变更/自测内容里的富文本残留清理（截图实测 <ul><li><span> 片段）：标签剥掉、li 转换行、实体还原。 */
function stripRichText(raw: string): string {
  return raw
    .replace(/<li[^>]*>/gi, "\n· ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 交接包结构化资料（packageDetail 的前端形态；全部可选——老库回填前为 null）。 */
interface PackageDetail {
  package_version?: number;
  event_type?: string;
  generated_at?: string | null;
  ai_content?: string;
  ai_structured_result?: Record<string, unknown> | null;
  final_content?: string;
  original_content?: string;
  original_rich_content?: string;
  supplements?: Array<{ content?: string; operator?: string | null; created_at?: string | null }>;
  confirmed_baseline?: {
    final_content?: string;
    acceptance_criteria?: string[];
    missing_fields?: string[];
    confirmed?: boolean;
    confirmed_at?: string | null;
    confirmed_by?: string | null;
  };
  self_test?: {
    submitted_at?: string | null;
    review_mode?: string | null;
    approval_status?: string;
    reviewed_at?: string | null;
    request_reason?: string | null;
    sections?: Array<Record<string, unknown>>;
    related_links?: string[];
  };
  changes?: Array<{
    node?: string;
    node_code?: string;
    batch?: number;
    sequence?: number;
    content?: string;
    sections?: Array<Record<string, unknown>>;
    changed_at?: string | null;
    operator?: string | null;
  }>;
  attachments?: Array<{
    attachment_id?: string;
    file_name?: string;
    file_category?: string;
    node_code?: string | null;
    file_size?: number;
    content_type?: string | null;
    download_url?: string | null;
  }>;
  schedule_design_documents?: Array<{ document_key?: string; file_name?: string; attachment_id?: string }>;
  handoff_document?: { title?: string; content?: string } | null;
  regression_context?: {
    previous_failed_issues?: Array<{ issue_no?: string; title?: string; problem_description?: string; severity?: string }>;
    rectifications?: Array<{ solution?: string; test_method?: string; changed_content?: string }>;
  } | null;
}

function asPackageDetail(raw: Record<string, unknown> | null | undefined): PackageDetail | null {
  return raw && typeof raw === "object" ? (raw as PackageDetail) : null;
}

export function PlatformTaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId ?? null;
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);

  const reload = useCallback(async () => {
    if (!projectId || !taskId) return;
    try {
      const data = await getTaskDetail(projectId, taskId);
      setDetail(data);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载详情失败");
    }
  }, [projectId, taskId]);

  useEffect(() => {
    setDetail(null);
    setLoadError("");
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!projectId || !taskId) return;
    let alive = true;
    void listTaskAttachments(projectId, taskId).then((r) => { if (alive) setAttachments(r.attachments); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, taskId, detail?.task.localEditedAt]);

  const doAnalyze = async () => {
    if (!projectId || !taskId || !detail) return;
    setAnalyzing(true);
    try {
      const result = await analyzeTask(projectId, taskId);
      toastSuccess(
        result.degraded
          ? `AI 分析未走模型（${result.degraded.reason}），已回填演示结论`
          : "AI 分析完成：结构化结论已回填"
      );
      await reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "AI 分析失败，请重试");
    } finally {
      setAnalyzing(false);
    }
  };

  const doStart = async () => {
    if (!projectId || !taskId || !detail) return;
    setStarting(true);
    try {
      const result = await startTask(projectId, taskId);
      toastSuccess("已创建测试工作会话并进入全流程阶段页");
      navigate(`/chat/${result.sessionId}`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "开始测试失败，请重试");
    } finally {
      setStarting(false);
    }
  };

  const doTerminate = async () => {
    if (!projectId || !taskId) return;
    const reason = window.prompt("终止原因（封存后新版本不自动复活）：");
    if (reason === null) return;
    try {
      await terminateTask(projectId, taskId, reason.trim() || "人工终止");
      toastSuccess("任务已终止，结果封存");
      await reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "终止失败");
    }
  };

  if (!projectId) {
    return (
      <main className="qpm-page">
        <div className="qpm-scroll">
          <div className="qpm-empty-card">
            <p className="qpm-empty-title">还没有进入项目</p>
            <p className="qpm-empty-sub">任务按项目隔离，先在顶部项目切换器中选择项目。</p>
            <button type="button" className="qpm-btn-main" onClick={() => navigate("/qa/projects")}>去项目管理</button>
          </div>
        </div>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="qpm-page">
        <div className="qpm-scroll">
          <div className="qpm-error" role="alert">
            <p>{loadError}</p>
            <button type="button" className="qpm-btn-ghost" onClick={() => void reload()}>重试</button>
            <button type="button" className="qpm-btn-ghost" onClick={() => navigate("/qa/project/platform-tasks")}>返回列表</button>
          </div>
        </div>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="qpm-page qpt-page" aria-label="任务详情">
        <div className="qpm-scroll"><p className="qpt-loading">加载中…</p></div>
      </main>
    );
  }

  const t = detail.task;
  const isLocal = t.source === "local";
  const s = detail.summary;
  const pkg = asPackageDetail(t.packageDetail);
  const canStart = t.status === "ready" || t.status === "in_progress";
  const canAct = t.status !== "result_returned" && t.status !== "terminated";

  // 执行通道分组（B5-2）：类型 × 环境相同的运行归入同一通道。
  const channelGroups: Array<[string, typeof detail.progress.runs]> = [];
  for (const run of detail.progress.runs) {
    const channel = `${RUN_KIND_LABEL[run.kind] ?? run.kind} · ${run.env || "未绑定环境"}`;
    const group = channelGroups.find(([label]) => label === channel);
    if (group) group[1].push(run);
    else channelGroups.push([channel, [run]]);
  }

  return (
    <main className="qpm-page qpt-page" aria-label="任务详情">
      <div className="qpm-scroll">
        {/* ① 头部 */}
        <header className="qpt-dtl-head">
          <div className="qpt-dtl-head-main">
            <button type="button" className="qpt-op" onClick={() => navigate("/qa/project/platform-tasks")}>← 返回列表</button>
            <div className="qpt-dtl-title">
              <h1>{t.title} <span className={`qpt-pill qpt-st-${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span></h1>
              <p className="qpt-dtl-sub">
                <span className="qpt-mono">{t.taskNo}</span>
                · {isLocal ? "本地任务" : `包版本 v${t.packageVersion ?? "—"} · 第 ${t.roundNo ?? "—"} 轮`}
                {pkg?.generated_at ? ` · 资料生成于 ${timeShort(pkg.generated_at)}` : ""}
                {pkg?.event_type ? ` · ${EVENT_LABEL[pkg.event_type] ?? pkg.event_type}` : ""}
              </p>
            </div>
          </div>
          <div className="qpt-ops">
            {canAct && (
              <button type="button" className="qpt-op qpt-op-accent" disabled={analyzing} onClick={() => void doAnalyze()}>
                {analyzing ? "分析中…" : s || t.suggestedPriority ? "重新分析" : "AI 分析"}
              </button>
            )}
            {t.status === "ready" && (
              <button type="button" className="qpt-op qpt-op-main" disabled={starting} onClick={() => void doStart()}>
                {starting ? "启动中…" : "开始测试"}
              </button>
            )}
            {t.status === "in_progress" && (
              <button type="button" className="qpt-op qpt-op-main" disabled={starting} onClick={() => void doStart()}>
                打开会话
              </button>
            )}
            {t.status === "pending_analysis" && (
              <button type="button" className="qpt-op" disabled title="AI 分析未完成，开始测试不可用（TLQ-1）">开始测试</button>
            )}
            {canAct && <button type="button" className="qpt-op" onClick={() => void doTerminate()}>终止</button>}
          </div>
        </header>

        <div className="qpt-dtl-body">
          {isLocal ? (
            <LocalTaskSections detail={detail} />
          ) : (
            <>
              {/* ② 基本信息 */}
              <section className="qpt-dw-sec">
                <h3>基本信息</h3>
                <dl className="qpt-fgrid">
                  <div><dt>产品线</dt><dd>{t.productLines.map((l) => `${l.isPrimary ? "" : "关联 "}${l.name}`).join(" · ") || "—"}</dd></div>
                  <div><dt>反馈类型</dt><dd>{t.feedbackTypeLabel || t.feedbackType || "—"}</dd></div>
                  <div><dt>优先级</dt><dd><span className={`qpt-pri qpt-pri-${t.priority}`}>{PRIORITY_LABEL[t.priority] ?? t.priority}</span></dd></div>
                  <div><dt>复杂度 / 预估</dt><dd>{t.complexityLevel || "—"}{t.estimatedDays != null ? ` · ${t.estimatedDays}天` : ""}{t.estimatedHours != null ? ` · ${t.estimatedHours}h` : ""}</dd></div>
                  <div><dt>提交人 / 处理人</dt><dd>{[t.submitter, t.assignee].filter(Boolean).join(" / ") || "—"}</dd></div>
                  <div><dt>AI 建议优先级</dt><dd>{t.suggestedPriority ? <span className="qpt-ai">{PRIORITY_LABEL[t.suggestedPriority] ?? t.suggestedPriority}</span> : "—"}</dd></div>
                </dl>
                {t.sourceUrl && (
                  <p className="qpt-deeplink">平台任务链接：<a href={t.sourceUrl} target="_blank" rel="noreferrer">{t.sourceUrl} ↗</a></p>
                )}
                {t.localEditedAt && (t.localTitleNote || t.localTestFocusNote) && (
                  <div className="qpt-local-note">
                    <b>本地补充字段（不被平台同步覆盖）</b>
                    {t.localTitleNote && <p>标题备注：{t.localTitleNote}</p>}
                    {t.localTestFocusNote && <p>测试重点备注：{t.localTestFocusNote}</p>}
                  </div>
                )}
              </section>

              {/* ③ 内容整理（字段结构化） */}
              <ContentOrganizedSection pkg={pkg} t={t} />

              {/* ④ 原始反馈 */}
              <OriginalFeedbackSection pkg={pkg} />

              {/* ⑤ 研发判断 */}
              <DevelopmentJudgmentSection
                pkg={pkg}
                baselineDigest={t.requirementBaseline ?? null}
                selfTestDigest={t.selfTestDigest ?? null}
                changesDigest={t.changesDigest ?? []}
              />

              {/* 本地任务附件管理（平台任务也可补充本地材料） */}
              <section className="qpt-dw-sec">
                <h3>本地补充材料 <small className="qpt-att-hint">文本类 · 单件 ≤60KB · 作为 AI 分析补充输入</small></h3>
                <TaskAttachmentsLite projectId={projectId} taskId={t.id} items={attachments} onChanged={async () => {
                  try { setAttachments((await listTaskAttachments(projectId, t.id)).attachments); } catch { /* 保留 */ }
                }} />
              </section>
            </>
          )}

          {/* ⑥ AI 分析结论 */}
          <section className="qpt-dw-sec">
            <h3>AI 分析结论 <span className="qpt-ai-tag">AI 建议</span></h3>
            <AiConclusionBlocks s={s} />
          </section>

          {/* ⑦ 测试进展 */}
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
              <p className="qpt-muted">暂无测试运行记录。{isLocal && "点「开始测试」将创建测试工作会话并打开既有全流程阶段页。"}</p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

const EVENT_LABEL: Record<string, string> = {
  initial_handoff: "首次交接",
  material_changed: "资料变更",
  new_pm_round: "新一轮抽测",
};

/** 本地任务的资料段（需求描述/环境/账号）。 */
function LocalTaskSections({ detail }: { detail: TaskDetail }) {
  const t = detail.task;
  return (
    <section className="qpt-dw-sec">
      <h3>任务信息</h3>
      <div className="qpt-sum-block"><h4>需求描述 / 测试背景</h4><p className="qpt-reason">{t.description || "（未填写）"}</p></div>
      <dl className="qpt-fgrid">
        <div><dt>涉及端</dt><dd>{t.ends.length ? t.ends.map((e) => e).join(" · ") : "—"}</dd></div>
        <div><dt>变更关联</dt><dd className="qpt-mono">{t.changeSource || "（未关联）"}</dd></div>
        <div><dt>测试环境</dt><dd className="qpt-mono">{t.envBaseUrl || "（未填写）"}</dd></div>
        <div><dt>登录账号</dt><dd>{t.account || "（未填写）"}</dd></div>
      </dl>
    </section>
  );
}

/** ③ 内容整理：任务平台侧 AI 结构化 + 确认基准/验收口径（字段级）。 */
function ContentOrganizedSection({ pkg, t }: { pkg: PackageDetail | null; t: TaskDetail["task"] }) {
  const structured = pkg?.ai_structured_result;
  const structuredEntries = structured && typeof structured === "object"
    ? Object.entries(structured as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    : [];
  const baseline = pkg?.confirmed_baseline;
  const hasAi = Boolean(str(pkg?.ai_content)) || structuredEntries.length > 0;
  const hasBaseline = Boolean(baseline?.final_content || (baseline?.acceptance_criteria?.length ?? 0));
  if (!hasAi && !hasBaseline) return null;
  return (
    <section className="qpt-dw-sec">
      <h3>内容整理 <span className="qpt-ai-tag">平台资料</span></h3>
      {structuredEntries.length > 0 && (
        <div className="qpt-sum-block">
          <h4>任务平台结构化整理</h4>
          <dl className="qpt-fgrid">
            {structuredEntries.map(([key, value]) => (
              <div key={key}><dt>{SECTION_KEY_LABEL[key] ?? key}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</dd></div>
            ))}
          </dl>
        </div>
      )}
      {str(pkg?.ai_content) && (
        <div className="qpt-sum-block"><h4>整理正文（任务平台侧 AI）</h4><p className="qpt-reason" style={{ whiteSpace: "pre-wrap" }}>{stripRichText(str(pkg?.ai_content))}</p></div>
      )}
      {baseline?.final_content && (
        <div className="qpt-sum-block">
          <h4>研发处理判断确认基准 {baseline.confirmed ? "" : " · 未确认"}{baseline.confirmed_at ? ` · ${timeShort(baseline.confirmed_at)}` : ""}</h4>
          <p className="qpt-reason" style={{ whiteSpace: "pre-wrap" }}>{baseline.final_content}</p>
        </div>
      )}
      {baseline?.acceptance_criteria && baseline.acceptance_criteria.length > 0 && (
        <div className="qpt-sum-block"><h4>验收口径</h4><ul>{baseline.acceptance_criteria.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
      )}
      {baseline?.missing_fields && baseline.missing_fields.length > 0 && (
        <div className="qpt-sum-block"><h4>待澄清/遗漏字段</h4><ul className="qpt-openq">{baseline.missing_fields.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
      )}
    </section>
  );
}

/** ④ 原始反馈：正文 + 富文本 + 补充意见。 */
function OriginalFeedbackSection({ pkg }: { pkg: PackageDetail | null }) {
  const original = str(pkg?.original_content);
  const rich = str(pkg?.original_rich_content);
  const supplements = pkg?.supplements ?? [];
  if (!original && !rich && supplements.length === 0) return null;
  return (
    <section className="qpt-dw-sec">
      <h3>原始反馈 <span className="qpt-ai-tag">平台资料</span></h3>
      {(original || rich) && (
        <div className="qpt-sum-block">
          <h4>反馈正文</h4>
          <p className="qpt-reason" style={{ whiteSpace: "pre-wrap", color: "inherit", fontSize: 12.5 }}>
            {original || stripRichText(rich)}
          </p>
        </div>
      )}
      {supplements.length > 0 && (
        <div className="qpt-sum-block">
          <h4>补充意见（{supplements.length} 条）</h4>
          {supplements.map((sup, i) => (
            <div key={i} className="qpt-supplement">
              <p className="qpt-supplement-meta">{timeShort(sup.created_at)}{sup.operator ? ` · ${sup.operator}` : ""}</p>
              <p className="qpt-reason" style={{ whiteSpace: "pre-wrap" }}>{stripRichText(str(sup.content))}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** ⑤ 研发判断：自测提交记录（字段级）+ 节点变更记录（含结构化 sections）+ 包附件/文档引用 + 回归上下文。 */
function DevelopmentJudgmentSection({ pkg, baselineDigest, selfTestDigest, changesDigest }: {
  pkg: PackageDetail | null;
  baselineDigest: Record<string, unknown> | null;
  selfTestDigest: Record<string, unknown> | null;
  changesDigest: Array<Record<string, unknown>>;
}) {
  const selfTest = pkg?.self_test;
  const changes = pkg?.changes ?? [];
  const attachments = pkg?.attachments ?? [];
  const designDocs = pkg?.schedule_design_documents ?? [];
  const regression = pkg?.regression_context;
  // 老库回填前 packageDetail 为 null：回退 digest 展示（研发判断内容不丢——需求基准/自测摘要/变更正文）
  const fallbackBaseline = baselineDigest as { final_content?: string; acceptance_criteria?: string[]; confirmed?: boolean } | null;
  const fallbackSelfTest = selfTestDigest as Record<string, unknown> | null;
  const fallbackChanges = changesDigest;
  const hasContent = Boolean(selfTest || changes.length || attachments.length || designDocs.length || regression ||
    (fallbackSelfTest && Object.keys(fallbackSelfTest).length > 0) || fallbackChanges.length > 0 ||
    (fallbackBaseline && str(fallbackBaseline.final_content)));
  if (!hasContent) return null;

  const sectionEntries = (sections: Array<Record<string, unknown>> | undefined) =>
    (sections ?? [])
      .map((sec) => ({
        label: str(sec.label) || SECTION_KEY_LABEL[str(sec.key)] || str(sec.key) || "资料项",
        value: stripRichText(str(sec.value)),
        items: Array.isArray(sec.material_items)
          ? (sec.material_items as Array<Record<string, unknown>>).map((item) => `${str(item.title)}：${str(item.result)}`)
          : [],
      }))
      .filter((sec) => sec.value || sec.items.length > 0);

  return (
    <section className="qpt-dw-sec">
      <h3>研发判断 <span className="qpt-ai-tag">平台资料</span></h3>

      {/* 需求基准（老库回退：packageDetail 缺失时 digest 里仍有确认基准正文） */}
      {!selfTest && fallbackBaseline && str(fallbackBaseline.final_content) && (
        <div className="qpt-sum-block">
          <h4>需求基准（研发处理判断确认版）{fallbackBaseline.confirmed ? "" : " · 未确认"}</h4>
          <p className="qpt-reason" style={{ whiteSpace: "pre-wrap" }}>{str(fallbackBaseline.final_content)}</p>
          {Array.isArray(fallbackBaseline.acceptance_criteria) && fallbackBaseline.acceptance_criteria.length > 0 && (
            <><h4>验收口径</h4><ul>{fallbackBaseline.acceptance_criteria.map((item, i) => <li key={i}>{item}</li>)}</ul></>
          )}
        </div>
      )}

      {/* 正式开发节点：审核通过的自测提交记录（字段级） */}
      {(selfTest || fallbackSelfTest) && (
        <div className="qpt-sum-block">
          <h4>
            正式开发提交记录（研发自测 · 审核通过）
            {selfTest?.submitted_at ? ` · 提交 ${timeShort(selfTest.submitted_at)}` : ""}
            {!selfTest && fallbackSelfTest?.reviewed_at ? ` · 审核通过 ${timeShort(fallbackSelfTest.reviewed_at)}` : ""}
          </h4>
          {selfTest ? (
            <>
              {selfTest.request_reason && <p className="qpt-reason"><b>提交说明：</b>{selfTest.request_reason}</p>}
              {sectionEntries(selfTest.sections).map((sec, i) => (
                <div key={i} className="qpt-section-row">
                  <b>{sec.label}</b>
                  {sec.value && <p className="qpt-reason" style={{ whiteSpace: "pre-wrap" }}>{sec.value}</p>}
                  {sec.items.length > 0 && <ul>{sec.items.map((item, j) => <li key={j}>{item}</li>)}</ul>}
                </div>
              ))}
              {selfTest.related_links && selfTest.related_links.length > 0 && (
                <p className="qpt-mono qpt-reason">{selfTest.related_links.join(" · ")}</p>
              )}
            </>
          ) : (
            fallbackSelfTest && (
              <>
                {str(fallbackSelfTest.self_test_result) && <p className="qpt-reason"><b>自测结果：</b>{str(fallbackSelfTest.self_test_result)}</p>}
                {str(fallbackSelfTest.test_focus) && <p className="qpt-reason"><b>验证重点：</b>{str(fallbackSelfTest.test_focus)}</p>}
                {str(fallbackSelfTest.affected_modules) && <p className="qpt-reason"><b>影响模块：</b>{str(fallbackSelfTest.affected_modules)}</p>}
                {str(fallbackSelfTest.known_risks) && <p className="qpt-reason"><b>已知风险：</b>{str(fallbackSelfTest.known_risks)}</p>}
                {str(fallbackSelfTest.test_address) && <p className="qpt-reason qpt-mono"><b>测试地址：</b>{str(fallbackSelfTest.test_address)}</p>}
              </>
            )
          )}
        </div>
      )}

      {/* 节点变更记录（含结构化 sections） */}
      {(changes.length > 0 || fallbackChanges.length > 0) && (
        <div className="qpt-sum-block">
          <h4>节点变更记录（{changes.length || fallbackChanges.length} 条）</h4>
          {(changes.length > 0 ? changes : fallbackChanges.map((c) => ({
            node: str(c.node) || str(c.node_code),
            batch: typeof c.batch === "number" ? c.batch : undefined,
            content: str(c.content),
            sections: undefined,
            changed_at: c.changed_at as string | null,
            operator: (c.operator as string | null) ?? null,
          }))).map((c, i) => {
            const entries = sectionEntries(c.sections as Array<Record<string, unknown>> | undefined);
            return (
              <div key={i} className="qpt-section-row">
                <b>[{c.node || "变更"}]{typeof c.batch === "number" ? ` 第${c.batch}批` : ""}{c.operator ? ` · ${c.operator}` : ""}{timeShort(c.changed_at) ? ` · ${timeShort(c.changed_at)}` : ""}</b>
                {str(c.content) && <p className="qpt-reason" style={{ whiteSpace: "pre-wrap" }}>{stripRichText(str(c.content))}</p>}
                {entries.map((sec, j) => (
                  <div key={j} className="qpt-change-field">
                    <small>{sec.label}</small>
                    {sec.value && <p className="qpt-reason" style={{ whiteSpace: "pre-wrap" }}>{sec.value}</p>}
                    {sec.items.length > 0 && <ul>{sec.items.map((item, k) => <li key={k}>{item}</li>)}</ul>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* 包附件 + 排期设计文档（三份 md） */}
      {(attachments.length > 0 || designDocs.length > 0) && (
        <div className="qpt-sum-block">
          <h4>研发判断材料（{attachments.length + designDocs.length} 件）</h4>
          <ul className="qpt-att-list">
            {designDocs.map((doc, i) => (
              <li key={`doc-${i}`} className="qpt-att-item">
                <span className="qpt-att-name">📄 {str(doc.file_name) || "排期设计文档"}</span>
                <small>排期设计文档 · 原件在任务平台</small>
              </li>
            ))}
            {attachments.map((att, i) => (
              <li key={`att-${i}`} className="qpt-att-item">
                <span className="qpt-att-name">{str(att.file_name) || "附件"}</span>
                <small>
                  {ATT_CATEGORY_LABEL[str(att.file_category)] ?? (str(att.file_category) || "附件")}
                  {att.node_code ? ` · ${att.node_code}` : ""}
                  {typeof att.file_size === "number" ? ` · ${Math.ceil(att.file_size / 1024)}KB` : ""}
                </small>
                {str(att.download_url) && <a href={str(att.download_url)} target="_blank" rel="noreferrer">下载</a>}
              </li>
            ))}
          </ul>
          <p className="qpt-sum-foot">文本类附件已自动同步进项目资料；截图等二进制原件请到任务平台查看（详情页「平台深链」）。</p>
        </div>
      )}

      {/* 回归上下文（新一轮抽测时） */}
      {regression && (
        <div className="qpt-sum-block">
          <h4>上轮抽测退回问题（回归范围参考）</h4>
          {(regression.previous_failed_issues ?? []).map((issue, i) => (
            <div key={`i-${i}`} className="qpt-section-row">
              <b>[{str(issue.severity) || "问题"}] {str(issue.issue_no)} {str(issue.title)}</b>
              <p className="qpt-reason" style={{ whiteSpace: "pre-wrap" }}>{str(issue.problem_description)}</p>
            </div>
          ))}
          {(regression.rectifications ?? []).map((rect, i) => (
            <div key={`r-${i}`} className="qpt-section-row">
              <b>整改说明</b>
              <p className="qpt-reason" style={{ whiteSpace: "pre-wrap" }}>{str(rect.solution)}{str(rect.changed_content) ? `（${str(rect.changed_content)}）` : ""}{str(rect.test_method) ? ` · 验证方式：${str(rect.test_method)}` : ""}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** AI 分析结论块（与原抽屉一致的展示，独立组件以便复用）。 */
function AiConclusionBlocks({ s }: { s: TaskDetail["summary"] }) {
  if (!s) {
    return <div className="qpt-sum-empty">尚未分析：点顶部「AI 分析」由模型整理任务内容并产出结构化结论。</div>;
  }
  return (
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
        </div>
      )}
      <div className="qpt-sum-block">
        <h4>建议优先级：{PRIORITY_LABEL[s.suggested_priority] ?? s.suggested_priority}</h4>
        <p className="qpt-reason">{s.priority_reason}</p>
      </div>
      {s.risks.length > 0 && <div className="qpt-sum-block"><h4>风险点</h4><ul className="qpt-risk">{s.risks.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
      {s.open_questions.length > 0 && <div className="qpt-sum-block"><h4>待确认问题</h4><ul className="qpt-openq">{s.open_questions.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
      <p className="qpt-sum-foot">
        分析时间 {s.analyzed_at || "—"} · 来源：{s.source === "requirement_analysis" ? "模型分析（任务资料）" : s.source === "demo" ? "演示产出（模型不可用时的回退）" : s.source}
      </p>
    </>
  );
}

/** 详情页轻量附件管理（列表 + 上传 + 删除；逻辑与原抽屉 TaskAttachments 一致）。 */
function TaskAttachmentsLite({ projectId, taskId, items, onChanged }: {
  projectId: string;
  taskId: string;
  items: TaskAttachment[];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      await onChanged();
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
      await onChanged();
      toastSuccess(`附件「${filename}」已删除`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "附件删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {items.length === 0 ? (
        <p className="qpt-muted">暂无本地补充材料。</p>
      ) : (
        <ul className="qpt-att-list">
          {items.map((att) => (
            <li key={att.attachmentId} className="qpt-att-item">
              <span className="qpt-att-name">{att.filename}</span>
              <small>{Math.ceil(att.sizeBytes / 1024)}KB · {timeShort(att.createdAt)}</small>
              <button type="button" disabled={busy} onClick={() => void remove(att.attachmentId, att.filename)}>删除</button>
            </li>
          ))}
        </ul>
      )}
      <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      <button type="button" className="qpt-op" disabled={busy} onClick={() => fileInputRef.current?.click()}>选择文件</button>
    </>
  );
}

export type { TaskListItem };
