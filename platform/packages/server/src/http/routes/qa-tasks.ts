/**
 * 任务档案（P2）：任务的归属环境 / 范围 / 负责人 / 被测版本，以及它的运行清单。
 *
 * 与 `/qa/tasks/:sessionId/runs/:runId` 那套执行视图分开挂前缀，是有意的：
 *   - 那套接口回答"这次运行跑到哪一步、有多少用例过了"（读 manifest 与结果）；
 *   - 这套接口回答"这个任务属于哪、由谁负责、跑过几次、这次比上次坏在哪"（读 DB 登记）。
 * 混在一个前缀下，前端迟早把两种语义当成一种。
 *
 * 写入边界：任务的元信息（env/scope/owner/sut_version）由项目 owner 修改。运行清单与
 * 对比是只读派生，成员可读——它们不产生事实，只索引事实。
 */
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { qaEnabled } from "../../services/qa-engine.js";
import type { KnowledgeDb } from "../../services/qa-project-knowledge.js";
import { QaTaskRunRegistry, RESOURCE_POOLS, TASK_STATUSES, type TaskStatus } from "../../services/qa-task-run-registry.js";
import type { AgentsRouteDeps } from "./agents.js";

const RUN_ID = /^run-[A-Za-z0-9-]+$/;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function registerQaTaskRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  if (!qaEnabled || !deps.config) return;
  const registry = new QaTaskRunRegistry(deps.db as unknown as KnowledgeDb);

  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, userId: c.var.user.userId };
  };

  const ownerScope = (c: Context<AppEnv>) => {
    const { projectId, userId } = scope(c);
    const access = deps.access.requireProjectAccess(userId, projectId);
    if (access.role !== "owner" || access.ownerUserId !== userId) {
      throw new HttpError(403, "project_owner_required", "仅项目所有者可以修改任务归属。");
    }
    return { projectId, userId };
  };

  /**
   * 执行资源池占用情况。这是排障用的读数：跑不动时先看是"没有槽位"还是"任务本身不行"。
   *
   * 只回本项目占用的槽位与整池的空闲数——池是机器级的，其他项目占着几个槽不该对
   * 本项目可见（项目之间互相不该知道对方在跑什么）。
   */
  app.get("/qa/pool-leases", async (c) => {
    const { projectId } = scope(c);
    const pools = RESOURCE_POOLS.map((pool) => {
      const status = registry.poolStatus(pool);
      return {
        pool,
        capacity: status.capacity,
        free: status.free,
        heldByThisProject: status.holders.filter((item) => !item.expired && item.projectId === projectId).length,
      };
    });
    return c.json({ pools });
  });

  /** 会话必须真实存在且属于当前项目，否则读路径会把别家的任务当成自家空任务。 */
  const sessionOf = (c: Context<AppEnv>, projectId: string): string => {
    const sessionId = c.req.param("sessionId") ?? "";
    if (!SESSION_ID.test(sessionId)) throw new HttpError(404, "task_not_found", "任务不存在。");
    const row = deps.sessionsRepo.findById(sessionId);
    if (!row || row.projectId !== projectId) throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
    return sessionId;
  };

  /**
   * 读任务档案。任务行可能还不存在（老会话、从未有过 QA 写入），此时按会话现建一条
   * `origin='created'` 的行返回——用户打开任务页就该看到自己的任务，而不是 404。
   */
  app.get("/qa/task-records/:sessionId", async (c) => {
    const { projectId, userId } = scope(c);
    const sessionId = sessionOf(c, projectId);
    const task = registry.task(projectId, sessionId) ?? registry.ensureTask({ projectId, sessionId, userId });
    return c.json({ task, runs: registry.listRuns(projectId, sessionId) });
  });

  app.put("/qa/task-records/:sessionId", async (c) => {
    const { projectId, userId } = ownerScope(c);
    const sessionId = sessionOf(c, projectId);
    registry.ensureTask({ projectId, sessionId, userId });
    const body = await readJson(c);
    const patch: Parameters<QaTaskRunRegistry["updateTask"]>[2] = {};
    if (body.env !== undefined) {
      if (typeof body.env !== "string" || body.env.length > 64) throw new HttpError(400, "invalid_task", "环境名格式无效。");
      // 环境必须已登记：允许写一个不存在的环境名，等于让 run 归属到一个查不到的地方。
      const exists = deps.db
        .prepare("SELECT 1 AS ok FROM project_environments WHERE project_id = ? AND env = ?")
        .get(projectId, body.env) as { ok?: number } | undefined;
      if (body.env !== "" && !exists) throw new HttpError(400, "unknown_environment", "该环境未在项目中登记。");
      patch.env = body.env;
    }
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || body.title.length > 200) throw new HttpError(400, "invalid_task", "任务标题格式无效。");
      patch.title = body.title;
    }
    if (body.status !== undefined) {
      if (!(TASK_STATUSES as readonly string[]).includes(String(body.status))) throw new HttpError(400, "invalid_task", "任务状态无效。");
      patch.status = body.status as TaskStatus;
    }
    if (body.ownerUserId !== undefined) {
      if (body.ownerUserId !== null && (typeof body.ownerUserId !== "string" || !SESSION_ID.test(body.ownerUserId))) {
        throw new HttpError(400, "invalid_task", "负责人标识格式无效。");
      }
      // 负责人必须是项目成员（owner 天然可担），否则"负责人"只是个称谓。
      if (body.ownerUserId !== null) {
        const member = deps.db
          .prepare(`SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ?
                    UNION SELECT 1 FROM projects WHERE project_id = ? AND owner_user_id = ?`)
          .get(projectId, body.ownerUserId, projectId, body.ownerUserId) as { ok?: number } | undefined;
        if (!member) throw new HttpError(400, "not_a_member", "负责人必须是项目成员。");
      }
      patch.ownerUserId = body.ownerUserId as string | null;
    }
    if (body.scope !== undefined) {
      if (!body.scope || typeof body.scope !== "object" || Array.isArray(body.scope)) {
        throw new HttpError(400, "invalid_task", "任务范围必须是对象。");
      }
      patch.scope = body.scope as Record<string, unknown>;
    }
    if (body.sutVersion !== undefined) {
      if (body.sutVersion !== null && (typeof body.sutVersion !== "string" || body.sutVersion.length > 120)) {
        throw new HttpError(400, "invalid_task", "被测版本格式无效。");
      }
      patch.sutVersion = body.sutVersion as string | null;
    }
    if (body.contextSnapshotId !== undefined) {
      if (body.contextSnapshotId !== null && typeof body.contextSnapshotId !== "string") {
        throw new HttpError(400, "invalid_task", "上下文快照标识格式无效。");
      }
      patch.contextSnapshotId = body.contextSnapshotId as string | null;
    }
    const task = registry.updateTask(projectId, sessionId, patch, userId);
    return c.json({ task });
  });

  /** 运行清单：按 run_index 倒序，最新一次在最前。 */
  app.get("/qa/task-records/:sessionId/runs", async (c) => {
    const { projectId } = scope(c);
    const sessionId = sessionOf(c, projectId);
    const raw = c.req.query("limit");
    const limit = raw === undefined ? 50 : Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new HttpError(400, "invalid_task", "limit 必须是正整数。");
    return c.json({ runs: registry.listRuns(projectId, sessionId, limit) });
  });

  app.get("/qa/task-records/:sessionId/runs/:runId", async (c) => {
    const { projectId } = scope(c);
    const sessionId = sessionOf(c, projectId);
    const runId = c.req.param("runId") ?? "";
    if (!RUN_ID.test(runId)) throw new HttpError(400, "invalid_task", "运行标识无效。");
    const run = registry.run(projectId, runId);
    if (!run || run.sessionId !== sessionId) throw new HttpError(404, "run_not_found", "运行记录不存在。");
    return c.json({ run });
  });

  /**
   * 这次和上次比。`from` 缺省取上一次运行（run_index 比本次小的最近一条），
   * 因为绝大多数调用问的就是"比上次坏了什么"。
   */
  app.get("/qa/task-records/:sessionId/runs/:runId/compare", async (c) => {
    const { projectId } = scope(c);
    const sessionId = sessionOf(c, projectId);
    const runId = c.req.param("runId") ?? "";
    if (!RUN_ID.test(runId)) throw new HttpError(400, "invalid_task", "运行标识无效。");
    const to = registry.run(projectId, runId);
    if (!to || to.sessionId !== sessionId) throw new HttpError(404, "run_not_found", "运行记录不存在。");
    let fromRunId = c.req.query("from");
    if (fromRunId === undefined) {
      const previous = registry
        .listRuns(projectId, sessionId, 200)
        .find((item) => item.runId !== runId && item.runIndex < to.runIndex);
      if (!previous) throw new HttpError(404, "no_previous_run", "这个任务还没有可对比的上一次运行。");
      fromRunId = previous.runId;
    }
    if (!RUN_ID.test(fromRunId)) throw new HttpError(400, "invalid_task", "对比基准运行标识无效。");
    return c.json(registry.compareRuns(projectId, sessionId, fromRunId, runId));
  });
}
