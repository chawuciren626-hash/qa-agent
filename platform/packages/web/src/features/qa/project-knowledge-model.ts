/**
 * The Q2 knowledge page's data vocabulary (pure): the DTO fields the page reads, the labels a
 * person decides by, and the server codes whose refusal must be explained rather than guessed.
 *
 * Status and source wording follows the service's own vocabulary: a candidate is never a rule
 * until the project owner confirms it, and a confirmed rule records who confirmed it and when.
 */

export type DocumentFormat = "markdown" | "text" | "json" | "csv" | "html";
export type DocumentStatus = "active" | "archived";
export type CandidateStatus = "pending" | "accepted" | "rejected";
export type RuleStatus = "active" | "retired";

export interface DocumentSource {
  type: "manual" | "upload" | "external" | "agent";
  ref?: string;
  filename?: string;
  capturedAt?: string;
}

export interface DocumentView {
  documentId: string;
  projectId: string;
  title: string;
  format: DocumentFormat;
  status: DocumentStatus;
  source: DocumentSource;
  revision: number;
  currentRevision: number;
  currentRevisionId: string;
  contentHash: string;
  byteSize: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface DocumentDetailView {
  document: DocumentView;
  content: string;
  revision: {
    revisionId: string;
    revision: number;
    contentHash: string;
    authorUserId: string;
    changeNote: string;
    createdAt: string;
  };
}

export interface RevisionView {
  revisionId: string;
  revision: number;
  contentHash: string;
  authorUserId: string;
  changeNote: string;
  createdAt: string;
}

export type EvidenceRef =
  | { type: "document"; documentId: string; revision?: number; revisionId?: string; section?: string; quote?: string }
  | { type: "rule"; ruleId: string; version?: number }
  | { type: "execution"; sessionId: string; runId?: string; evidencePath?: string; selector?: string }
  | { type: "external"; system: string; externalId?: string; url?: string };

export interface CandidateView {
  candidateId: string;
  projectId: string;
  title: string;
  statement: string;
  rationale: string;
  scope: { level: "project" };
  sourceRefs: EvidenceRef[];
  status: CandidateStatus;
  revision: number;
  createdBy: {
    type: "user" | "agent";
    userId: string;
    agentId?: string;
    sessionId?: string;
  };
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  confirmedRuleId?: string;
}

export interface RuleView {
  ruleId: string;
  projectId: string;
  status: RuleStatus;
  version: number;
  title: string;
  statement: string;
  scope: { level: "project" };
  sourceRefs: EvidenceRef[];
  sourceCandidateId?: string;
  confirmedBy: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuleVersionView {
  ruleId: string;
  version: number;
  status: RuleStatus;
  title: string;
  statement: string;
  changeNote: string;
  actorUserId: string;
  createdAt: string;
  contentHash: string;
  sourceCandidateId?: string;
}

/* ------------------------------------------------------------------ A6 知识条款与版本 */

/**
 * 一个知识项：从资料条款里认出来的结论，**带原文位置**。
 *
 * `source.file` 存的是 documentId 而不是标题（标题会改，id 不会）；`line` 是资料正文里的
 * 行号。没有位置的知识项不会走到前端——服务端在入库前就丢弃并计数了。
 */
export interface KnowledgeItemView {
  id: string;
  type: string;
  name: string;
  statement: string;
  source: { file: string; line: number };
  section?: string | null;
  tags: string[];
  fingerprint: string;
}

/** 条款：切分后的原文片段，`location.line` 是片段首行在资料中的行号。 */
export interface ClauseView {
  clause_id: string;
  section_path: string;
  text: string;
  location: { file: string; line: number };
}

export interface KnowledgeBuildView {
  buildId: string;
  version: number;
  contentHash: string;
  items: KnowledgeItemView[];
  clauses: ClauseView[];
  stats: { items: number; by_type: Record<string, number>; dropped: number; duplicates: number };
  sources: { documentId: string; revision: number; title: string; file: string }[];
  meta: {
    actor: string;
    semanticHash: string;
    dropped: { reason: string; raw?: unknown }[];
    duplicates: Record<string, unknown>[];
  };
  createdAt: string;
  createdBy: string;
}

/** 列表页拿到的版本摘要：不含条款与知识项正文，避免一次拉几百 KB。 */
export type KnowledgeBuildSummary = Omit<KnowledgeBuildView, "items" | "clauses" | "meta">;

/**
 * 四分类对账。`wordingOnly` 刻意**不**触发重算：同一个判定条件只换了措辞，
 * 重算所有下游用例只是把成本翻倍，不会改变任何结论。
 */
export interface KnowledgeDiffView {
  stats: Record<string, number>;
  triggersRecompute: boolean;
  semanticChanged: unknown[];
  wordingOnly: unknown[];
  renamed: unknown[];
  added: unknown[];
  removed: unknown[];
}

/** 一次对话装配的账目：装了什么、裁了什么，以及每一条裁剪的具体原因。 */
export interface ContextLedgerView {
  version: number;
  ledgerId: string;
  budgetTokens: number;
  tokensEst: number;
  loaded: { knowledge: { loaded: number; total: number; version: number | null }; documents: number; rules: number };
  dropped: { kind: string; ref: unknown; tokens: number; reason: string }[];
  assembler: string;
  statement: string;
}

export interface KnowledgeReferencesView {
  version: number;
  hits: { knowledgeId: string; type: string; name: string; priority: number; source: { file: string; line: number } }[];
}

export const KNOWLEDGE_TYPE_LABELS: Readonly<Record<string, string>> = {
  entity: "业务实体",
  rule: "业务规则",
  constraint: "约束",
  term: "术语",
  role: "角色权限",
  flow: "业务流程",
};

export function knowledgeTypeLabel(type: string): string {
  return KNOWLEDGE_TYPE_LABELS[type] ?? type;
}

/** 装配器不可用时的退化账目必须一眼能认出来，不能和正常装载混在一起。 */
export function assemblerLabel(assembler: string | undefined): string {
  if (!assembler) return "未知装配器";
  return assembler.startsWith("fallback") ? `降级：${assembler.slice("fallback:".length)}` : assembler;
}

/** 裁剪原因 → 人话。未收录的原因原样显示，不做猜测性翻译。 */
export function dropReasonLabel(reason: string): string {
  const key = reason.split(":")[0]!.trim();
  switch (key) {
    case "over_budget":
      return "超出 token 预算";
    case "duplicate_fingerprint":
      return "与已装项语义重复";
    case "out_of_scope":
      return "不在本次任务的范围内";
    case "assembler_unavailable":
      return `装配器不可用：${reason.slice(reason.indexOf(":") + 1).trim() || "原因未知"}`;
    case "low_priority":
      return "优先级低于预算线";
    default:
      return reason;
  }
}

/**
 * 找到行号所在的条款，并把该行在条款内的相对序号算出来（用于高亮）。
 *
 * 条款是按行切分的连续片段，所以「包含第 N 行」的条款一定唯一；找不到说明知识项的
 * 位置与条款切分对不上——这时返回 null，页面显示"原文位置待核"而不是拿相近条款顶替。
 */
export function clauseAt(
  clauses: ClauseView[],
  file: string,
  line: number,
): { clause: ClauseView; relativeLine: number; lines: string[] } | null {
  for (const clause of clauses) {
    if (clause.location.file !== file) continue;
    const lines = clause.text.split("\n");
    if (line >= clause.location.line && line < clause.location.line + lines.length) {
      return { clause, relativeLine: line - clause.location.line, lines };
    }
  }
  return null;
}

/** 版本摘要的一行：这一版收录了多少条、来自几份资料、丢了多少条。 */
export function buildSummaryLine(build: Pick<KnowledgeBuildView, "stats" | "sources">): string {
  // 早于统计字段的历史版本仍然读得到：缺字段按 0 显示，不要显示 "undefined 条"。
  const items = build.stats?.items ?? 0;
  const dropped = build.stats?.dropped ?? 0;
  const duplicates = build.stats?.duplicates ?? 0;
  const parts = [`${items} 条知识`, `${build.sources?.length ?? 0} 份资料`];
  if (dropped > 0) parts.push(`丢弃 ${dropped} 条（无原文位置）`);
  if (duplicates > 0) parts.push(`合并重复 ${duplicates} 条`);
  return parts.join(" · ");
}

/** 对账结论：只有语义变更才需要重算。 */
export function diffVerdictLine(diff: KnowledgeDiffView): string {
  const group = (key: keyof KnowledgeDiffView): number =>
    Array.isArray(diff[key]) ? (diff[key] as unknown[]).length : 0;
  const counts = [
    `语义变更 ${group("semanticChanged")}`,
    `仅措辞 ${group("wordingOnly")}`,
    `重命名 ${group("renamed")}`,
    `新增 ${group("added")}`,
    `移除 ${group("removed")}`,
  ];
  const tail = diff.triggersRecompute
    ? "需要重算受影响的用例"
    : "只有措辞变化，不触发重算";
  return `${counts.join(" · ")} · ${tail}`;
}

export type KnowledgeDiffKind = "semanticChanged" | "wordingOnly" | "renamed" | "added" | "removed";

export interface DiffEntryView {
  id: string;
  before?: string;
  after?: string;
  note?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * 把 diff 的原始条目统一成「一个标识 + 变更前后 + 一句附注」。
 *
 * 四类的字段名本来就不一样（`id/old_statement/new_statement`、`old_id/new_id`…），
 * 在页面里各写一遍 switch 迟早会漏掉一类，把人引到空列表上。
 */
export function diffEntries(diff: KnowledgeDiffView, kind: KnowledgeDiffKind): DiffEntryView[] {
  const rows = diff[kind];
  if (!Array.isArray(rows)) return [];
  return rows.map((raw: unknown): DiffEntryView => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    switch (kind) {
      case "semanticChanged":
        return {
          id: text(entry.id) ?? "（无 id）",
          before: text(entry.old_statement),
          after: text(entry.new_statement),
          note: typeof entry.change_ratio === "number" ? `相似度 ${(entry.change_ratio * 100).toFixed(0)}%` : undefined,
        };
      case "wordingOnly":
        return {
          id: text(entry.id) ?? "（无 id）",
          before: text(entry.old_statement),
          after: text(entry.new_statement),
          note: "指纹未变，不触发重算",
        };
      case "renamed":
        return {
          id: `${text(entry.old_id) ?? "?"} → ${text(entry.new_id) ?? "?"}`,
          note: text(entry.note) ?? "内容基本一致，视为改名",
        };
      case "added":
        return { id: text(entry.id) ?? "（无 id）", after: text(entry.statement), note: text(entry.name) };
      case "removed":
        return { id: text(entry.id) ?? "（无 id）", before: text(entry.statement), note: text(entry.name) };
      default:
        return { id: "（未知条目）" };
    }
  });
}

/**
 * 被裁条目怎么称呼。
 *
 * 账目里的 `ref` 是服务端原样存下来的引用（可能是资料、规则、知识项）。这里只挑人认得
 * 的字段显示；认不出来就如实给出原始结构的一小段，而不是省略成"1 项"——否则事后复盘
 * 时根本不知道被裁的是哪一条。
 */
export function ledgerRefLabel(ref: unknown): string {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object") {
    const entry = ref as Record<string, unknown>;
    for (const key of ["title", "name", "statement", "id", "documentId", "ruleId", "knowledgeId"]) {
      const value = entry[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    try {
      const json = JSON.stringify(ref);
      return json.length > 120 ? `${json.slice(0, 120)}…` : json;
    } catch {
      return "（无法展示的引用）";
    }
  }
  return ref === null || ref === undefined ? "（未记录）" : String(ref);
}

export const DOCUMENT_STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  active: "生效",
  archived: "已归档",
};

export const CANDIDATE_STATUS_LABELS: Readonly<Record<CandidateStatus, string>> = {
  pending: "待确认",
  accepted: "已确认",
  rejected: "已拒绝",
};

export const RULE_STATUS_LABELS: Readonly<Record<RuleStatus, string>> = {
  active: "生效",
  retired: "已停用",
};

export const DOCUMENT_FORMAT_LABELS: Readonly<Record<DocumentFormat, string>> = {
  markdown: "Markdown",
  text: "文本",
  json: "JSON",
  csv: "CSV",
  html: "HTML",
};

export function documentStatusLabel(status: DocumentStatus): string {
  return DOCUMENT_STATUS_LABELS[status] ?? status;
}

export function candidateStatusLabel(status: CandidateStatus): string {
  return CANDIDATE_STATUS_LABELS[status] ?? status;
}

export function ruleStatusLabel(status: RuleStatus): string {
  return RULE_STATUS_LABELS[status] ?? status;
}

export function documentFormatLabel(format: DocumentFormat): string {
  return DOCUMENT_FORMAT_LABELS[format] ?? format;
}

/** How a document entered the project: hand-written, an uploaded file, an external system, or an Agent. */
export function documentSourceLabel(source: DocumentSource | undefined): string {
  if (!source) return "来源未知";
  switch (source.type) {
    case "manual":
      return "手工录入";
    case "upload":
      return source.filename ? `导入文件 ${source.filename}` : "导入文件";
    case "external":
      return source.ref ? `外部来源 ${source.ref}` : "外部来源";
    case "agent":
      return source.ref ? `Agent 写入 ${source.ref}` : "Agent 写入";
    default:
      return source.type;
  }
}

/** Who proposed a candidate: a person, or an Agent run named by its task. */
export function candidateOriginLabel(createdBy: CandidateView["createdBy"]): string {
  if (createdBy.type === "agent") {
    const parts = [createdBy.agentId, createdBy.sessionId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return parts.length > 0 ? `Agent（${parts.join(" · ")}）` : "Agent";
  }
  return `用户 ${createdBy.userId}`;
}

/** One line per evidence reference: enough to find the source, without inventing a quote. */
export function evidenceLine(ref: EvidenceRef): string {
  switch (ref.type) {
    case "document": {
      const revision = ref.revision === undefined ? "" : ` 修订 ${ref.revision}`;
      const section = ref.section ? ` · ${ref.section}` : "";
      return `资料 ${ref.documentId}${revision}${section}`;
    }
    case "rule":
      return `规则 ${ref.ruleId}${ref.version === undefined ? "" : ` v${ref.version}`}`;
    case "execution": {
      const run = ref.runId ? `/${ref.runId}` : "";
      const path = ref.evidencePath ? ` · ${ref.evidencePath}` : "";
      return `执行 ${ref.sessionId}${run}${path}`;
    }
    case "external":
      return ref.externalId
        ? `外部 ${ref.system} · ${ref.externalId}`
        : `外部 ${ref.system}${ref.url ? ` · ${ref.url}` : ""}`;
    default:
      return "未知来源";
  }
}

/** A stored hash cut to the part a person can compare by eye. */
export function shortHash(hash: string | undefined): string {
  if (!hash) return "未知";
  const bare = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return bare.slice(0, 8) || "未知";
}

/** A timestamp in the reader's own clock, or the raw value when it cannot be parsed. */
export function timeLabel(iso: string | undefined): string {
  if (!iso) return "—";
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  return time.toLocaleString();
}

/**
 * Whether this user may write to the project. QA admins can read every project but are not its
 * owner (`role` is owner while `ownerUserId` is someone else), and the Q2 routes refuse writes
 * to exactly that state — so the page must not offer buttons it knows will 403.
 */
export function canEditKnowledge(
  project: { role: string; ownerUserId: string } | null | undefined,
  userId: string | null | undefined,
): boolean {
  return project !== null && project !== undefined && userId != null && project.ownerUserId === userId;
}

/**
 * Q2's refusal and conflict codes in the person's language. Unlisted codes fall back to the
 * server message (`apiErrorText`), so nothing is hidden — this only adds the reasons whose
 * plain-language form matters for deciding what to do next.
 */
export function knowledgeErrorHint(code: string | undefined): string | undefined {
  switch (code) {
    case "project_owner_required":
      return "仅项目所有者可以编辑资料、确认知识候选或维护正式规则；其他成员只能查看。";
    case "project_forbidden":
      return "没有该项目的访问权限。";
    case "project_not_found":
      return "项目不存在，或你没有访问权限。";
    case "document_not_found":
      return "资料不存在，或不属于当前项目。";
    case "revision_not_found":
      return "该资料修订不存在。";
    case "document_revision_conflict":
      return "资料已被更新，请刷新后再提交；你的修改没有被覆盖。";
    case "document_archived":
      return "资料已归档，不能继续修订。";
    case "document_too_large":
      return "资料不能超过 2 MiB。";
    case "unsupported_document_format":
      return "本阶段只支持 UTF-8 的 Markdown、文本、JSON、CSV、HTML 文件。";
    case "document_limit":
      return "项目资料数量已达上限。";
    case "document_revision_limit":
      return "该资料的修订数量已达上限。";
    case "candidate_not_found":
      return "知识候选不存在，或不属于当前项目。";
    case "candidate_not_pending":
      return "候选已处理，不能再次确认或拒绝。";
    case "candidate_revision_conflict":
      return "候选已被更新，请刷新后再处理。";
    case "candidate_limit":
      return "项目知识候选数量已达上限。";
    case "invalid_candidate":
      return "候选内容无效：请填写标题、陈述和至少一条来源证据。";
    case "rule_not_found":
      return "正式规则不存在，或不属于当前项目。";
    case "rule_version_conflict":
      return "规则已被更新，请刷新后再提交。";
    case "rule_retired":
      return "规则已停用，不能继续修订。";
    case "rule_limit":
      return "项目正式规则数量已达上限。";
    case "invalid_rule":
      return "规则内容无效：请填写标题和陈述。";
    case "knowledge_build_not_found":
      return "该知识版本不存在，可能已被清理；请刷新版本列表。";
    case "knowledge_diff_same_version":
      return "同一版本之间没有差异，请选择两个不同版本对比。";
    case "knowledge_source_missing":
      return "所选资料已归档或被删除，请刷新后重新选择。";
    case "knowledge_too_large":
      return "资料份数超过单次构建上限（200 份），请分批构建。";
    case "knowledge_engine_unavailable":
      return "条款化引擎未就绪，本次没有构建任何版本；请先确认执行引擎已配置。";
    case "knowledge_empty":
      return "当前资料切不出任何条款，无法构建知识版本。";
    case "invalid_knowledge_items":
      return "知识项格式无效：每条都要有类型、陈述和原文位置。";
    case "invalid_reference_query":
      return "反查文本不能为空。";
    default:
      return undefined;
  }
}
