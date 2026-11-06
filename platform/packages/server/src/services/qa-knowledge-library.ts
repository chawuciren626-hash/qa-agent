/**
 * Upload preview/confirm and the service-copy ledger for project knowledge.
 *
 * An upload is an explicit two-step action: a preview records the file's hash, size,
 * recipient, purpose and data scope; confirmation must present the same hash, so a file that
 * changed in between is refused instead of silently uploaded. A duplicate confirmation with the
 * same idempotency key returns the first result. The service copy has its own status: a delete
 * that has not reached the receiver stays `delete_queued`/`delete_failed` and is retryable —
 * it is never reported as deleted.
 *
 * Document bodies are data. Nothing in this module interprets them as instructions, and the
 * prompt renderer in `qa-knowledge-untrusted.ts` marks them untrusted.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../http/errors.js";
import { QaProjectKnowledgeStore, type DocumentDetail, type DocumentFormat, type KnowledgeDb } from "./qa-project-knowledge.js";
import type { KnowledgeReceiver } from "./qa-knowledge-receiver.js";

export const UPLOAD_RECIPIENTS = ["local_project", "remote_knowledge_service"] as const;
export const UPLOAD_DATA_SCOPES = ["project_only"] as const;
export const UPLOAD_PREVIEW_TTL_MS = 30 * 60 * 1000;
export const SENSITIVE_NOTICE =
  "敏感内容提示按常见关键词做启发式检查，不能保证识别所有敏感内容；上传前请自行核对文件。";

export const FORMAT_BY_EXTENSION: Record<string, DocumentFormat> = {
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  yaml: "text",
  yml: "text",
  json: "json",
  csv: "csv",
  html: "html",
  htm: "html"
};
const EXTENSION_BY_FORMAT: Record<DocumentFormat, string> = {
  markdown: "md", text: "txt", json: "json", csv: "csv", html: "html"
};

export type UploadRecipient = (typeof UPLOAD_RECIPIENTS)[number];
export type UploadDataScope = (typeof UPLOAD_DATA_SCOPES)[number];
export type PreviewStatus = "previewed" | "confirmed" | "expired" | "cancelled";
export type ServerCopyStatus =
  | "not_required"
  | "queued"
  | "uploading"
  | "uploaded"
  | "failed"
  | "delete_queued"
  | "deleting"
  | "deleted"
  | "delete_failed";

export interface UploadPreview {
  schemaVersion: 1;
  previewId: string;
  projectId: string;
  filename: string;
  format: DocumentFormat;
  title: string;
  byteSize: number;
  contentHash: string;
  recipient: UploadRecipient;
  purpose: string;
  dataScope: UploadDataScope;
  sensitiveHints: string[];
  sensitiveNotice: string;
  status: PreviewStatus;
  createdAt: string;
  expiresAt: string;
}

export interface UploadRecord extends UploadPreview {
  createdBy: string;
  documentId: string | null;
  uploadId: string | null;
  confirmedAt: string | null;
  serverCopy: ServerCopy | null;
}

export interface ServerCopy {
  copyId: string;
  projectId: string;
  documentId: string;
  uploadId: string;
  revision: number;
  contentHash: string;
  byteSize: number;
  recipient: UploadRecipient;
  purpose: string;
  dataScope: UploadDataScope;
  attributionUserId: string;
  status: ServerCopyStatus;
  attempts: number;
  lastError: string;
  remoteRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TargetReceipt {
  target: "index" | "source" | "server_copy";
  status: "deleted" | "archived" | "not_found" | "not_stored" | "queued" | "failed";
  retryable: boolean;
  detail: string;
}

interface PreviewRow {
  preview_id: string;
  project_id: string;
  created_by: string;
  filename: string;
  format: DocumentFormat;
  title: string;
  byte_size: number;
  content_hash: string;
  content: string;
  recipient: UploadRecipient;
  purpose: string;
  data_scope: UploadDataScope;
  sensitive_hints_json: string;
  status: PreviewStatus;
  document_id: string | null;
  upload_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
}

interface CopyRow {
  copy_id: string;
  project_id: string;
  document_id: string;
  upload_id: string;
  revision: number;
  content_hash: string;
  byte_size: number;
  recipient: UploadRecipient;
  purpose: string;
  data_scope: UploadDataScope;
  attribution_user_id: string;
  status: ServerCopyStatus;
  attempts: number;
  last_error: string;
  remote_ref: string | null;
  created_at: string;
  updated_at: string;
}

const text = (value: unknown, max: number, code: string, label: string, min = 1): string => {
  if (typeof value !== "string") throw new HttpError(400, code, `${label} 必须是文本。`);
  if (value.length < min) throw new HttpError(400, code, `${label} 不能为空。`);
  if (value.length > max) throw new HttpError(400, code, `${label} 超过长度限制。`);
  return value;
};
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function sensitiveHintsFor(content: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ["密码或口令", /password|passwd|密码|口令/i],
    ["令牌或密钥", /secret|token|api[ _-]?key|access[ _-]?key|密钥|令牌/i],
    ["身份证件号", /身份证|护照|证件号|\b\d{17}[\dXx]\b/],
    ["联系方式", /手机号|邮箱|@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/]
  ];
  return rules.filter(([, pattern]) => pattern.test(content)).map(([label]) => label);
}

export class QaKnowledgeLibrary {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly db: KnowledgeDb,
    private readonly store: QaProjectKnowledgeStore,
    private readonly root: string,
    private readonly receiver?: KnowledgeReceiver,
    options: { now?: () => number; id?: () => string } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.id = options.id ?? randomUUID;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private count(sql: string, ...params: unknown[]): number {
    const row = this.db.prepare(sql).get(...params) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  private previewRow(projectId: string, previewId: string): PreviewRow {
    const row = this.db.prepare("SELECT * FROM qa_upload_previews WHERE project_id=? AND preview_id=?")
      .get(projectId, previewId) as PreviewRow | undefined;
    if (!row) throw new HttpError(404, "upload_not_found", "上传预览不存在或不属于当前项目。");
    return row;
  }

  private copyRow(projectId: string, copyId: string): CopyRow {
    const row = this.db.prepare("SELECT * FROM qa_server_copies WHERE project_id=? AND copy_id=?")
      .get(projectId, copyId) as CopyRow | undefined;
    if (!row) throw new HttpError(404, "server_copy_not_found", "服务端副本记录不存在或不属于当前项目。");
    return row;
  }

  private mapPreview(row: PreviewRow): UploadPreview {
    return {
      schemaVersion: 1,
      previewId: row.preview_id,
      projectId: row.project_id,
      filename: row.filename,
      format: row.format,
      title: row.title,
      byteSize: Number(row.byte_size),
      contentHash: row.content_hash,
      recipient: row.recipient,
      purpose: row.purpose,
      dataScope: row.data_scope,
      sensitiveHints: JSON.parse(row.sensitive_hints_json) as string[],
      sensitiveNotice: SENSITIVE_NOTICE,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  private mapCopy(row: CopyRow): ServerCopy {
    return {
      copyId: row.copy_id,
      projectId: row.project_id,
      documentId: row.document_id,
      uploadId: row.upload_id,
      revision: Number(row.revision),
      contentHash: row.content_hash,
      byteSize: Number(row.byte_size),
      recipient: row.recipient,
      purpose: row.purpose,
      dataScope: row.data_scope,
      attributionUserId: row.attribution_user_id,
      status: row.status,
      attempts: Number(row.attempts),
      lastError: row.last_error,
      remoteRef: row.remote_ref,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapRecord(row: PreviewRow): UploadRecord {
    const copy = row.upload_id
      ? this.db.prepare("SELECT * FROM qa_server_copies WHERE project_id=? AND upload_id=?").get(row.project_id, row.upload_id) as CopyRow | undefined
      : undefined;
    return {
      ...this.mapPreview(row),
      createdBy: row.created_by,
      documentId: row.document_id,
      uploadId: row.upload_id,
      confirmedAt: row.confirmed_at,
      serverCopy: copy ? this.mapCopy(copy) : null
    };
  }

  private purgeExpired(projectId: string): void {
    const at = this.iso();
    this.db.prepare("DELETE FROM qa_upload_previews WHERE project_id=? AND status='previewed' AND expires_at < ?")
      .run(projectId, at);
  }

  previewUpload(input: {
    projectId: string;
    userId: string;
    filename: unknown;
    dataBase64: unknown;
    title?: unknown;
    recipient?: unknown;
    purpose?: unknown;
    dataScope?: unknown;
  }): UploadPreview {
    const filename = text(input.filename, 300, "invalid_upload", "文件名").trim();
    const base = filename.split(/[\\/]/).pop() ?? "";
    if (!base) throw new HttpError(400, "invalid_upload", "文件名无效。");
    const dot = base.lastIndexOf(".");
    const extension = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
    const format = FORMAT_BY_EXTENSION[extension];
    if (!format) throw new HttpError(400, "unsupported_document_format", "本阶段只支持 Markdown、文本、JSON、CSV、HTML 文件。");
    if (typeof input.dataBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64) || input.dataBase64.length % 4 !== 0) {
      throw new HttpError(400, "invalid_upload", "上传内容必须是有效的 base64 文本文件。");
    }
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.length > 2 * 1024 * 1024) throw new HttpError(413, "document_too_large", "资料不能超过 2 MiB。");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new HttpError(400, "unsupported_document_format", "文件不是有效的 UTF-8 文本。");
    }
    const recipient = (input.recipient ?? "local_project") as UploadRecipient;
    if (!UPLOAD_RECIPIENTS.includes(recipient)) throw new HttpError(400, "invalid_upload", "上传接收方无效。");
    const purpose = text(input.purpose ?? "项目资料库", 200, "invalid_upload", "上传用途").trim();
    const dataScope = (input.dataScope ?? "project_only") as UploadDataScope;
    if (!UPLOAD_DATA_SCOPES.includes(dataScope)) throw new HttpError(400, "invalid_upload", "数据范围无效。");
    const title = input.title === undefined
      ? (dot >= 0 ? base.slice(0, dot) : base)
      : text(input.title, 200, "invalid_upload", "标题");
    this.purgeExpired(input.projectId);
    if (this.count("SELECT count(*) AS n FROM qa_upload_previews WHERE project_id=? AND status='previewed'", input.projectId) >= 50) {
      throw new HttpError(409, "upload_preview_limit", "待确认的上传预览过多，请先确认或等待过期。");
    }
    const at = this.iso();
    const previewId = `upv-${this.id()}`;
    this.db.prepare(`INSERT INTO qa_upload_previews
      (preview_id,project_id,created_by,filename,format,title,byte_size,content_hash,content,recipient,purpose,data_scope,sensitive_hints_json,status,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      previewId, input.projectId, input.userId, base, format, title, bytes.length, sha256(content), content,
      recipient, purpose, dataScope, JSON.stringify(sensitiveHintsFor(content)), "previewed", at,
      new Date(this.now() + UPLOAD_PREVIEW_TTL_MS).toISOString()
    );
    return this.mapPreview(this.previewRow(input.projectId, previewId));
  }

  async confirmUpload(input: {
    projectId: string;
    userId: string;
    previewId: string;
    contentHash: unknown;
    confirmed: unknown;
    idempotencyKey?: unknown;
  }): Promise<{ idempotent: boolean; upload: UploadRecord; document: DocumentDetail }> {
    if (input.confirmed !== true) throw new HttpError(400, "upload_confirmation_required", "上传必须由用户显式确认。");
    const contentHash = text(input.contentHash, 80, "invalid_upload", "内容哈希");
    const key = input.idempotencyKey === undefined
      ? null
      : text(input.idempotencyKey, 128, "invalid_upload", "幂等键");
    if (key !== null && !/^[A-Za-z0-9_-]+$/.test(key)) throw new HttpError(400, "invalid_upload", "幂等键格式无效。");

    const row = this.previewRow(input.projectId, input.previewId);
    if (row.status === "confirmed") {
      if (row.content_hash !== contentHash) throw new HttpError(409, "preview_content_changed", "文件内容已变化，请重新预览并确认。");
      if (key !== null && row.idempotency_key && row.idempotency_key !== key) {
        throw new HttpError(409, "idempotency_conflict", "该预览已用另一个幂等键确认。");
      }
      return {
        idempotent: true,
        upload: this.mapRecord(row),
        document: this.store.getDocument(input.projectId, row.document_id!)
      };
    }
    if (row.status !== "previewed") throw new HttpError(409, "preview_unavailable", "该上传预览已不可用，请重新预览。");
    if (Date.parse(row.expires_at) < this.now()) {
      this.db.prepare("UPDATE qa_upload_previews SET status='expired',content='' WHERE preview_id=?").run(row.preview_id);
      throw new HttpError(409, "preview_expired", "上传预览已过期，请重新预览并确认。");
    }
    if (row.content_hash !== contentHash) throw new HttpError(409, "preview_content_changed", "文件内容已变化，请重新预览并确认。");

    if (key !== null) {
      const previous = this.db.prepare(`SELECT * FROM qa_upload_previews
        WHERE project_id=? AND created_by=? AND idempotency_key=? AND status='confirmed'`)
        .get(input.projectId, input.userId, key) as PreviewRow | undefined;
      if (previous) {
        if (previous.content_hash !== row.content_hash || previous.filename !== row.filename) {
          throw new HttpError(409, "idempotency_conflict", "幂等键已被另一份内容使用。");
        }
        this.db.prepare("UPDATE qa_upload_previews SET status='cancelled',content='' WHERE preview_id=?").run(row.preview_id);
        return {
          idempotent: true,
          upload: this.mapRecord(previous),
          document: this.store.getDocument(input.projectId, previous.document_id!)
        };
      }
    }

    const document = this.store.createDocument({
      projectId: input.projectId,
      userId: input.userId,
      title: row.title,
      format: row.format,
      content: row.content,
      source: { type: "upload", filename: row.filename, capturedAt: this.iso() },
      changeNote: "通过上传预览确认导入"
    });
    const uploadId = `upl-${this.id()}`;
    const at = this.iso();
    const copyId = `copy-${this.id()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE qa_upload_previews
        SET status='confirmed',document_id=?,upload_id=?,idempotency_key=?,confirmed_at=?,content=''
        WHERE preview_id=?`).run(document.document.documentId, uploadId, key, at, row.preview_id);
      this.db.prepare(`INSERT INTO qa_server_copies
        (copy_id,project_id,document_id,upload_id,revision,content_hash,byte_size,recipient,purpose,data_scope,attribution_user_id,status,attempts,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        copyId, input.projectId, document.document.documentId, uploadId, document.document.currentRevision,
        document.document.contentHash, document.document.byteSize, row.recipient, row.purpose, row.data_scope,
        input.userId, row.recipient === "remote_knowledge_service" ? "queued" : "not_required", 0, "", at, at
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    await this.mirrorSource(input.projectId, document);
    if (row.recipient === "remote_knowledge_service") await this.uploadCopy(copyId);
    return { idempotent: false, upload: this.mapRecord(this.previewRow(input.projectId, row.preview_id)), document };
  }

  private async mirrorSource(projectId: string, document: DocumentDetail): Promise<void> {
    const dir = path.join(this.root, "qa-knowledge-sources", projectId, document.document.documentId);
    if (!path.resolve(dir).startsWith(path.resolve(this.root, "qa-knowledge-sources") + path.sep)) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `revision-${document.document.currentRevision}.${EXTENSION_BY_FORMAT[document.document.format]}`),
        document.content,
        "utf8"
      );
    } catch {
      // The database copy is authoritative; a failed mirror is reported as `not_stored` on delete.
    }
  }

  private async uploadCopy(copyId: string): Promise<ServerCopy> {
    const row = this.copyRowByAnyProject(copyId);
    const at = this.iso();
    this.db.prepare("UPDATE qa_server_copies SET status='uploading',attempts=attempts+1,updated_at=? WHERE copy_id=?").run(at, copyId);
    try {
      if (!this.receiver) throw new Error("尚未配置知识接收方");
      const revision = this.store.getRevision(row.project_id, row.document_id, row.revision);
      const receipt = await this.receiver.upload({
        projectId: row.project_id,
        uploadId: row.upload_id,
        documentId: row.document_id,
        revision: Number(row.revision),
        contentHash: row.content_hash,
        byteSize: Number(row.byte_size),
        recipient: row.recipient,
        purpose: row.purpose,
        dataScope: row.data_scope,
        attributionUserId: row.attribution_user_id,
        content: revision.content
      });
      this.db.prepare("UPDATE qa_server_copies SET status='uploaded',remote_ref=?,last_error='',updated_at=? WHERE copy_id=?")
        .run(receipt.remoteRef, this.iso(), copyId);
    } catch (error) {
      this.db.prepare("UPDATE qa_server_copies SET status='failed',last_error=?,updated_at=? WHERE copy_id=?")
        .run(errorMessage(error), this.iso(), copyId);
    }
    return this.mapCopy(this.copyRowByAnyProject(copyId));
  }

  private copyRowByAnyProject(copyId: string): CopyRow {
    const row = this.db.prepare("SELECT * FROM qa_server_copies WHERE copy_id=?").get(copyId) as CopyRow | undefined;
    if (!row) throw new HttpError(404, "server_copy_not_found", "服务端副本记录不存在。");
    return row;
  }

  private async deleteCopy(row: CopyRow): Promise<ServerCopy> {
    this.db.prepare("UPDATE qa_server_copies SET status='deleting',attempts=attempts+1,updated_at=? WHERE copy_id=?")
      .run(this.iso(), row.copy_id);
    try {
      if (!this.receiver) throw new Error("尚未配置知识接收方");
      await this.receiver.remove({ projectId: row.project_id, uploadId: row.upload_id, remoteRef: row.remote_ref });
      this.db.prepare("UPDATE qa_server_copies SET status='deleted',last_error='',updated_at=? WHERE copy_id=?")
        .run(this.iso(), row.copy_id);
    } catch (error) {
      this.db.prepare("UPDATE qa_server_copies SET status='delete_failed',last_error=?,updated_at=? WHERE copy_id=?")
        .run(errorMessage(error), this.iso(), row.copy_id);
    }
    return this.mapCopy(this.copyRowByAnyProject(row.copy_id));
  }

  async retryServerCopy(projectId: string, copyId: string): Promise<ServerCopy> {
    const row = this.copyRow(projectId, copyId);
    if (row.status === "failed" || row.status === "uploading" || row.status === "queued") {
      return this.uploadCopy(row.copy_id);
    }
    if (row.status === "delete_queued" || row.status === "delete_failed" || row.status === "deleting") {
      return this.deleteCopy(row);
    }
    return this.mapCopy(row);
  }

  listUploads(projectId: string, limit = 50): { uploads: UploadRecord[] } {
    const rows = this.db.prepare(`SELECT * FROM qa_upload_previews
      WHERE project_id=? AND status IN ('confirmed','expired','cancelled')
      ORDER BY created_at DESC, preview_id DESC LIMIT ?`).all(projectId, limit) as PreviewRow[];
    return { uploads: rows.map((row) => this.mapRecord(row)) };
  }

  getUpload(projectId: string, uploadId: string): UploadRecord {
    const row = this.db.prepare("SELECT * FROM qa_upload_previews WHERE project_id=? AND upload_id=?")
      .get(projectId, uploadId) as PreviewRow | undefined;
    if (!row) throw new HttpError(404, "upload_not_found", "上传记录不存在或不属于当前项目。");
    return this.mapRecord(row);
  }

  listServerCopies(projectId: string, documentId?: string): { copies: ServerCopy[] } {
    const rows = documentId
      ? this.db.prepare("SELECT * FROM qa_server_copies WHERE project_id=? AND document_id=? ORDER BY created_at DESC").all(projectId, documentId)
      : this.db.prepare("SELECT * FROM qa_server_copies WHERE project_id=? ORDER BY created_at DESC LIMIT 100").all(projectId);
    return { copies: (rows as CopyRow[]).map((row) => this.mapCopy(row)) };
  }

  /**
   * Deletion targets are independent: the local index (archive + index row), the mirrored
   * source file, and each service copy. A target that cannot finish returns a retryable
   * receipt, and its stored status stays queued/failed rather than pretending success.
   */
  async deleteTargets(input: {
    projectId: string;
    documentId: string;
    userId: string;
    targets: Array<"index" | "source" | "server_copy">;
  }): Promise<{ documentId: string; receipts: TargetReceipt[] }> {
    const receipts: TargetReceipt[] = [];
    let document: DocumentDetail | null = null;
    try {
      document = this.store.getDocument(input.projectId, input.documentId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw error;
      }
      throw error;
    }
    if (input.targets.includes("index")) {
      const wasActive = document.document.status === "active";
      if (wasActive) {
        this.store.archiveDocument({
          projectId: input.projectId,
          documentId: input.documentId,
          userId: input.userId,
          expectedRevision: document.document.revision
        });
      }
      this.db.prepare("DELETE FROM qa_document_index WHERE project_id=? AND document_id=?").run(input.projectId, input.documentId);
      receipts.push({
        target: "index",
        status: wasActive ? "deleted" : "not_found",
        retryable: false,
        detail: wasActive ? "已从本地检索索引移除并归档资料。" : "资料此前已归档，检索索引无记录。"
      });
    }
    if (input.targets.includes("source")) {
      const dir = path.join(this.root, "qa-knowledge-sources", input.projectId, input.documentId);
      const within = path.resolve(dir).startsWith(path.resolve(this.root, "qa-knowledge-sources") + path.sep);
      let existed = false;
      if (within) {
        try {
          await fs.access(dir);
          existed = true;
        } catch {
          existed = false;
        }
        if (existed) await fs.rm(dir, { recursive: true, force: true });
      }
      receipts.push({
        target: "source",
        status: existed ? "deleted" : "not_stored",
        retryable: false,
        detail: existed ? "已删除本机镜像源文件。" : "本机没有留存该资料的源文件副本。"
      });
    }
    if (input.targets.includes("server_copy")) {
      const copies = this.db.prepare("SELECT * FROM qa_server_copies WHERE project_id=? AND document_id=? ORDER BY created_at DESC")
        .all(input.projectId, input.documentId) as CopyRow[];
      const pending = copies.filter((row) => row.status !== "deleted" && row.status !== "not_required");
      if (!pending.length) {
        receipts.push({
          target: "server_copy",
          status: copies.some((row) => row.status === "deleted") ? "not_found" : "not_stored",
          retryable: false,
          detail: "没有待删除的服务端副本。"
        });
      } else {
        let queueOnly = false;
        for (const copy of pending) {
          if (!this.receiver) {
            this.db.prepare("UPDATE qa_server_copies SET status='delete_queued',last_error=?,updated_at=? WHERE copy_id=?")
              .run("尚未配置知识接收方", this.iso(), copy.copy_id);
            queueOnly = true;
            continue;
          }
          this.db.prepare("UPDATE qa_server_copies SET status='delete_queued',updated_at=? WHERE copy_id=?").run(this.iso(), copy.copy_id);
          const result = await this.deleteCopy(copy);
          if (result.status !== "deleted") queueOnly = true;
        }
        receipts.push({
          target: "server_copy",
          status: queueOnly ? "queued" : "deleted",
          retryable: queueOnly,
          detail: queueOnly ? "服务端副本删除尚未完成，已排队；可重试。" : "服务端副本已删除。"
        });
      }
    }
    return { documentId: input.documentId, receipts };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "未知错误";
}
