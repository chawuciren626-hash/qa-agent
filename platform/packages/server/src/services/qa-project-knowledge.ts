/**
 * Q2 project knowledge: source documents with immutable revisions, evidence candidates,
 * owner-confirmed rules, and append-only task context snapshots.
 *
 * All rows live in the local SQLite database (project business data stays on this machine).
 * Writes are deliberately simple: every mutable record carries an optimistic counter, and a
 * history row is inserted before the current row is advanced, so old task references never
 * drift when a document or rule changes.
 */
import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../http/errors.js";
import { currentSelection, selectionDirectory, type RoundSkillSelection } from "./qa-skill-selection.js";

export const DOCUMENT_FORMATS = ["markdown", "text", "json", "csv", "html"] as const;
export const DOCUMENT_STATUSES = ["active", "archived"] as const;
export const CANDIDATE_STATUSES = ["pending", "accepted", "rejected"] as const;
export const RULE_STATUSES = ["active", "retired"] as const;
export const DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
export const DOCUMENT_MAX_REVISIONS = 500;
export const DOCUMENT_MAX_PER_PROJECT = 2000;
export const CANDIDATE_MAX_PER_PROJECT = 10000;
export const RULE_MAX_PER_PROJECT = 5000;
export const SNAPSHOT_MAX_DOCUMENTS = 500;
export const SNAPSHOT_MAX_RULES = 2000;

export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export type RuleStatus = (typeof RULE_STATUSES)[number];

/** The subset of SQLite the store uses (the runtime exposes the same handle as an HMR capability). */
export interface KnowledgeDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
}

interface DocumentRow {
  document_id: string;
  project_id: string;
  title: string;
  format: DocumentFormat;
  status: DocumentStatus;
  source_json: string;
  revision: number;
  current_revision: number;
  current_revision_id: string;
  content_hash: string;
  byte_size: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface RevisionRow {
  revision_id: string;
  document_id: string;
  project_id: string;
  revision: number;
  title: string;
  content: string;
  encoding: string;
  content_hash: string;
  byte_size: number;
  change_note: string;
  source_json: string;
  author_user_id: string;
  created_at: string;
}

interface CandidateRow {
  candidate_id: string;
  project_id: string;
  title: string;
  statement: string;
  rationale: string;
  scope_json: string;
  source_refs_json: string;
  status: CandidateStatus;
  revision: number;
  created_by_json: string;
  created_at: string;
  updated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string;
  confirmed_rule_id: string | null;
}

interface RuleRow {
  rule_id: string;
  project_id: string;
  status: RuleStatus;
  version: number;
  title: string;
  statement: string;
  scope_json: string;
  source_refs_json: string;
  source_candidate_id: string | null;
  confirmed_by: string;
  created_at: string;
  updated_at: string;
  content_hash: string;
}

interface RuleVersionRow {
  rule_id: string;
  version: number;
  project_id: string;
  status: RuleStatus;
  title: string;
  statement: string;
  scope_json: string;
  source_refs_json: string;
  source_candidate_id: string | null;
  change_note: string;
  actor_user_id: string;
  created_at: string;
  content_hash: string;
}

interface SnapshotRow {
  snapshot_id: string;
  project_id: string;
  session_id: string;
  agent_id: string;
  version: number;
  documents_json: string;
  rules_json: string;
  capabilities_json: string;
  amendment_json: string | null;
  created_at: string;
  created_by: string;
}

export interface DocumentSource {
  type: "manual" | "upload" | "external" | "agent";
  ref?: string;
  filename?: string;
  capturedAt?: string;
}

export interface EvidenceRef {
  type: "document" | "rule" | "execution" | "external";
  [key: string]: unknown;
}

export interface ProjectScope {
  level: "project";
}

export interface KnowledgeDocument {
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

export interface DocumentDetail {
  document: KnowledgeDocument;
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

export interface KnowledgeCandidate {
  candidateId: string;
  projectId: string;
  title: string;
  statement: string;
  rationale: string;
  scope: ProjectScope;
  sourceRefs: EvidenceRef[];
  status: CandidateStatus;
  revision: number;
  createdBy: { type: "user" | "agent"; userId: string; agentId?: string; sessionId?: string };
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  confirmedRuleId?: string;
}

export interface ProjectRule {
  ruleId: string;
  projectId: string;
  status: RuleStatus;
  version: number;
  title: string;
  statement: string;
  scope: ProjectScope;
  sourceRefs: EvidenceRef[];
  sourceCandidateId?: string;
  confirmedBy: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuleVersion {
  ruleId: string;
  version: number;
  status: RuleStatus;
  title: string;
  statement: string;
  scope: ProjectScope;
  sourceRefs: EvidenceRef[];
  sourceCandidateId?: string;
  changeNote: string;
  actorUserId: string;
  createdAt: string;
  contentHash: string;
}

export interface SnapshotDocumentPin {
  documentId: string;
  revision: number;
  revisionId: string;
  title: string;
  contentHash: string;
}

export interface SnapshotRulePin {
  ruleId: string;
  version: number;
  title: string;
  contentHash: string;
}

export interface SnapshotCapabilities {
  personalSelection: { selectionId: string; resources: RoundSkillSelection["resources"] } | null;
  defaultSkills: { roleId: string; skills: string[] }[];
}

export interface TaskContextSnapshot {
  snapshotId: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  version: number;
  documents: SnapshotDocumentPin[];
  rules: SnapshotRulePin[];
  capabilities: SnapshotCapabilities;
  amendment: Record<string, unknown> | null;
  createdAt: string;
  createdBy: string;
}

export interface KnowledgeSearchHit {
  documentId: string;
  title: string;
  revision: number;
  revisionId: string;
  contentHash: string;
  snippet: string;
}

export interface KnowledgeSearchResult {
  matches: KnowledgeSearchHit[];
  /** Index rows dropped because they no longer point at the current revision/hash. */
  staleRemoved: number;
}

export interface SnapshotChange {
  kind: "document" | "rule";
  documentId?: string;
  ruleId?: string;
  fromRevision?: number | null;
  toRevision?: number | null;
  fromVersion?: number | null;
  toVersion?: number | null;
}

const sha256 = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const iso = (ms: number) => new Date(ms).toISOString();
const object = (value: unknown, code = "invalid_document"): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, code, "内容格式无效。");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number, code: string, label: string, min = 1): string => {
  if (typeof value !== "string") throw new HttpError(400, code, `${label} 必须是文本。`);
  if (value.length < min) throw new HttpError(400, code, `${label} 不能为空。`);
  if (value.length > max) throw new HttpError(400, code, `${label} 超过长度限制。`);
  return value;
};
const optionalText = (value: unknown, max: number, code: string, label: string): string | undefined =>
  value === undefined ? undefined : text(value, max, code, label, 0);
const integer = (value: unknown, code: string, label: string, min = 1): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new HttpError(400, code, `${label} 必须是正整数。`);
  return value;
};
const parseJson = <T>(raw: string, fallback: T): T => {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function parseSource(value: unknown, code = "invalid_document"): DocumentSource {
  if (value === undefined) return { type: "manual" };
  const source = object(value, code);
  const allowed = ["type", "ref", "filename", "capturedAt"];
  if (Object.keys(source).some((key) => !allowed.includes(key))) throw new HttpError(400, code, "资料来源含未允许的字段。");
  const type = source.type;
  if (type !== "manual" && type !== "upload" && type !== "external" && type !== "agent") throw new HttpError(400, code, "资料来源类型无效。");
  const out: DocumentSource = { type };
  if (source.ref !== undefined) out.ref = text(source.ref, 500, code, "来源标识", 0);
  if (source.filename !== undefined) out.filename = text(source.filename, 300, code, "文件名", 0);
  if (source.capturedAt !== undefined) {
    const stamp = text(source.capturedAt, 40, code, "来源时间");
    if (Number.isNaN(Date.parse(stamp))) throw new HttpError(400, code, "来源时间格式无效。");
    out.capturedAt = stamp;
  }
  return out;
}

function parseScope(value: unknown, code: string): ProjectScope {
  if (value === undefined) return { level: "project" };
  const scope = object(value, code);
  if (Object.keys(scope).some((key) => key !== "level") || scope.level !== "project") {
    throw new HttpError(400, code, "本阶段知识适用范围只能是项目级。");
  }
  return { level: "project" };
}

export function parseEvidenceRefs(value: unknown, code: string): EvidenceRef[] {
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, code, "来源证据必须是 1 至 20 条。");
  if (!value.length) throw new HttpError(400, code, "至少需要一条来源证据。");
  return value.map((item) => {
    const ref = object(item, code);
    const type = ref.type;
    if (type !== "document" && type !== "rule" && type !== "execution" && type !== "external") throw new HttpError(400, code, "来源证据类型无效。");
    const out: EvidenceRef = { type };
    if (type === "document") {
      out.documentId = text(ref.documentId, 100, code, "资料标识");
      out.revision = integer(ref.revision, code, "资料修订号");
      if (ref.revisionId !== undefined) out.revisionId = text(ref.revisionId, 100, code, "修订标识");
      if (ref.section !== undefined) out.section = text(ref.section, 200, code, "章节", 0);
      if (ref.quote !== undefined) out.quote = text(ref.quote, 2000, code, "引用", 0);
    } else if (type === "rule") {
      out.ruleId = text(ref.ruleId, 100, code, "规则标识");
      out.version = integer(ref.version, code, "规则版本");
    } else if (type === "execution") {
      out.sessionId = text(ref.sessionId, 120, code, "任务标识");
      out.runId = text(ref.runId, 120, code, "运行标识");
      if (ref.evidencePath !== undefined) {
        const evidencePath = text(ref.evidencePath, 1000, code, "证据路径");
        if (evidencePath.includes("\\") || evidencePath.startsWith("/") || evidencePath.split("/").some((part) => !part || part === "." || part === "..")) {
          throw new HttpError(400, code, "证据路径不安全。");
        }
        out.evidencePath = evidencePath;
      }
      if (ref.selector !== undefined) out.selector = text(ref.selector, 500, code, "定位符", 0);
    } else {
      out.system = text(ref.system, 100, code, "外部系统");
      out.externalId = text(ref.externalId, 200, code, "外部标识");
      if (ref.url !== undefined) {
        const raw = text(ref.url, 1000, code, "外部地址");
        let url: URL;
        try { url = new URL(raw); } catch { throw new HttpError(400, code, "外部地址格式无效。"); }
        if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new HttpError(400, code, "外部地址不能包含凭据。");
        out.url = raw;
      }
    }
    return out;
  });
}

export class QaProjectKnowledgeStore {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly db: KnowledgeDb,
    private readonly findSession: (sessionId: string) => { projectId: string; agentId: string } | null = () => null,
    options: { now?: () => number; id?: () => string } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.id = options.id ?? randomUUID;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private count(sql: string, ...params: unknown[]): number {
    const row = this.db.prepare(sql).get(...params) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Snapshots are bound to a Session; callers reaching the store directly still get the check. */
  private requireSession(projectId: string, sessionId: string, agentId?: string): void {
    const found = this.findSession(sessionId);
    if (!found || found.projectId !== projectId || (agentId !== undefined && found.agentId !== agentId)) {
      throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
    }
  }

  private documentRow(projectId: string, documentId: string): DocumentRow {
    const row = this.db.prepare("SELECT * FROM qa_documents WHERE project_id=? AND document_id=?").get(projectId, documentId) as DocumentRow | undefined;
    if (!row) throw new HttpError(404, "document_not_found", "资料不存在或不属于当前项目。");
    return row;
  }

  private revisionRow(documentId: string, revision: number): RevisionRow {
    const row = this.db.prepare("SELECT * FROM qa_document_revisions WHERE document_id=? AND revision=?").get(documentId, revision) as RevisionRow | undefined;
    if (!row) throw new HttpError(404, "revision_not_found", "资料修订不存在。");
    return row;
  }

  private candidateRow(projectId: string, candidateId: string): CandidateRow {
    const row = this.db.prepare("SELECT * FROM qa_knowledge_candidates WHERE project_id=? AND candidate_id=?").get(projectId, candidateId) as CandidateRow | undefined;
    if (!row) throw new HttpError(404, "candidate_not_found", "知识候选不存在或不属于当前项目。");
    return row;
  }

  private ruleRow(projectId: string, ruleId: string): RuleRow {
    const row = this.db.prepare("SELECT * FROM qa_project_rules WHERE project_id=? AND rule_id=?").get(projectId, ruleId) as RuleRow | undefined;
    if (!row) throw new HttpError(404, "rule_not_found", "正式规则不存在或不属于当前项目。");
    return row;
  }

  private mapDocument(row: DocumentRow): KnowledgeDocument {
    return {
      documentId: row.document_id,
      projectId: row.project_id,
      title: row.title,
      format: row.format,
      status: row.status,
      source: parseJson(row.source_json, { type: "manual" }),
      revision: Number(row.revision),
      currentRevision: Number(row.current_revision),
      currentRevisionId: row.current_revision_id,
      contentHash: row.content_hash,
      byteSize: Number(row.byte_size),
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by
    };
  }

  private mapRevision(row: RevisionRow) {
    return {
      revisionId: row.revision_id,
      revision: Number(row.revision),
      contentHash: row.content_hash,
      authorUserId: row.author_user_id,
      changeNote: row.change_note,
      createdAt: row.created_at
    };
  }

  private mapCandidate(row: CandidateRow): KnowledgeCandidate {
    return {
      candidateId: row.candidate_id,
      projectId: row.project_id,
      title: row.title,
      statement: row.statement,
      rationale: row.rationale,
      scope: parseJson(row.scope_json, { level: "project" }),
      sourceRefs: parseJson(row.source_refs_json, []),
      status: row.status,
      revision: Number(row.revision),
      createdBy: parseJson(row.created_by_json, { type: "user", userId: "" }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
      ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
      ...(row.review_note ? { reviewNote: row.review_note } : {}),
      ...(row.confirmed_rule_id ? { confirmedRuleId: row.confirmed_rule_id } : {})
    };
  }

  private mapRule(row: RuleRow): ProjectRule {
    return {
      ruleId: row.rule_id,
      projectId: row.project_id,
      status: row.status,
      version: Number(row.version),
      title: row.title,
      statement: row.statement,
      scope: parseJson(row.scope_json, { level: "project" }),
      sourceRefs: parseJson(row.source_refs_json, []),
      sourceCandidateId: row.source_candidate_id ?? undefined,
      confirmedBy: row.confirmed_by,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapRuleVersion(row: RuleVersionRow): RuleVersion {
    return {
      ruleId: row.rule_id,
      version: Number(row.version),
      status: row.status,
      title: row.title,
      statement: row.statement,
      scope: parseJson(row.scope_json, { level: "project" }),
      sourceRefs: parseJson(row.source_refs_json, []),
      sourceCandidateId: row.source_candidate_id ?? undefined,
      changeNote: row.change_note,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at,
      contentHash: row.content_hash
    };
  }

  private mapSnapshot(row: SnapshotRow): TaskContextSnapshot {
    return {
      snapshotId: row.snapshot_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      version: Number(row.version),
      documents: parseJson(row.documents_json, []),
      rules: parseJson(row.rules_json, []),
      capabilities: parseJson(row.capabilities_json, { personalSelection: null, defaultSkills: [] }),
      amendment: row.amendment_json ? parseJson(row.amendment_json, null) : null,
      createdAt: row.created_at,
      createdBy: row.created_by
    };
  }

  // ---------------------------------------------------------------- documents

  createDocument(input: {
    /** Reserved for trusted local import adapters; never taken from a public request. */
    internalDocumentId?: string;
    projectId: string;
    userId: string;
    title: unknown;
    format?: unknown;
    content: unknown;
    source?: unknown;
    changeNote?: unknown;
  }): DocumentDetail {
    const title = text(input.title, 200, "invalid_document", "标题");
    const format = (input.format ?? "markdown") as DocumentFormat;
    if (!DOCUMENT_FORMATS.includes(format)) throw new HttpError(400, "invalid_document", "资料格式无效。");
    const content = text(input.content, DOCUMENT_MAX_BYTES, "invalid_document", "资料正文", 0);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > DOCUMENT_MAX_BYTES) throw new HttpError(413, "document_too_large", "资料不能超过 2 MiB。");
    const source = parseSource(input.source);
    const changeNote = optionalText(input.changeNote, 1000, "invalid_document", "修订说明") ?? "";
    if (this.count("SELECT count(*) AS n FROM qa_documents WHERE project_id=? AND status='active'", input.projectId) >= DOCUMENT_MAX_PER_PROJECT) {
      throw new HttpError(409, "document_limit", "项目资料数量已达上限。");
    }
    const at = iso(this.now());
    const documentId = input.internalDocumentId ?? `doc-${this.id()}`;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(documentId)) throw new HttpError(400, "invalid_document", "资料标识无效。");
    const revisionId = `rev-${this.id()}`;
    const hash = sha256(content);
    this.tx(() => {
      this.db.prepare(`INSERT INTO qa_documents
        (document_id,project_id,title,format,status,source_json,revision,current_revision,current_revision_id,content_hash,byte_size,created_at,created_by,updated_at,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        documentId, input.projectId, title, format, "active", JSON.stringify(source), 1, 1, revisionId, hash, bytes, at, input.userId, at, input.userId
      );
      this.db.prepare(`INSERT INTO qa_document_revisions
        (revision_id,document_id,project_id,revision,title,content,encoding,content_hash,byte_size,change_note,source_json,author_user_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        revisionId, documentId, input.projectId, 1, title, content, "utf8", hash, bytes, changeNote || "初始创建", JSON.stringify(source), input.userId, at
      );
      this.upsertIndex(input.projectId, documentId, revisionId, 1, hash, title, content, at);
    });
    return this.getDocument(input.projectId, documentId);
  }

  listDocuments(input: {
    projectId: string;
    q?: string;
    status?: string;
    sourceType?: string;
    limit?: number;
    cursor?: string;
  }): { documents: KnowledgeDocument[]; nextCursor: string | null } {
    const status = input.status ?? "active";
    if (![...DOCUMENT_STATUSES, "all"].includes(status)) throw new HttpError(400, "invalid_document", "资料状态筛选无效。");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid_document", "limit 必须在 1 至 100 之间。");
    const where = ["d.project_id=?"];
    const params: unknown[] = [input.projectId];
    if (status !== "all") { where.push("d.status=?"); params.push(status); }
    if (input.sourceType !== undefined) {
      if (!["manual", "upload", "external", "agent"].includes(input.sourceType)) throw new HttpError(400, "invalid_document", "资料来源筛选无效。");
      where.push("d.source_json LIKE ?"); params.push(`%"type":"${input.sourceType}"%`);
    }
    const q = input.q?.trim();
    if (q) {
      if (q.length > 200) throw new HttpError(400, "invalid_document", "检索词不能超过 200 字符。");
      const like = `%${escapeLike(q)}%`;
      where.push("(d.title LIKE ? ESCAPE '\\' OR r.content LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, "invalid_document");
      where.push("(d.updated_at < ? OR (d.updated_at = ? AND d.document_id < ?))");
      params.push(cursor.time, cursor.time, cursor.id);
    }
    const rows = this.db.prepare(`SELECT d.* FROM qa_documents d
      JOIN qa_document_revisions r ON r.revision_id=d.current_revision_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.updated_at DESC, d.document_id DESC LIMIT ?`).all(...params, limit + 1) as DocumentRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      documents: page.map((row) => this.mapDocument(row)),
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]!.updated_at, page[page.length - 1]!.document_id) : null
    };
  }

  private upsertIndex(projectId: string, documentId: string, revisionId: string, revision: number, hash: string, title: string, content: string, at: string): void {
    this.db.prepare(`INSERT INTO qa_document_index
      (document_id,project_id,revision_id,revision,content_hash,title,content,indexed_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(document_id) DO UPDATE SET
        project_id=excluded.project_id,revision_id=excluded.revision_id,revision=excluded.revision,
        content_hash=excluded.content_hash,title=excluded.title,content=excluded.content,indexed_at=excluded.indexed_at`).run(
      documentId, projectId, revisionId, revision, hash, title, content, at
    );
  }

  /**
   * Project-scoped retrieval over the local index. A row is returned only while it still names
   * the document's current revision and both hashes agree with the revision body; anything else
   * is removed before the query, so an update or archive can never resurface old text.
   */
  searchDocuments(input: { projectId: string; q: string; limit?: number }): KnowledgeSearchResult {
    const q = input.q.trim();
    if (!q || q.length > 200) throw new HttpError(400, "invalid_search", "检索词必须是 1 至 200 字符。");
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, "invalid_search", "limit 必须在 1 至 50 之间。");
    const stale = this.db.prepare(`SELECT count(*) AS n FROM qa_document_index i
      WHERE i.project_id=? AND (
        NOT EXISTS (SELECT 1 FROM qa_documents d WHERE d.document_id=i.document_id AND d.project_id=i.project_id AND d.status='active' AND d.current_revision_id=i.revision_id AND d.content_hash=i.content_hash)
        OR NOT EXISTS (SELECT 1 FROM qa_document_revisions r WHERE r.revision_id=i.revision_id AND r.content_hash=i.content_hash)
      )`).get(input.projectId) as { n?: number } | undefined;
    const staleRemoved = Number(stale?.n ?? 0);
    if (staleRemoved > 0) {
      this.db.prepare(`DELETE FROM qa_document_index WHERE project_id=? AND document_id IN (
        SELECT i.document_id FROM qa_document_index i
        WHERE i.project_id=? AND (
          NOT EXISTS (SELECT 1 FROM qa_documents d WHERE d.document_id=i.document_id AND d.project_id=i.project_id AND d.status='active' AND d.current_revision_id=i.revision_id AND d.content_hash=i.content_hash)
          OR NOT EXISTS (SELECT 1 FROM qa_document_revisions r WHERE r.revision_id=i.revision_id AND r.content_hash=i.content_hash)
        )
      )`).run(input.projectId, input.projectId);
    }
    const like = `%${escapeLike(q)}%`;
    const rows = this.db.prepare(`SELECT i.* FROM qa_document_index i
      JOIN qa_documents d ON d.document_id=i.document_id
      JOIN qa_document_revisions r ON r.revision_id=i.revision_id
      WHERE i.project_id=? AND d.project_id=i.project_id AND d.status='active'
        AND d.current_revision_id=i.revision_id AND d.content_hash=i.content_hash AND r.content_hash=i.content_hash
        AND (i.title LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\')
      ORDER BY i.indexed_at DESC, i.document_id DESC LIMIT ?`)
      .all(input.projectId, like, like, limit) as Array<{
        document_id: string; title: string; revision: number; revision_id: string; content_hash: string; content: string;
      }>;
    return {
      staleRemoved,
      matches: rows.map((row) => ({
        documentId: row.document_id,
        title: row.title,
        revision: Number(row.revision),
        revisionId: row.revision_id,
        contentHash: row.content_hash,
        snippet: snippetAround(row.content, q)
      }))
    };
  }

  getDocument(projectId: string, documentId: string): DocumentDetail {
    const row = this.documentRow(projectId, documentId);
    const revision = this.revisionRow(row.document_id, row.current_revision);
    return { document: this.mapDocument(row), content: revision.content, revision: this.mapRevision(revision) };
  }

  updateDocument(input: {
    projectId: string;
    documentId: string;
    userId: string;
    expectedRevision: unknown;
    title?: unknown;
    content?: unknown;
    changeNote?: unknown;
    /** Only trusted import adapters may advance source provenance. */
    internalSource?: DocumentSource;
  }): DocumentDetail {
    const row = this.documentRow(input.projectId, input.documentId);
    if (row.status !== "active") throw new HttpError(409, "document_archived", "资料已归档，不能继续修订。");
    const expected = integer(input.expectedRevision, "invalid_document", "expectedRevision");
    if (Number(row.revision) !== expected) throw new HttpError(409, "document_revision_conflict", "资料已更新，请刷新后再提交。");
    if (input.title === undefined && input.content === undefined) throw new HttpError(400, "invalid_document", "标题和正文至少提供一项。");
    const title = input.title === undefined ? row.title : text(input.title, 200, "invalid_document", "标题");
    const current = this.revisionRow(row.document_id, row.current_revision);
    const content = input.content === undefined ? current.content : text(input.content, DOCUMENT_MAX_BYTES, "invalid_document", "资料正文", 0);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > DOCUMENT_MAX_BYTES) throw new HttpError(413, "document_too_large", "资料不能超过 2 MiB。");
    if (this.count("SELECT count(*) AS n FROM qa_document_revisions WHERE document_id=?", row.document_id) >= DOCUMENT_MAX_REVISIONS) {
      throw new HttpError(409, "document_revision_limit", "资料修订数量已达上限。");
    }
    const nextRevision = Number(row.current_revision) + 1;
    const revisionId = `rev-${this.id()}`;
    const at = iso(this.now());
    const hash = sha256(content);
    const changeNote = optionalText(input.changeNote, 1000, "invalid_document", "修订说明") ?? "";
    const source = input.internalSource ? parseSource(input.internalSource) : parseJson(row.source_json, { type: "manual" });
    this.tx(() => {
      this.db.prepare(`INSERT INTO qa_document_revisions
        (revision_id,document_id,project_id,revision,title,content,encoding,content_hash,byte_size,change_note,source_json,author_user_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        revisionId, row.document_id, row.project_id, nextRevision, title, content, "utf8", hash, bytes, changeNote, JSON.stringify(source), input.userId, at
      );
      this.db.prepare("UPDATE qa_documents SET title=?,revision=?,current_revision=?,current_revision_id=?,content_hash=?,byte_size=?,updated_at=?,updated_by=?,source_json=? WHERE document_id=?")
        .run(title, expected + 1, nextRevision, revisionId, hash, bytes, at, input.userId, JSON.stringify(source), row.document_id);
      this.upsertIndex(row.project_id, row.document_id, revisionId, nextRevision, hash, title, content, at);
    });
    return this.getDocument(input.projectId, input.documentId);
  }

  archiveDocument(input: { projectId: string; documentId: string; userId: string; expectedRevision: unknown }): { documentId: string; status: "archived"; revision: number } {
    const row = this.documentRow(input.projectId, input.documentId);
    const expected = integer(input.expectedRevision, "invalid_document", "expectedRevision");
    if (Number(row.revision) !== expected) throw new HttpError(409, "document_revision_conflict", "资料已更新，请刷新后再归档。");
    if (row.status === "archived") return { documentId: row.document_id, status: "archived", revision: Number(row.revision) };
    const at = iso(this.now());
    this.tx(() => {
      this.db.prepare("UPDATE qa_documents SET status='archived',revision=revision+1,updated_at=?,updated_by=? WHERE document_id=?")
        .run(at, input.userId, row.document_id);
      // Archived documents are never retrieval hits, even if a stale index row survives.
      this.db.prepare("DELETE FROM qa_document_index WHERE document_id=?").run(row.document_id);
    });
    return { documentId: row.document_id, status: "archived", revision: expected + 1 };
  }

  listRevisions(input: { projectId: string; documentId: string; limit?: number; cursor?: string }): { revisions: ReturnType<QaProjectKnowledgeStore["mapRevision"]>[]; nextCursor: string | null } {
    this.documentRow(input.projectId, input.documentId);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid_document", "limit 必须在 1 至 100 之间。");
    const where = ["document_id=?"];
    const params: unknown[] = [input.documentId];
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, "invalid_document");
      const revision = Number.parseInt(cursor.id, 10);
      if (!Number.isSafeInteger(revision)) throw new HttpError(400, "invalid_document", "分页游标无效。");
      where.push("revision < ?"); params.push(revision);
    }
    const rows = this.db.prepare(`SELECT * FROM qa_document_revisions WHERE ${where.join(" AND ")} ORDER BY revision DESC LIMIT ?`)
      .all(...params, limit + 1) as RevisionRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      revisions: page.map((row) => this.mapRevision(row)),
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]!.created_at, String(page[page.length - 1]!.revision)) : null
    };
  }

  getRevision(projectId: string, documentId: string, revision: number): { revision: ReturnType<QaProjectKnowledgeStore["mapRevision"]>; content: string; title: string } {
    this.documentRow(projectId, documentId);
    const row = this.revisionRow(documentId, revision);
    return { revision: this.mapRevision(row), content: row.content, title: row.title };
  }

  // ---------------------------------------------------------------- candidates

  private validateEvidenceRefs(projectId: string, refs: EvidenceRef[], code: string): EvidenceRef[] {
    for (const ref of refs) {
      if (ref.type === "document") {
        const row = this.db.prepare(`SELECT r.revision_id,r.revision FROM qa_document_revisions r
          JOIN qa_documents d ON d.document_id=r.document_id
          WHERE d.project_id=? AND d.document_id=? AND r.revision=?`).get(projectId, ref.documentId, ref.revision) as { revision_id: string } | undefined;
        if (!row) throw new HttpError(400, code, "资料证据不存在或不属于当前项目。");
        if (ref.revisionId !== undefined && ref.revisionId !== row.revision_id) throw new HttpError(400, code, "资料证据修订标识不匹配。");
      } else if (ref.type === "rule") {
        const row = this.db.prepare("SELECT 1 AS ok FROM qa_rule_versions WHERE project_id=? AND rule_id=? AND version=?")
          .get(projectId, ref.ruleId, ref.version) as { ok?: number } | undefined;
        if (!row) throw new HttpError(400, code, "规则证据不存在或不属于当前项目。");
      } else if (ref.type === "execution") {
        const session = this.findSession(String(ref.sessionId));
        if (!session || session.projectId !== projectId) throw new HttpError(400, code, "执行证据任务不存在或不属于当前项目。");
      }
    }
    return refs;
  }

  createCandidate(input: {
    projectId: string;
    userId: string;
    title: unknown;
    statement: unknown;
    rationale?: unknown;
    scope?: unknown;
    sourceRefs: unknown;
    createdBy?: unknown;
  }): KnowledgeCandidate {
    const title = text(input.title, 200, "invalid_candidate", "候选标题");
    const statement = text(input.statement, 10000, "invalid_candidate", "候选内容");
    const rationale = optionalText(input.rationale, 5000, "invalid_candidate", "候选说明") ?? "";
    const scope = parseScope(input.scope, "invalid_candidate");
    const sourceRefs = this.validateEvidenceRefs(input.projectId, parseEvidenceRefs(input.sourceRefs, "invalid_candidate"), "invalid_candidate");
    const created = object(input.createdBy ?? { type: "user" }, "invalid_candidate");
    if (created.type !== "user" && created.type !== "agent") throw new HttpError(400, "invalid_candidate", "候选来源无效。");
    if (Object.keys(created).some((key) => !["type", "agentId", "sessionId"].includes(key))) throw new HttpError(400, "invalid_candidate", "候选来源含未允许的字段。");
    let agentId: string | undefined;
    let sessionId: string | undefined;
    if (created.type === "agent") {
      agentId = text(created.agentId, 100, "invalid_candidate", "智能体标识");
      sessionId = text(created.sessionId, 120, "invalid_candidate", "任务标识");
      const session = this.findSession(sessionId);
      if (!session || session.projectId !== input.projectId || session.agentId !== agentId) {
        throw new HttpError(400, "invalid_candidate", "候选来源任务不属于该项目或智能体。");
      }
    }
    if (this.count("SELECT count(*) AS n FROM qa_knowledge_candidates WHERE project_id=?", input.projectId) >= CANDIDATE_MAX_PER_PROJECT) {
      throw new HttpError(409, "candidate_limit", "项目知识候选数量已达上限。");
    }
    const at = iso(this.now());
    const candidateId = `cand-${this.id()}`;
    const createdBy = { type: created.type, userId: input.userId, ...(agentId ? { agentId } : {}), ...(sessionId ? { sessionId } : {}) };
    this.db.prepare(`INSERT INTO qa_knowledge_candidates
      (candidate_id,project_id,title,statement,rationale,scope_json,source_refs_json,status,revision,created_by_json,created_at,updated_at,review_note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      candidateId, input.projectId, title, statement, rationale, JSON.stringify(scope), JSON.stringify(sourceRefs), "pending", 1, JSON.stringify(createdBy), at, at, ""
    );
    return this.mapCandidate(this.candidateRow(input.projectId, candidateId));
  }

  listCandidates(input: { projectId: string; status?: string; limit?: number; cursor?: string }): { candidates: KnowledgeCandidate[]; nextCursor: string | null } {
    const status = input.status ?? "pending";
    if (![...CANDIDATE_STATUSES, "all"].includes(status)) throw new HttpError(400, "invalid_candidate", "候选状态筛选无效。");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid_candidate", "limit 必须在 1 至 100 之间。");
    const where = ["project_id=?"];
    const params: unknown[] = [input.projectId];
    if (status !== "all") { where.push("status=?"); params.push(status); }
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, "invalid_candidate");
      where.push("(created_at < ? OR (created_at = ? AND candidate_id < ?))");
      params.push(cursor.time, cursor.time, cursor.id);
    }
    const rows = this.db.prepare(`SELECT * FROM qa_knowledge_candidates WHERE ${where.join(" AND ")} ORDER BY created_at DESC, candidate_id DESC LIMIT ?`)
      .all(...params, limit + 1) as CandidateRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      candidates: page.map((row) => this.mapCandidate(row)),
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]!.created_at, page[page.length - 1]!.candidate_id) : null
    };
  }

  getCandidate(projectId: string, candidateId: string): KnowledgeCandidate {
    return this.mapCandidate(this.candidateRow(projectId, candidateId));
  }

  updateCandidate(input: { projectId: string; candidateId: string; expectedRevision: unknown; title?: unknown; statement?: unknown; rationale?: unknown; scope?: unknown }): KnowledgeCandidate {
    const row = this.candidateRow(input.projectId, input.candidateId);
    if (row.status !== "pending") throw new HttpError(409, "candidate_not_pending", "候选已处理，不能再修改。");
    const expected = integer(input.expectedRevision, "invalid_candidate", "expectedRevision");
    if (Number(row.revision) !== expected) throw new HttpError(409, "candidate_revision_conflict", "候选已更新，请刷新后再提交。");
    if (input.title === undefined && input.statement === undefined && input.rationale === undefined && input.scope === undefined) {
      throw new HttpError(400, "invalid_candidate", "至少提供一个要修改的字段。");
    }
    const title = input.title === undefined ? row.title : text(input.title, 200, "invalid_candidate", "候选标题");
    const statement = input.statement === undefined ? row.statement : text(input.statement, 10000, "invalid_candidate", "候选内容");
    const rationale = input.rationale === undefined ? row.rationale : (optionalText(input.rationale, 5000, "invalid_candidate", "候选说明") ?? "");
    const scope = input.scope === undefined ? parseJson<ProjectScope>(row.scope_json, { level: "project" }) : parseScope(input.scope, "invalid_candidate");
    this.db.prepare("UPDATE qa_knowledge_candidates SET title=?,statement=?,rationale=?,scope_json=?,revision=revision+1,updated_at=? WHERE candidate_id=?")
      .run(title, statement, rationale, JSON.stringify(scope), iso(this.now()), row.candidate_id);
    return this.mapCandidate(this.candidateRow(input.projectId, input.candidateId));
  }

  rejectCandidate(input: { projectId: string; candidateId: string; userId: string; expectedRevision: unknown; reason?: unknown }): KnowledgeCandidate {
    const row = this.candidateRow(input.projectId, input.candidateId);
    if (row.status !== "pending") throw new HttpError(409, "candidate_not_pending", "候选已处理，不能再拒绝。");
    const expected = integer(input.expectedRevision, "invalid_candidate", "expectedRevision");
    if (Number(row.revision) !== expected) throw new HttpError(409, "candidate_revision_conflict", "候选已更新，请刷新后再提交。");
    const reason = optionalText(input.reason, 5000, "invalid_candidate", "拒绝原因") ?? "";
    const at = iso(this.now());
    this.db.prepare("UPDATE qa_knowledge_candidates SET status='rejected',revision=revision+1,updated_at=?,reviewed_by=?,reviewed_at=?,review_note=? WHERE candidate_id=?")
      .run(at, input.userId, at, reason, row.candidate_id);
    return this.mapCandidate(this.candidateRow(input.projectId, input.candidateId));
  }

  confirmCandidate(input: {
    projectId: string;
    candidateId: string;
    userId: string;
    expectedRevision: unknown;
    title?: unknown;
    statement?: unknown;
    scope?: unknown;
  }): { idempotent: boolean; candidate: KnowledgeCandidate; rule: ProjectRule } {
    const row = this.candidateRow(input.projectId, input.candidateId);
    if (row.status === "accepted" && row.confirmed_rule_id) {
      return { idempotent: true, candidate: this.mapCandidate(row), rule: this.getRule(input.projectId, row.confirmed_rule_id) };
    }
    if (row.status !== "pending") throw new HttpError(409, "candidate_not_pending", "候选已处理，不能确认。");
    const expected = integer(input.expectedRevision, "invalid_candidate", "expectedRevision");
    if (Number(row.revision) !== expected) throw new HttpError(409, "candidate_revision_conflict", "候选已更新，请刷新后再确认。");
    if (this.count("SELECT count(*) AS n FROM qa_project_rules WHERE project_id=?", input.projectId) >= RULE_MAX_PER_PROJECT) {
      throw new HttpError(409, "rule_limit", "项目正式规则数量已达上限。");
    }
    const title = input.title === undefined ? row.title : text(input.title, 200, "invalid_rule", "规则标题");
    const statement = input.statement === undefined ? row.statement : text(input.statement, 10000, "invalid_rule", "规则内容");
    const scope = input.scope === undefined ? parseJson<ProjectScope>(row.scope_json, { level: "project" }) : parseScope(input.scope, "invalid_rule");
    const sourceRefs = parseJson<EvidenceRef[]>(row.source_refs_json, []);
    const ruleId = `rule-${this.id()}`;
    const at = iso(this.now());
    const hash = sha256(`${title}\n${statement}`);
    this.tx(() => {
      this.insertRule(ruleId, input.projectId, "active", 1, title, statement, scope, sourceRefs, row.candidate_id, input.userId, at, hash);
      this.insertRuleVersion(ruleId, 1, input.projectId, "active", title, statement, scope, sourceRefs, row.candidate_id, "由知识候选确认", input.userId, at, hash);
      this.db.prepare("UPDATE qa_knowledge_candidates SET status='accepted',revision=revision+1,updated_at=?,reviewed_by=?,reviewed_at=?,review_note='',confirmed_rule_id=? WHERE candidate_id=?")
        .run(at, input.userId, at, ruleId, row.candidate_id);
    });
    return { idempotent: false, candidate: this.mapCandidate(this.candidateRow(input.projectId, input.candidateId)), rule: this.getRule(input.projectId, ruleId) };
  }

  // ---------------------------------------------------------------- rules

  private insertRule(ruleId: string, projectId: string, status: RuleStatus, version: number, title: string, statement: string, scope: ProjectScope, sourceRefs: EvidenceRef[], candidateId: string | null, userId: string, at: string, hash: string) {
    this.db.prepare(`INSERT INTO qa_project_rules
      (rule_id,project_id,status,version,title,statement,scope_json,source_refs_json,source_candidate_id,confirmed_by,created_at,updated_at,content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ruleId, projectId, status, version, title, statement, JSON.stringify(scope), JSON.stringify(sourceRefs), candidateId, userId, at, at, hash
    );
  }

  private insertRuleVersion(ruleId: string, version: number, projectId: string, status: RuleStatus, title: string, statement: string, scope: ProjectScope, sourceRefs: EvidenceRef[], candidateId: string | null, changeNote: string, userId: string, at: string, hash: string) {
    this.db.prepare(`INSERT INTO qa_rule_versions
      (rule_id,version,project_id,status,title,statement,scope_json,source_refs_json,source_candidate_id,change_note,actor_user_id,created_at,content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ruleId, version, projectId, status, title, statement, JSON.stringify(scope), JSON.stringify(sourceRefs), candidateId, changeNote, userId, at, hash
    );
  }

  createRule(input: {
    projectId: string;
    userId: string;
    title: unknown;
    statement: unknown;
    scope?: unknown;
    sourceRefs?: unknown;
    changeNote?: unknown;
  }): ProjectRule {
    const title = text(input.title, 200, "invalid_rule", "规则标题");
    const statement = text(input.statement, 10000, "invalid_rule", "规则内容");
    const scope = parseScope(input.scope, "invalid_rule");
    const sourceRefs = input.sourceRefs === undefined || (Array.isArray(input.sourceRefs) && input.sourceRefs.length === 0)
      ? []
      : this.validateEvidenceRefs(input.projectId, parseEvidenceRefs(input.sourceRefs, "invalid_rule"), "invalid_rule");
    const changeNote = optionalText(input.changeNote, 1000, "invalid_rule", "变更说明") ?? "";
    if (this.count("SELECT count(*) AS n FROM qa_project_rules WHERE project_id=?", input.projectId) >= RULE_MAX_PER_PROJECT) {
      throw new HttpError(409, "rule_limit", "项目正式规则数量已达上限。");
    }
    const ruleId = `rule-${this.id()}`;
    const at = iso(this.now());
    const hash = sha256(`${title}\n${statement}`);
    this.tx(() => {
      this.insertRule(ruleId, input.projectId, "active", 1, title, statement, scope, sourceRefs, null, input.userId, at, hash);
      this.insertRuleVersion(ruleId, 1, input.projectId, "active", title, statement, scope, sourceRefs, null, changeNote || "创建", input.userId, at, hash);
    });
    return this.getRule(input.projectId, ruleId);
  }

  listRules(input: { projectId: string; status?: string; limit?: number; cursor?: string }): { rules: ProjectRule[]; nextCursor: string | null } {
    const status = input.status ?? "active";
    if (![...RULE_STATUSES, "all"].includes(status)) throw new HttpError(400, "invalid_rule", "规则状态筛选无效。");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid_rule", "limit 必须在 1 至 100 之间。");
    const where = ["project_id=?"];
    const params: unknown[] = [input.projectId];
    if (status !== "all") { where.push("status=?"); params.push(status); }
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, "invalid_rule");
      where.push("(updated_at < ? OR (updated_at = ? AND rule_id < ?))");
      params.push(cursor.time, cursor.time, cursor.id);
    }
    const rows = this.db.prepare(`SELECT * FROM qa_project_rules WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, rule_id DESC LIMIT ?`)
      .all(...params, limit + 1) as RuleRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      rules: page.map((row) => this.mapRule(row)),
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]!.updated_at, page[page.length - 1]!.rule_id) : null
    };
  }

  getRule(projectId: string, ruleId: string): ProjectRule {
    return this.mapRule(this.ruleRow(projectId, ruleId));
  }

  getRuleDetail(projectId: string, ruleId: string): ProjectRule & { versions: RuleVersion[] } {
    const rule = this.getRule(projectId, ruleId);
    const rows = this.db.prepare("SELECT * FROM qa_rule_versions WHERE project_id=? AND rule_id=? ORDER BY version DESC")
      .all(projectId, ruleId) as RuleVersionRow[];
    return { ...rule, versions: rows.map((row) => this.mapRuleVersion(row)) };
  }

  listRuleVersions(projectId: string, ruleId: string): RuleVersion[] {
    this.ruleRow(projectId, ruleId);
    const rows = this.db.prepare("SELECT * FROM qa_rule_versions WHERE project_id=? AND rule_id=? ORDER BY version DESC")
      .all(projectId, ruleId) as RuleVersionRow[];
    return rows.map((row) => this.mapRuleVersion(row));
  }

  reviseRule(input: { projectId: string; ruleId: string; userId: string; expectedVersion: unknown; title?: unknown; statement: unknown; scope?: unknown; sourceRefs?: unknown; changeNote?: unknown }): ProjectRule {
    const row = this.ruleRow(input.projectId, input.ruleId);
    if (row.status !== "active") throw new HttpError(409, "rule_retired", "规则已停用，不能继续修订。");
    const expected = integer(input.expectedVersion, "invalid_rule", "expectedVersion");
    if (Number(row.version) !== expected) throw new HttpError(409, "rule_version_conflict", "规则已更新，请刷新后再提交。");
    const title = input.title === undefined ? row.title : text(input.title, 200, "invalid_rule", "规则标题");
    const statement = text(input.statement, 10000, "invalid_rule", "规则内容");
    const scope = input.scope === undefined ? parseJson<ProjectScope>(row.scope_json, { level: "project" }) : parseScope(input.scope, "invalid_rule");
    const sourceRefs = input.sourceRefs === undefined
      ? parseJson<EvidenceRef[]>(row.source_refs_json, [])
      : this.validateEvidenceRefs(input.projectId, parseEvidenceRefs(input.sourceRefs, "invalid_rule"), "invalid_rule");
    const changeNote = optionalText(input.changeNote, 1000, "invalid_rule", "变更说明") ?? "";
    const next = Number(row.version) + 1;
    const at = iso(this.now());
    const hash = sha256(`${title}\n${statement}`);
    this.tx(() => {
      this.insertRuleVersion(row.rule_id, next, input.projectId, "active", title, statement, scope, sourceRefs, row.source_candidate_id, changeNote, input.userId, at, hash);
      this.db.prepare("UPDATE qa_project_rules SET title=?,statement=?,scope_json=?,source_refs_json=?,version=?,status='active',updated_at=?,content_hash=? WHERE rule_id=?")
        .run(title, statement, JSON.stringify(scope), JSON.stringify(sourceRefs), next, at, hash, row.rule_id);
    });
    return this.getRule(input.projectId, input.ruleId);
  }

  retireRule(input: { projectId: string; ruleId: string; userId: string; expectedVersion: unknown; reason?: unknown }): ProjectRule {
    const row = this.ruleRow(input.projectId, input.ruleId);
    if (row.status !== "active") throw new HttpError(409, "rule_retired", "规则已停用。");
    const expected = integer(input.expectedVersion, "invalid_rule", "expectedVersion");
    if (Number(row.version) !== expected) throw new HttpError(409, "rule_version_conflict", "规则已更新，请刷新后再提交。");
    const reason = optionalText(input.reason, 1000, "invalid_rule", "停用原因") ?? "停用";
    const next = Number(row.version) + 1;
    const at = iso(this.now());
    const scope = parseJson<ProjectScope>(row.scope_json, { level: "project" });
    const sourceRefs = parseJson<EvidenceRef[]>(row.source_refs_json, []);
    this.tx(() => {
      this.insertRuleVersion(row.rule_id, next, input.projectId, "retired", row.title, row.statement, scope, sourceRefs, row.source_candidate_id, reason, input.userId, at, row.content_hash);
      this.db.prepare("UPDATE qa_project_rules SET status='retired',version=?,updated_at=? WHERE rule_id=?")
        .run(next, at, row.rule_id);
    });
    return this.getRule(input.projectId, input.ruleId);
  }

  // ---------------------------------------------------------------- task snapshots

  private pinDocuments(projectId: string): SnapshotDocumentPin[] {
    const rows = this.db.prepare("SELECT * FROM qa_documents WHERE project_id=? AND status='active' ORDER BY updated_at DESC, document_id DESC")
      .all(projectId) as DocumentRow[];
    if (rows.length > SNAPSHOT_MAX_DOCUMENTS) throw new HttpError(409, "task_context_too_large", "任务快照引用的资料数量超限。");
    return rows.map((row) => ({
      documentId: row.document_id,
      revision: Number(row.current_revision),
      revisionId: row.current_revision_id,
      title: row.title,
      contentHash: row.content_hash
    }));
  }

  private pinRules(projectId: string): SnapshotRulePin[] {
    const rows = this.db.prepare("SELECT * FROM qa_project_rules WHERE project_id=? AND status='active' ORDER BY updated_at DESC, rule_id DESC")
      .all(projectId) as RuleRow[];
    if (rows.length > SNAPSHOT_MAX_RULES) throw new HttpError(409, "task_context_too_large", "任务快照引用的规则数量超限。");
    return rows.map((row) => ({ ruleId: row.rule_id, version: Number(row.version), title: row.title, contentHash: row.content_hash }));
  }

  private async personalSelectionFor(input: { root?: string; userId?: string; projectId: string; sessionId: string; agentId: string }): Promise<SnapshotCapabilities["personalSelection"]> {
    if (!input.root || !input.userId) return null;
    const userHash = createHash("sha256").update(input.userId).digest("hex");
    const selection = await currentSelection({ dir: selectionDirectory(input.root, userHash, input.projectId), sessionId: input.sessionId, agentId: input.agentId });
    return selection ? { selectionId: selection.id, resources: selection.resources } : null;
  }

  async ensureTaskContextSnapshot(input: {
    projectId: string;
    sessionId: string;
    agentId: string;
    createdBy: string;
    root?: string;
    userId?: string;
    defaultSkills?: { roleId: string; skills: string[] }[];
  }): Promise<{ created: boolean; snapshot: TaskContextSnapshot }> {
    this.requireSession(input.projectId, input.sessionId, input.agentId);
    const existing = this.getTaskContextSnapshot(input.projectId, input.sessionId);
    if (existing) return { created: false, snapshot: existing };
    const documents = this.pinDocuments(input.projectId);
    const rules = this.pinRules(input.projectId);
    const personalSelection = await this.personalSelectionFor({ ...input });
    const capabilities: SnapshotCapabilities = { personalSelection, defaultSkills: input.defaultSkills ?? [] };
    const at = iso(this.now());
    const snapshotId = `ctx-${this.id()}`;
    try {
      this.db.prepare(`INSERT INTO qa_task_context_snapshots
        (snapshot_id,project_id,session_id,agent_id,version,documents_json,rules_json,capabilities_json,amendment_json,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        snapshotId, input.projectId, input.sessionId, input.agentId, 1, JSON.stringify(documents), JSON.stringify(rules), JSON.stringify(capabilities), null, at, input.createdBy
      );
    } catch {
      // A concurrent first dispatch won the unique (session_id, version) slot; its snapshot is authoritative.
      const winner = this.getTaskContextSnapshot(input.projectId, input.sessionId);
      if (winner) return { created: false, snapshot: winner };
      throw new HttpError(409, "task_context_conflict", "任务快照创建冲突，请重试。");
    }
    return { created: true, snapshot: this.getTaskContextSnapshot(input.projectId, input.sessionId)! };
  }

  private lastSnapshotRow(projectId: string, sessionId: string): SnapshotRow | null {
    const row = this.db.prepare("SELECT * FROM qa_task_context_snapshots WHERE project_id=? AND session_id=? ORDER BY version DESC LIMIT 1")
      .get(projectId, sessionId) as SnapshotRow | undefined;
    return row ?? null;
  }

  getTaskContextSnapshot(projectId: string, sessionId: string): TaskContextSnapshot | null {
    const row = this.lastSnapshotRow(projectId, sessionId);
    return row ? this.mapSnapshot(row) : null;
  }

  listTaskContextSnapshots(projectId: string, sessionId: string): TaskContextSnapshot[] {
    const rows = this.db.prepare("SELECT * FROM qa_task_context_snapshots WHERE project_id=? AND session_id=? ORDER BY version DESC")
      .all(projectId, sessionId) as SnapshotRow[];
    return rows.map((row) => this.mapSnapshot(row));
  }

  refreshTaskContextSnapshot(input: {
    projectId: string;
    sessionId: string;
    userId: string;
    expectedVersion: unknown;
    instruction: unknown;
    documentIds?: unknown;
    ruleIds?: unknown;
    all?: unknown;
  }): { snapshot: TaskContextSnapshot; amendment: Record<string, unknown> } {
    this.requireSession(input.projectId, input.sessionId);
    const row = this.lastSnapshotRow(input.projectId, input.sessionId);
    if (!row) throw new HttpError(404, "task_context_not_found", "任务尚未创建上下文快照。");
    const current = this.mapSnapshot(row);
    const expected = integer(input.expectedVersion, "invalid_context_refresh", "expectedVersion");
    if (current.version !== expected) throw new HttpError(409, "task_context_conflict", "任务上下文已变化，请刷新后重试。");
    const instruction = text(input.instruction, 1000, "invalid_context_refresh", "读取最新资料指令", 3);
    const all = input.all === true;
    if (input.all !== undefined && typeof input.all !== "boolean") throw new HttpError(400, "invalid_context_refresh", "all 必须是布尔值。");
    const documentIds = stringIds(input.documentIds, "invalid_context_refresh", "documentIds");
    const ruleIds = stringIds(input.ruleIds, "invalid_context_refresh", "ruleIds");
    if (!all && !documentIds.length && !ruleIds.length) throw new HttpError(400, "invalid_context_refresh", "请指定资料或规则，或使用 all=true。");

    const documents = new Map(current.documents.map((pin) => [pin.documentId, pin]));
    const rules = new Map(current.rules.map((pin) => [pin.ruleId, pin]));
    const changes = new Map<string, SnapshotChange>();
    const changeKey = (kind: string, id: string) => `${kind}:${id}`;
    const beforeDocuments = new Set(documents.keys());
    const beforeRules = new Set(rules.keys());

    if (all) {
      documents.clear();
      for (const pin of this.pinDocuments(input.projectId)) documents.set(pin.documentId, pin);
      rules.clear();
      for (const pin of this.pinRules(input.projectId)) rules.set(pin.ruleId, pin);
      for (const id of beforeDocuments) if (!documents.has(id)) {
        const from = current.documents.find((pin) => pin.documentId === id)!;
        changes.set(changeKey("document", id), { kind: "document", documentId: id, fromRevision: from.revision, toRevision: null });
      }
      for (const id of beforeRules) if (!rules.has(id)) {
        const from = current.rules.find((pin) => pin.ruleId === id)!;
        changes.set(changeKey("rule", id), { kind: "rule", ruleId: id, fromVersion: from.version, toVersion: null });
      }
    } else {
      for (const documentId of documentIds) {
        const document = this.documentRow(input.projectId, documentId);
        if (document.status !== "active") throw new HttpError(409, "document_archived", "资料已归档，不能读取为新依据。");
        documents.set(documentId, {
          documentId,
          revision: Number(document.current_revision),
          revisionId: document.current_revision_id,
          title: document.title,
          contentHash: document.content_hash
        });
      }
      for (const ruleId of ruleIds) {
        const rule = this.ruleRow(input.projectId, ruleId);
        if (rule.status !== "active") throw new HttpError(409, "rule_retired", "规则已停用，不能读取为新依据。");
        rules.set(ruleId, { ruleId, version: Number(rule.version), title: rule.title, contentHash: rule.content_hash });
      }
    }

    for (const pin of documents.values()) {
      const old = current.documents.find((item) => item.documentId === pin.documentId);
      if (!old || old.revision !== pin.revision || old.contentHash !== pin.contentHash) {
        changes.set(changeKey("document", pin.documentId), { kind: "document", documentId: pin.documentId, fromRevision: old?.revision ?? null, toRevision: pin.revision });
      }
    }
    for (const pin of rules.values()) {
      const old = current.rules.find((item) => item.ruleId === pin.ruleId);
      if (!old || old.version !== pin.version || old.contentHash !== pin.contentHash) {
        changes.set(changeKey("rule", pin.ruleId), { kind: "rule", ruleId: pin.ruleId, fromVersion: old?.version ?? null, toVersion: pin.version });
      }
    }

    const at = iso(this.now());
    const nextVersion = current.version + 1;
    const amendment = {
      instruction,
      requestedByUserId: input.userId,
      requestedAt: at,
      documentIds,
      ruleIds,
      changes: [...changes.values()],
      reanalysisRequired: changes.size > 0
    };
    this.db.prepare(`INSERT INTO qa_task_context_snapshots
      (snapshot_id,project_id,session_id,agent_id,version,documents_json,rules_json,capabilities_json,amendment_json,created_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      `ctx-${this.id()}`, input.projectId, input.sessionId, row.agent_id, nextVersion,
      JSON.stringify([...documents.values()]), JSON.stringify([...rules.values()]), row.capabilities_json,
      JSON.stringify(amendment), at, input.userId
    );
    return { snapshot: this.getTaskContextSnapshot(input.projectId, input.sessionId)!, amendment };
  }
}

function snippetAround(content: string, query: string): string {
  const at = content.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return content.replace(/\s+/g, " ").trim().slice(0, 240);
  const start = Math.max(0, at - 80);
  const end = Math.min(content.length, at + query.length + 160);
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < content.length ? "…" : ""}`;
}

function stringIds(value: unknown, code: string, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, code, `${label} 必须是字符串数组。`);
  return value.map((item, index) => text(item, 100, code, `${label}[${index}]`));
}

interface Cursor { time: string; id: string }
function encodeCursor(time: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: time, i: id }), "utf8").toString("base64url");
}
function decodeCursor(raw: string, code: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.i !== "string" || !parsed.t || !parsed.i) throw new Error("bad cursor");
    return { time: parsed.t, id: parsed.i };
  } catch {
    throw new HttpError(400, code, "分页游标无效。");
  }
}
