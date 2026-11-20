/** A3 确认卡点 / A4 报告审批路由：批次、抽样、逐项处置、送审/批准/退回。 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { QaConfirmGateStore, type ExecutionEvidence } from "../../services/qa-confirm-gate.js";
import type { AgentsRouteDeps } from "./agents.js";

export function registerQaConfirmGateRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  const store = new QaConfirmGateStore(deps.db);
  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, userId: c.var.user.userId };
  };
  /**
   * 批准 / 退回是**卡点**，不是日常写入：它决定"这一段产物能不能往下走"。
   *
   * 在这之前，这两个动作只校验"是项目成员"，于是只读成员也能把卡点点掉——而同一个应用里
   * 缺陷确认、复测登记、报告发布早已按 owner 校验（`qa-quality-traceability.ts`）。同一个
   * 产品两套口径，最终一定会被当成"权限判定时灵时不灵"。
   *
   * 送审（submit）仍按成员放开：准备材料是干活，批准才是背书。
   */
  const ownerScope = (c: Context<AppEnv>) => {
    const { projectId, userId } = scope(c);
    const access = deps.access.requireProjectAccess(userId, projectId);
    if (access.role !== "owner" || access.ownerUserId !== userId) {
      throw new HttpError(403, "project_owner_required", "仅项目所有者可以批准或退回确认批次。");
    }
    return { projectId, userId };
  };
  const objectBody = async (c: Context<AppEnv>) => {
    const body = await readJson(c);
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};
    return body as Record<string, unknown>;
  };

  app.post("/qa/confirm/batches", async (c) => {
    const { projectId, userId } = scope(c);
    const body = await objectBody(c);
    return c.json(store.create(projectId, body as { title: unknown; items: unknown; seed?: unknown }, userId), 201);
  });

  app.get("/qa/confirm/batches", (c) => {
    const { projectId } = scope(c);
    return c.json({ batches: store.list(projectId) });
  });

  app.get("/qa/confirm/batches/:batchId", (c) => {
    const { projectId } = scope(c);
    return c.json(store.get(projectId, requireValidId(c, "batchId")));
  });

  app.post("/qa/confirm/batches/:batchId/sample", async (c) => {
    const { projectId, userId } = scope(c);
    const body = await objectBody(c);
    return c.json(store.resample(projectId, requireValidId(c, "batchId"), body.seed ?? String(Date.now()), userId));
  });

  app.post("/qa/confirm/batches/:batchId/items/:itemId/review", async (c) => {
    const { projectId, userId } = scope(c);
    const body = await objectBody(c);
    return c.json(store.review(projectId, requireValidId(c, "batchId"), c.req.param("itemId"), body.decision, userId));
  });

  app.post("/qa/confirm/batches/:batchId/submit", (c) => {
    const { projectId, userId } = scope(c);
    return c.json(store.submit(projectId, requireValidId(c, "batchId"), userId));
  });

  app.post("/qa/confirm/batches/:batchId/approve", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await objectBody(c);
    const evidence = (body.executionEvidence ?? null) as ExecutionEvidence | null;
    return c.json(store.approve(projectId, requireValidId(c, "batchId"), evidence, userId, typeof body.note === "string" ? body.note : undefined));
  });

  app.post("/qa/confirm/batches/:batchId/reject", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const body = await objectBody(c);
    return c.json(store.reject(projectId, requireValidId(c, "batchId"), body.reason, userId));
  });
}
