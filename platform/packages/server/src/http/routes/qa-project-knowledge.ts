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

const FORMAT_BY_EXTENSION: Record<string, "markdown" | "text" | "json" | "csv" | "html"> = {
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
  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, userId: c.var.user.userId };
  };
  const ownerScope = (c: Context<AppEnv>) => {
    const { projectId, userId } = scope(c);
    const access = deps.access.requireProjectAccess(userId, projectId);
    if (access.role !== "owner" || access.ownerUserId !== userId) {
      throw new HttpError(403, "project_owner_required", "仅项目所有者可以编辑资料或确认业务规则。");
    }
    return { projectId, userId };
  };
  const taskSession = (projectId: string, sessionId: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
    const session = deps.sessionsRepo.findById(sessionId);
    if (!session || session.projectId !== projectId) throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
    return session;
  };

  // ---------------------------------------------------------------- documents

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
    const session = taskSession(projectId, sessionId);
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
    taskSession(projectId, sessionId);
    return c.json({ snapshot: store.getTaskContextSnapshot(projectId, sessionId) });
  });

  app.get("/qa/tasks/:sessionId/context-snapshot/history", async (c) => {
    const { projectId } = scope(c);
    const sessionId = c.req.param("sessionId");
    taskSession(projectId, sessionId);
    return c.json({ snapshots: store.listTaskContextSnapshots(projectId, sessionId) });
  });

  app.post("/qa/tasks/:sessionId/context-snapshot/refresh", async (c) => {
    const { projectId, userId } = scope(c);
    const sessionId = c.req.param("sessionId");
    taskSession(projectId, sessionId);
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
