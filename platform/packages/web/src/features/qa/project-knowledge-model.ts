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
    default:
      return undefined;
  }
}
