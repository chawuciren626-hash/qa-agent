/** U2 contract preparation routes: auditable TestMission, Oracle, Case Graph and Envelope planning. */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { QaU2ContractStore } from "../../services/qa-u2-contracts.js";
import type { AgentsRouteDeps } from "./agents.js";

export function registerQaU2ContractRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  const store = new QaU2ContractStore(deps.db);
  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, userId: c.var.user.userId };
  };
  const ownerScope = (c: Context<AppEnv>) => {
    const { projectId, userId } = scope(c);
    const access = deps.access.requireProjectAccess(userId, projectId);
    if (access.role !== "owner" || access.ownerUserId !== userId) {
      throw new HttpError(403, "project_owner_required", "仅项目所有者可以确认 Oracle 或冻结执行环境合同。");
    }
    return { projectId, userId };
  };
  const objectBody = async (c: Context<AppEnv>) => {
    const body = await readJson(c);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body", "请求体必须是对象。");
    return body as Record<string, unknown>;
  };

  app.post("/qa/u2/missions", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.createMission(projectId, userId, await objectBody(c)), 201);
  });

  app.get("/qa/u2/missions", (c) => {
    const { projectId } = scope(c);
    return c.json(store.listMissions(projectId));
  });

  app.get("/qa/u2/missions/:missionId", (c) => {
    const { projectId } = scope(c);
    return c.json(store.getMission(projectId, requireValidId(c, "missionId")));
  });

  app.post("/qa/u2/missions/:missionId/oracles", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.createOracle(projectId, requireValidId(c, "missionId"), await objectBody(c)), 201);
  });

  app.post("/qa/u2/oracles/:oracleId/confirm", async (c) => {
    const { projectId, userId } = ownerScope(c);
    return c.json(store.confirmOracle(projectId, requireValidId(c, "oracleId"), userId, await objectBody(c)), 200);
  });

  app.post("/qa/u2/missions/:missionId/case-links", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.linkOracle(projectId, requireValidId(c, "missionId"), await objectBody(c), userId), 201);
  });

  app.post("/qa/u2/missions/:missionId/envelopes", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.createEnvelope(projectId, requireValidId(c, "missionId"), await objectBody(c), userId), 201);
  });

  app.post("/qa/u2/missions/:missionId/attempts", async (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.startAttempt(projectId, requireValidId(c, "missionId"), await objectBody(c), userId), 201);
  });

  app.get("/qa/u2/missions/:missionId/attempts", (c) => {
    const { projectId } = scope(c);
    return c.json(store.listAttempts(projectId, requireValidId(c, "missionId")));
  });

  app.get("/qa/u2/attempts/:attemptId", (c) => {
    const { projectId } = scope(c);
    return c.json(store.getAttempt(projectId, requireValidId(c, "attemptId")));
  });

  app.post("/qa/u2/attempts/:attemptId/finish", async (c) => {
    const { projectId, userId } = ownerScope(c);
    return c.json(store.finishAttempt(projectId, requireValidId(c, "attemptId"), await objectBody(c), userId), 200);
  });
  app.post("/qa/u2/envelopes/:envelopeId/freeze", async (c) => {
    const { projectId, userId } = ownerScope(c);
    return c.json(store.freezeEnvelope(projectId, requireValidId(c, "envelopeId"), userId), 200);
  });
}
