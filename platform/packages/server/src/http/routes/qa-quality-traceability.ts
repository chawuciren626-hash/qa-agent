/**
 * Q3 quality traceability routes: design batches, execution results, coverage/risk views,
 * project-level defect lifecycle, retests, and report evidence indexes.
 *
 * Reads need project access. Design/result ingestion and defect discovery are task artifacts
 * a member may write; defect confirmation, repair, retest and report publication need the
 * adjacent Project OWNER. The frozen contract is docs/api-q3-quality-traceability-2026-11-02.md.
 */
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { qaEnabled } from "../../services/qa-engine.js";
import { QaQualityTraceabilityStore } from "../../services/qa-quality-traceability.js";
import type { KnowledgeDb } from "../../services/qa-project-knowledge.js";
import type { AgentsRouteDeps } from "./agents.js";

function limitOf(c: Context): number | undefined {
  const raw = c.req.query("limit");
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "invalid_defect", "limit 必须是整数。");
  return Number(raw);
}

function bodyNumber(value: unknown, code: string, label: string, required = true): number | undefined {
  if (value === undefined && !required) return undefined;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) throw new HttpError(400, code, `${label} 必须是整数。`);
  return number;
}

function runIdOf(c: Context): string {
  const runId = c.req.param("runId") ?? "";
  if (!/^run-[A-Za-z0-9-]+$/.test(runId)) throw new HttpError(400, "invalid_result", "运行标识无效。");
  return runId;
}

export function registerQaQualityTraceabilityRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  if (!qaEnabled || !deps.config) return;
  const store = new QaQualityTraceabilityStore(
    deps.db as unknown as KnowledgeDb,
    (sessionId) => deps.sessionsRepo.findById(sessionId)
  );
  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, userId: c.var.user.userId };
  };
  const memberScope = (c: Context<AppEnv>) => {
    const { projectId, userId } = scope(c);
    const access = deps.access.requireProjectAccess(userId, projectId);
    // QA admins can read any project but do not become its owner: task artifacts stay
    // attributable to people who actually work on the project.
    if (c.var.user.isAdmin && access.ownerUserId !== userId) {
      throw new HttpError(403, "project_member_required", "仅项目成员可以写入测试产物。");
    }
    return { projectId, userId };
  };
  const ownerScope = (c: Context<AppEnv>) => {
    const { projectId, userId } = scope(c);
    const access = deps.access.requireProjectAccess(userId, projectId);
    if (access.role !== "owner" || access.ownerUserId !== userId) {
      throw new HttpError(403, "project_owner_required", "仅项目所有者可以确认缺陷、登记复测或发布报告。");
    }
    return { projectId, userId };
  };

  // ---------------------------------------------------------------- design

  app.post("/qa/tasks/:sessionId/runs/:runId/design", async (c) => {
    const { projectId, userId } = memberScope(c);
    const body = await readJson(c);
    const result = store.createDesignBatch({
      projectId,
      sessionId: c.req.param("sessionId"),
      runId: runIdOf(c),
      userId,
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_design", "expectedRevision", false),
      source: body.source,
      points: body.points,
      cases: body.cases
    });
    return c.json(result, result.created ? 201 : 200);
  });

  app.get("/qa/tasks/:sessionId/runs/:runId/design", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.getDesign(projectId, c.req.param("sessionId"), runIdOf(c)));
  });

  app.get("/qa/tasks/:sessionId/runs/:runId/design/history", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.listDesignBatches(projectId, c.req.param("sessionId"), runIdOf(c)));
  });

  // ---------------------------------------------------------------- results and coverage

  app.post("/qa/tasks/:sessionId/runs/:runId/results", async (c) => {
    const { projectId, userId } = memberScope(c);
    const body = await readJson(c);
    const result = store.ingestResults({
      projectId,
      sessionId: c.req.param("sessionId"),
      runId: runIdOf(c),
      userId,
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_result", "expectedRevision") as number,
      invocationId: body.invocationId,
      results: body.results
    });
    return c.json(result, result.idempotent ? 200 : 201);
  });

  app.get("/qa/tasks/:sessionId/runs/:runId/results", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.listResults(projectId, c.req.param("sessionId"), runIdOf(c)));
  });

  app.get("/qa/tasks/:sessionId/runs/:runId/coverage", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.readCoverage(projectId, c.req.param("sessionId"), runIdOf(c)));
  });

  // ---------------------------------------------------------------- defects

  app.get("/qa/defects", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.listDefects({
      projectId,
      status: c.req.query("status"),
      category: c.req.query("category"),
      severity: c.req.query("severity"),
      sessionId: c.req.query("sessionId"),
      runId: c.req.query("runId"),
      limit: limitOf(c),
      cursor: c.req.query("cursor")
    }));
  });

  app.post("/qa/defects", async (c) => {
    const { projectId, userId } = memberScope(c);
    const body = await readJson(c);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const runId = typeof body.runId === "string" ? body.runId : "";
    const result = store.discoverDefect({
      projectId,
      sessionId,
      runId,
      userId,
      fingerprint: body.fingerprint,
      title: body.title,
      category: body.category,
      confidence: body.confidence,
      severity: body.severity,
      priority: body.priority,
      expectedResult: body.expectedResult,
      actualResult: body.actualResult,
      analysis: body.analysis,
      duplicateOf: body.duplicateOf,
      relatedCases: body.relatedCases,
      evidenceRefs: body.evidenceRefs,
      initialStatus: body.initialStatus
    });
    return c.json(result, result.created ? 201 : 200);
  });

  app.get("/qa/defects/:defectId", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.getDefect(projectId, requireValidId(c, "defectId")));
  });

  app.get("/qa/defects/:defectId/events", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.listDefectEvents(projectId, requireValidId(c, "defectId")));
  });

  app.post("/qa/defects/:defectId/confirm", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.confirmDefect({
      projectId,
      defectId: requireValidId(c, "defectId"),
      userId,
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_defect", "expectedRevision") as number,
      category: body.category,
      severity: body.severity,
      priority: body.priority,
      reason: body.reason,
      evidenceRefs: body.evidenceRefs
    }));
  });

  app.post("/qa/defects/:defectId/reject", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.rejectDefect({
      projectId,
      defectId: requireValidId(c, "defectId"),
      userId,
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_defect", "expectedRevision") as number,
      reason: body.reason,
      evidenceRefs: body.evidenceRefs
    }));
  });

  app.post("/qa/defects/:defectId/fix", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    return c.json(store.fixDefect({
      projectId,
      defectId: requireValidId(c, "defectId"),
      userId,
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_defect", "expectedRevision") as number,
      reason: body.reason,
      evidenceRefs: body.evidenceRefs
    }));
  });

  app.post("/qa/defects/:defectId/retest", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    const result = store.retestDefect({
      projectId,
      defectId: requireValidId(c, "defectId"),
      userId,
      expectedRevision: bodyNumber(body.expectedRevision, "invalid_defect", "expectedRevision") as number,
      retestSessionId: body.retestSessionId,
      retestRunId: body.retestRunId,
      note: body.note,
      evidenceRefs: body.evidenceRefs
    });
    return c.json(result, result.idempotent ? 200 : 201);
  });

  // ---------------------------------------------------------------- reports

  app.post("/qa/tasks/:sessionId/runs/:runId/report-index", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await readJson(c);
    const result = await store.createReportIndex({
      projectId,
      sessionId: c.req.param("sessionId"),
      runId: runIdOf(c),
      userId,
      expectedDesignRevision: bodyNumber(body.expectedDesignRevision, "invalid_report", "expectedDesignRevision") as number,
      htmlPath: body.htmlPath,
      htmlSha256: body.htmlSha256,
      conclusion: body.conclusion,
      evidence: body.evidence,
      untested: body.untested,
      limitations: body.limitations
    });
    return c.json(result, 201);
  });

  app.get("/qa/tasks/:sessionId/runs/:runId/report-index", async (c) => {
    const { projectId } = scope(c);
    return c.json(await store.getReportIndex(projectId, c.req.param("sessionId"), runIdOf(c)));
  });

  app.get("/qa/tasks/:sessionId/runs/:runId/report-index/history", async (c) => {
    const { projectId } = scope(c);
    return c.json(store.listReportIndexes(projectId, c.req.param("sessionId"), runIdOf(c)));
  });
}
