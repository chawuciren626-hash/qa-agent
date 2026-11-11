/**
 * Q2 project knowledge routes: documents/revisions, evidence candidates, confirmed rules,
 * and task context snapshots.
 *
 * Reads need project access; document/rule writes and candidate review need the adjacent
 * Project OWNER (not merely an accessible member, and not an admin who does not own the
 * project). The frozen contract is docs/api-q2-project-knowledge-2026-11-02.md.
 */
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { qaEnabled, qaEngineModule } from "../../services/qa-engine.js";
import {
  DOCUMENT_MAX_BYTES,
  QaProjectKnowledgeStore,
  type KnowledgeDb
} from "../../services/qa-project-knowledge.js";
import type { AgentsRouteDeps } from "./agents.js";
import { FORMAT_BY_EXTENSION, QaKnowledgeLibrary } from "../../services/qa-knowledge-library.js";
import {
  createProjectAccessAuthorizer,
  knowledgeIdentity,
  requireKnowledgeDecision,
  type KnowledgeAuthorizationDecision,
  type KnowledgeOperation,
  type KnowledgeResourceType
} from "../../services/qa-knowledge-authorization.js";
import { renderUntrustedMaterial } from "../../services/qa-knowledge-untrusted.js";
import { QaLibraryReference } from "../../services/qa-library-reference.js";

function limitOf(c: Context, code: string): number | undefined {
  const raw = c.req.query("limit");
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, code, "limit 必须是整数。");
  return Number(raw);
}

function revisionOf(c: Context): number {
  const raw = c.req.param("revision");
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1) throw new HttpError(400, "invalid_document", "修订号无效。");
  return Number(raw);
}

function bodyNumber(value: unknown, code: string, label: string): unknown {
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (typeof value !== "number") throw new HttpError(400, code, `${label} 必须是整数。`);
  return value;
}

export function registerQaProjectKnowledgeRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  if (!qaEnabled || !deps.config) return;
  const root = deps.config.root;
  const store = new QaProjectKnowledgeStore(
    deps.db as unknown as KnowledgeDb,
    (sessionId) => deps.sessionsRepo.findById(sessionId)
  );
  let defaultSkills: { roleId: string; skills: string[] }[] | undefined;
  const defaultSkillRoles = () => {
    if (!defaultSkills) {
      defaultSkills = (qaEngineModule("qa-project-bootstrap").qaRoles() as { id: string; skills: string[] }[])
        .map((role) => ({ roleId: role.id, skills: [...role.skills] }));
    }
    return defaultSkills;
  };
  // Every knowledge read/write goes through this seam. The adapter checks the authenticated
  // user against the Project table on each call; tests may inject a double, but there is no
  // always-allow implementation in production.
  const authorizer = deps.knowledgeAuthorizer ?? createProjectAccessAuthorizer(deps.access);
  const receiver = deps.knowledgeReceiver ?? {
    upload: async (payload: import('../../services/qa-knowledge-receiver.js').KnowledgeCopyPayload) => {
      const client = deps.authState?.accountClient;
      if (!client) throw new HttpError(503, 'receiver_unavailable', '尚未连接服务端资料接收方。');
      return client.uploadKnowledgeCopy(payload);
    },
    remove: async (input: { projectId: string; uploadId: string }) => {
      const client = deps.authState?.accountClient;
      const copy = deps.db.prepare('SELECT attribution_user_id FROM qa_server_copies WHERE project_id=? AND upload_id=?').get(input.projectId, input.uploadId);
      if (!client || !copy) throw new HttpError(503, 'receiver_unavailable', '尚未连接服务端资料接收方。');
      return client.removeKnowledgeCopy(String(copy.attribution_user_id), input);
    },
  };
  app.use('/qa/*', async (c, next) => {
    if (!/\/qa\/(?:documents|knowledge|uploads|server-copies)(?:\/|$)/.test(c.req.path) && !/\/context-snapshot(?:\/|$)/.test(c.req.path)) { await next(); return; }
    const client = deps.authState?.accountClient;
    if (client) {
      const projectId = requireValidId(c, 'projectId');
      await client.authorizeUserPath(c.var.user.userId, `/api/projects/${encodeURIComponent(projectId)}/agents/qa/knowledge`, c.req.method);
      const decision = await client.authorizeInvocation({ userId: c.var.user.userId, projectId }, { kind: 'project', id: projectId }, 'read', { requireFresh: true });
      if (!decision.allowed) throw new HttpError(403, 'knowledge_forbidden', '资料访问授权已失效。');
    }
    await next();
  });
  const library = new QaKnowledgeLibrary(
    deps.db as unknown as KnowledgeDb,
    store,
    deps.config.root,
    receiver
  );
  const authorize = (
    c: Context<AppEnv>,
    operation: KnowledgeOperation,
    resourceType: KnowledgeResourceType,
    options: { id?: string; constraints?: Parameters<typeof authorizer.authorizeInvocation>[3] } = {}
  ): { projectId: string; userId: string; decision: KnowledgeAuthorizationDecision } => {
    const projectId = requireValidId(c, "projectId");
    const userId = c.var.user.userId;
    const decision = authorizer.authorizeInvocation(
      knowledgeIdentity({ userId, projectId }),
      { type: resourceType, projectId, ...(options.id ? { id: options.id } : {}) },
      operation,
      options.constraints
    );
    requireKnowledgeDecision(decision);
    return { projectId, userId, decision };
  };
  const scope = (c: Context<AppEnv>) => {
    const { projectId, userId } = authorize(c, "read", "knowledge_index");
    return { projectId, userId };
  };
  const ownerScope = (c: Context<AppEnv>) => {
    const { projectId, userId } = authorize(c, "write", "document");
    return { projectId, userId };
  };
  const taskSession = (projectId: string, sessionId: string, userId: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
    const session = deps.sessionsRepo.findById(sessionId);
    if (!session || session.projectId !== projectId) throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
    if (session.ownerUserId && session.ownerUserId !== userId) throw new HttpError(404, 'task_not_found', '任务不存在或不属于当前用户。');
    return session;
  };

  // ---------------------------------------------------------------- documents

  const personalReferences = new QaLibraryReference(store, (projectId, userId, itemId) =>
    qaEngineModule('client-library').libraryOperation(root, projectId, userId, 'GET', itemId));
  app.get('/qa/knowledge/library/:itemId', async c => {
    const { projectId, userId } = scope(c);
    return c.json(await personalReferences.preview(projectId, userId, requireValidId(c, 'itemId')));
  });
  app.post('/qa/knowledge/library/:itemId', async c => {
    const { projectId, userId } = ownerScope(c);
    return c.json(await personalReferences.promote(projectId, userId, requireValidId(c, 'itemId'), await readJson(c)));
  });

  app.get("/qa/documents", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.listDocuments({
      projectId,
      q: c.req.query("q"),
      status: c.req.query("status"),
      sourceType: c.req.query("sourceType"),
      limit: limitOf(c, "invalid_document"),
      cursor: c.req.query("cursor")
    }));
  });

  app.post("/qa/documents", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.createDocument({
      projectId,
      userId,
      title: body.title,
      format: body.format,
      content: body.content,
      source: body.source,
      changeNote: body.changeNote
    }), 201);
  });

  app.post("/qa/documents/import", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    if (!filename || filename.length > 300) throw new HttpError(400, "unsupported_document_format", "文件名无效。");
    if (typeof body.dataBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64) || body.dataBase64.length % 4 !== 0) {
      throw new HttpError(400, "unsupported_document_format", "导入内容必须是有效的 base64 文本文件。");
    }
    const bytes = Buffer.from(body.dataBase64, "base64");
    if (bytes.length > DOCUMENT_MAX_BYTES) throw new HttpError(413, "document_too_large", "资料不能超过 2 MiB。");
    const base = filename.split(/[\\/]/).pop() ?? "";
    const dot = base.lastIndexOf(".");
    const extension = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
    const format = FORMAT_BY_EXTENSION[extension];
    if (!format) throw new HttpError(400, "unsupported_document_format", "本阶段只支持 Markdown、文本、JSON、CSV、HTML 文件。");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new HttpError(400, "unsupported_document_format", "文件不是有效的 UTF-8 文本。");
    }
    const title = body.title === undefined ? (dot >= 0 ? base.slice(0, dot) : base) : body.title;
    return c.json(store.createDocument({
      projectId,
      userId,
      title,
      format,
      content,
      source: { type: "upload", filename: base, capturedAt: new Date().toISOString() },
      changeNote: body.changeNote
    }), 201);
  });

  app.get("/qa/documents/:documentId", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.getDocument(projectId, requireValidId(c, "documentId")));
  });

  app.put("/qa/documents/:documentId", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.updateDocument({
      projectId,
      documentId: requireValidId(c, "documentId"),
      userId,
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_document", "expectedRevision"),
      title: body.title,
      content: body.content,
      changeNote: body.changeNote
    }));
  });

  app.delete("/qa/documents/:documentId", async (c) => {
    const { projectId, userId } = ownerScope(c);
    return c.json(store.archiveDocument({
      projectId,
      documentId: requireValidId(c, "documentId"),
      userId,
      expectedRevision: bodyNumber(c.req.query("expectedRevision"), "invalid_document", "expectedRevision")
    }));
  });

  app.get("/qa/documents/:documentId/revisions", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.listRevisions({
      projectId,
      documentId: requireValidId(c, "documentId"),
      limit: limitOf(c, "invalid_document"),
      cursor: c.req.query("cursor")
    }));
  });

  app.get("/qa/documents/:documentId/revisions/:revision", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.getRevision(projectId, requireValidId(c, "documentId"), revisionOf(c)));
  });

  // ---------------------------------------------------------------- retrieval index

  app.get("/qa/knowledge/search", async (c) => {
    const { projectId } = authorize(c, "search", "knowledge_index");
    return c.json(store.searchDocuments({
      projectId,
      q: c.req.query("q") ?? "",
      limit: limitOf(c, "invalid_search")
    }));
  });

  /**
   * Rendered material for a runtime prompt. The caller gets data blocks only: the wrapper
   * states that the body is untrusted, and the body cannot close the wrapper.
   */
  app.get("/qa/knowledge/context", async (c) => {
    const { projectId } = authorize(c, "read", "knowledge_index");
    const raw = c.req.query("documentIds") ?? "";
    const ids = raw.split(",").map((item) => item.trim()).filter(Boolean);
    if (!ids.length || ids.length > 20) throw new HttpError(400, "invalid_context", "documentIds 必须是 1 至 20 个资料标识。");
    const blocks = ids.map((documentId) => {
      if (!/^doc-[A-Za-z0-9._-]+$/.test(documentId)) throw new HttpError(400, "invalid_context", "资料标识无效。");
      const detail = store.getDocument(projectId, documentId);
      if (detail.document.status !== "active") throw new HttpError(409, "document_archived", "资料已归档，不能读取为任务依据。");
      return {
        documentId,
        revision: detail.document.currentRevision,
        contentHash: detail.document.contentHash,
        trust: "untrusted_data" as const,
        text: renderUntrustedMaterial({
          documentId,
          revision: detail.document.currentRevision,
          contentHash: detail.document.contentHash,
          title: detail.document.title,
          content: detail.content
        })
      };
    });
    return c.json({ schemaVersion: 1, trust: "untrusted_data", blocks, combined: blocks.map((block) => block.text).join("\n\n") });
  });

  // ---------------------------------------------------------------- uploads / server copies

  app.post("/qa/uploads/preview", async (c) => {
    const { projectId, userId } = authorize(c, "upload", "upload");
    const body = await readJson(c);
    return c.json(library.previewUpload({
      projectId,
      userId,
      filename: body.filename,
      dataBase64: body.dataBase64,
      title: body.title,
      recipient: body.recipient,
      purpose: body.purpose,
      dataScope: body.dataScope
    }), 201);
  });

  app.post("/qa/uploads/:previewId/confirm", async (c) => {
    const previewId = requireValidId(c, "previewId");
    const { projectId, userId, decision } = authorize(c, "upload", "upload", {
      id: previewId,
      constraints: { contentHash: typeof c.req.query("contentHash") === "string" ? c.req.query("contentHash") : undefined }
    });
    const body = await readJson(c);
    const result = await library.confirmUpload({
      projectId,
      userId,
      previewId,
      contentHash: body.contentHash,
      confirmed: body.confirmed,
      idempotencyKey: body.idempotencyKey
    });
    const authorization = {
      decisionId: decision.decisionId,
      policyRevision: decision.policyRevision,
      checkedAt: decision.checkedAt,
      expiresAt: decision.expiresAt
    };
    return c.json({ ...result, authorization }, result.idempotent ? 200 : 201);
  });

  app.get("/qa/uploads", async (c) => {
    const { projectId } = authorize(c, "read", "upload");
    return c.json(library.listUploads(projectId));
  });

  app.get("/qa/uploads/:uploadId", async (c) => {
    const { projectId } = authorize(c, "read", "upload");
    return c.json(library.getUpload(projectId, requireValidId(c, "uploadId")));
  });

  app.get("/qa/server-copies", async (c) => {
    const { projectId } = authorize(c, "read", "upload");
    const documentId = c.req.query("documentId");
    if (documentId !== undefined && !/^[A-Za-z0-9_-]+$/.test(documentId)) {
      throw new HttpError(400, "invalid_document", "资料标识无效。");
    }
    return c.json(library.listServerCopies(projectId, documentId));
  });

  app.post("/qa/server-copies/:copyId/retry", async (c) => {
    const copyId = requireValidId(c, "copyId");
    const { projectId, decision } = authorize(c, "upload", "upload", { id: copyId });
    const copy = await library.retryServerCopy(projectId, copyId);
    return c.json({
      copy,
      authorization: {
        decisionId: decision.decisionId,
        policyRevision: decision.policyRevision,
        checkedAt: decision.checkedAt,
        expiresAt: decision.expiresAt
      }
    });
  });

  app.post("/qa/documents/:documentId/delete-targets", async (c) => {
    const documentId = requireValidId(c, "documentId");
    const { projectId, userId, decision } = authorize(c, "delete", "document", { id: documentId });
    const body = await readJson(c);
    const targets = body.targets;
    if (!Array.isArray(targets) || !targets.length || targets.length > 3
      || targets.some((target) => target !== "index" && target !== "source" && target !== "server_copy")) {
      throw new HttpError(400, "invalid_delete_target", "删除目标必须是 index、source、server_copy 中的一个或多个。");
    }
    const result = await library.deleteTargets({ projectId, documentId, userId, targets });
    return c.json({
      ...result,
      authorization: {
        decisionId: decision.decisionId,
        policyRevision: decision.policyRevision,
        checkedAt: decision.checkedAt,
        expiresAt: decision.expiresAt
      }
    });
  });

  // ---------------------------------------------------------------- candidates

  app.get("/qa/knowledge/candidates", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.listCandidates({
      projectId,
      status: c.req.query("status"),
      limit: limitOf(c, "invalid_candidate"),
      cursor: c.req.query("cursor")
    }));
  });

  app.post("/qa/knowledge/candidates", async (c) => {
    const { projectId, userId } = scope(c);
    const body = await readJson(c);
    // A project member may suggest knowledge, but cannot attest that an Agent produced it.
    // Agent provenance is reserved for the trusted runtime service call.
    if (body.createdBy !== undefined) throw new HttpError(403, "agent_origin_requires_runtime", "候选来源由服务端确定，不能在请求中指定。");
    return c.json(store.createCandidate({
      projectId,
      userId,
      title: body.title,
      statement: body.statement,
      rationale: body.rationale,
      scope: body.scope,
      sourceRefs: body.sourceRefs,
      createdBy: { type: "user" }
    }), 201);
  });

  app.get("/qa/knowledge/candidates/:candidateId", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.getCandidate(projectId, requireValidId(c, "candidateId")));
  });

  app.put("/qa/knowledge/candidates/:candidateId", async (c) => {
    const { projectId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.updateCandidate({
      projectId,
      candidateId: requireValidId(c, "candidateId"),
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_candidate", "expectedRevision"),
      title: body.title,
      statement: body.statement,
      rationale: body.rationale,
      scope: body.scope
    }));
  });

  app.post("/qa/knowledge/candidates/:candidateId/reject", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.rejectCandidate({
      projectId,
      candidateId: requireValidId(c, "candidateId"),
      userId,
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_candidate", "expectedRevision"),
      reason: body.reason
    }));
  });

  app.post("/qa/knowledge/candidates/:candidateId/confirm", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    const result = store.confirmCandidate({
      projectId,
      candidateId: requireValidId(c, "candidateId"),
      userId,
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_candidate", "expectedRevision"),
      title: body.title,
      statement: body.statement,
      scope: body.scope
    });
    return c.json(result, result.idempotent ? 200 : 201);
  });

  // ---------------------------------------------------------------- rules

  app.get("/qa/knowledge/rules", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.listRules({
      projectId,
      status: c.req.query("status"),
      limit: limitOf(c, "invalid_rule"),
      cursor: c.req.query("cursor")
    }));
  });

  app.post("/qa/knowledge/rules", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.createRule({
      projectId,
      userId,
      title: body.title,
      statement: body.statement,
      scope: body.scope,
      sourceRefs: body.sourceRefs,
      changeNote: body.changeNote
    }), 201);
  });

  app.get("/qa/knowledge/rules/:ruleId", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.getRuleDetail(projectId, requireValidId(c, "ruleId")));
  });

  app.get("/qa/knowledge/rules/:ruleId/versions", async (c) => {
    const { projectId } = scope(c);
    return c.json({ versions: store.listRuleVersions(projectId, requireValidId(c, "ruleId")) });
  });

  app.post("/qa/knowledge/rules/:ruleId/revise", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.reviseRule({
      projectId,
      ruleId: requireValidId(c, "ruleId"),
      userId,
      expectedVersion: bodyNumber(body.expectedVersion, "invalid_rule", "expectedVersion"),
      title: body.title,
      statement: body.statement,
      scope: body.scope,
      sourceRefs: body.sourceRefs,
      changeNote: body.changeNote
    }));
  });

  app.post("/qa/knowledge/rules/:ruleId/retire", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.retireRule({
      projectId,
      ruleId: requireValidId(c, "ruleId"),
      userId,
      expectedVersion: bodyNumber(body.expectedVersion, "invalid_rule", "expectedVersion"),
      reason: body.reason
    }));
  });

  // ---------------------------------------------------------------- task snapshots

  app.post("/qa/tasks/:sessionId/context-snapshot", async (c) => {
    const { projectId, userId } = scope(c);
    const sessionId = c.req.param("sessionId");
    const session = taskSession(projectId, sessionId, userId);
    const result = await store.ensureTaskContextSnapshot({
      projectId,
      sessionId,
      agentId: session.agentId,
      createdBy: userId,
      root,
      userId,
      defaultSkills: defaultSkillRoles()
    });
    return c.json(result, result.created ? 201 : 200);
  });

  app.get("/qa/tasks/:sessionId/context-snapshot", async (c) => {
    const { projectId } = scope(c);
    const sessionId = c.req.param("sessionId");
    taskSession(projectId, sessionId, c.var.user.userId);
    return c.json({ snapshot: store.getTaskContextSnapshot(projectId, sessionId) });
  });

  app.get("/qa/tasks/:sessionId/context-snapshot/history", async (c) => {
    const { projectId } = scope(c);
    const sessionId = c.req.param("sessionId");
    taskSession(projectId, sessionId, c.var.user.userId);
    return c.json({ snapshots: store.listTaskContextSnapshots(projectId, sessionId) });
  });

  app.post("/qa/tasks/:sessionId/context-snapshot/refresh", async (c) => {
    const { projectId, userId } = scope(c);
    const sessionId = c.req.param("sessionId");
    taskSession(projectId, sessionId, c.var.user.userId);
    const body = await readJson(c);
    return c.json(store.refreshTaskContextSnapshot({
      projectId,
      sessionId,
      userId,
      expectedVersion: bodyNumber(body.expectedVersion, "invalid_context_refresh", "expectedVersion"),
      instruction: body.instruction,
      documentIds: body.documentIds,
      ruleIds: body.ruleIds,
      all: body.all
    }));
  });
}
