/** U3 execution safety routes: checkpoints, side effects, cleanup and interface coverage. */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { QaU3SafetyStore } from "../../services/qa-u3-safety.js";
import type { AgentsRouteDeps } from "./agents.js";

export function registerQaU3SafetyRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  const store = new QaU3SafetyStore(deps.db);
  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, userId: c.var.user.userId };
  };
  const objectBody = async (c: Context<AppEnv>) => {
    const body = await readJson(c);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body", "请求体必须是对象。");
    return body as Record<string, unknown>;
  };

  app.post("/qa/u3/attempts/:attemptId/checkpoints", async (c) => {
    const { projectId, userId } = scope(c);
    const body = await objectBody(c);
    const checkpoint = store.recordCheckpoint(projectId, requireValidId(c, "attemptId"), body, userId);
    const coverage = body.interfaceCoverage ? store.recordInterfaceCoverage(projectId, requireValidId(c, "attemptId"), body.interfaceCoverage as Record<string, unknown>, userId) : null;
    return c.json({ ...checkpoint, ...(coverage ? { interfaceCoverage: coverage } : {}) }, 201);
  });

  app.post("/qa/u3/attempts/:attemptId/side-effects", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.recordSideEffect(projectId, requireValidId(c, "attemptId"), await objectBody(c), userId), 201);
  });

  app.patch("/qa/u3/side-effects/:effectId", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.updateSideEffect(projectId, requireValidId(c, "effectId"), await objectBody(c), userId), 200);
  });

  app.post("/qa/u3/attempts/:attemptId/cleanup-actions", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.recordCleanup(projectId, requireValidId(c, "attemptId"), await objectBody(c), userId), 201);
  });

  app.post("/qa/u3/attempts/:attemptId/cancellations", async (c) => {
    const { projectId, userId } = scope(c);
    const body = await objectBody(c);
    const result = store.requestCancellation(projectId, requireValidId(c, "attemptId"), body, userId) as { cancellationId: string };
    if (body.sessionId && body.runtimeAbort === true) {
      const aborted = deps.manager.abortTask(String(body.sessionId));
      if (aborted) await store.acknowledgeCancellation(projectId, result.cancellationId, {
        propagation: { model: "acknowledged", tool: "acknowledged" },
        residualState: "unknown",
        notes: "SessionManager.abortTask acknowledged model/tool cancellation; browser/WSL verification pending."
      }, userId);
    }
    return c.json(result, 201);
  });

  app.post("/qa/u3/cancellations/:cancellationId/acknowledge", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.acknowledgeCancellation(projectId, requireValidId(c, "cancellationId"), await objectBody(c), userId), 200);
  });

  app.post("/qa/u3/cancellations/:cancellationId/process-verifications", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.addProcessVerification(projectId, requireValidId(c, "cancellationId"), await objectBody(c), userId), 201);
  });

  app.post("/qa/u3/attempts/:attemptId/fault-injections", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.recordFaultInjection(projectId, requireValidId(c, "attemptId"), await objectBody(c), userId), 201);
  });

  app.patch("/qa/u3/fault-injections/:injectionId", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.updateFaultInjection(projectId, requireValidId(c, "injectionId"), await objectBody(c), userId), 200);
  });
  app.get("/qa/u3/attempts/:attemptId/safety", (c) => {
    const { projectId } = scope(c);
    return c.json(store.safetySummary(projectId, requireValidId(c, "attemptId")));
  });
}
