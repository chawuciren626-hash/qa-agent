/**
 * run 派发队列（判据 1 的执行侧半程）。
 *
 * 为什么需要这一层：执行发生在用户的机器上（本地浏览器执行器），服务端既不能 spawn
 * 它，也不能假定它随时在线。于是只能反过来——执行器来拉。没有"待执行"这个状态，
 * run 就只能等执行完了才第一次出现在库里，`run_id` 也就没有从派发到报告的那条线。
 *
 * 边界：
 *   - 这里只管**排队的三个动作**（派发、领取、交回结果），不管怎么执行、用什么剧本；
 *   - 结果仍以 manifest 为事实真源：回填必须带 manifest 路径与指纹，走 `observeRun`；
 *   - 不校验"这个执行器有没有资格跑这条业务"——那是项目成员权限（scope）与执行授权
 *     （P4 判据 3，计划指纹）各自的事，混进来会让队列层变成第二个权限点。
 */
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { qaEnabled } from "../../services/qa-engine.js";
import type { KnowledgeDb } from "../../services/qa-project-knowledge.js";
import {
  QaTaskRunRegistry,
  RESOURCE_POOLS,
  RUN_KINDS,
  type ResourcePool,
  type RunKind,
  type RunManifestFacts,
} from "../../services/qa-task-run-registry.js";
import type { AgentsRouteDeps } from "./agents.js";

const RUN_ID = /^run-[A-Za-z0-9-]+$/;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
/** 执行器标识：由客户端给（主机名 / 设备号），只做字符与长度约束，不当身份用。 */
const WORKER = /^[A-Za-z0-9._:-]{1,64}$/;

export function registerQaRunDispatchRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  if (!qaEnabled || !deps.config) return;
  const registry = new QaTaskRunRegistry(deps.db as unknown as KnowledgeDb);

  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, userId: c.var.user.userId };
  };

  /**
   * 租约持有者的实际身份。客户端给的 worker 名不可信，但它必须与登录用户绑定：
   * 否则同一项目里另一个人可以拿别人的 run_id 去回填（队列层的越权不是靠"猜不到 id"防的）。
   */
  const claimOwner = (userId: string, worker: unknown): string => {
    if (typeof worker !== "string" || !WORKER.test(worker)) {
      throw new HttpError(400, "invalid_worker", "执行器标识格式无效。");
    }
    return `${userId}::${worker}`;
  };

  const sessionOf = (c: Context<AppEnv>, projectId: string): string => {
    const sessionId = c.req.param("sessionId") ?? "";
    if (!SESSION_ID.test(sessionId)) throw new HttpError(404, "task_not_found", "任务不存在。");
    const row = deps.sessionsRepo.findById(sessionId);
    if (!row || row.projectId !== projectId) throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
    return sessionId;
  };

  const runIdOf = (c: Context<AppEnv>): string => {
    const runId = c.req.param("runId") ?? "";
    if (!RUN_ID.test(runId)) throw new HttpError(400, "invalid_run", "运行标识无效。");
    return runId;
  };

  /**
   * 派发：把"要跑这一份"写成一条 queued 的 run。
   *
   * run_id 由调用方（总控/剧本编译器）分配，不是服务端随机生成——执行器写完 manifest
   * 要用同一个 id 回填，两边各生成一次就会得到两条互不相认的记录。
   */
  app.post("/qa/task-records/:sessionId/runs", async (c) => {
    const { projectId, userId } = scope(c);
    const sessionId = sessionOf(c, projectId);
    const body = await readJson(c);
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!RUN_ID.test(runId)) throw new HttpError(400, "invalid_run", "运行标识必须是 run- 前缀的字母数字串。");
    if (body.kind !== undefined && !(RUN_KINDS as readonly string[]).includes(String(body.kind))) {
      throw new HttpError(400, "invalid_run", "运行类型无效。");
    }
    let resourcePool: ResourcePool | null = null;
    if (body.resourcePool !== undefined && body.resourcePool !== null) {
      if (!(RESOURCE_POOLS as readonly string[]).includes(String(body.resourcePool))) {
        throw new HttpError(400, "invalid_run", "资源池无效。");
      }
      resourcePool = body.resourcePool as ResourcePool;
    }
    if (body.env !== undefined) {
      if (typeof body.env !== "string" || body.env.length > 64) throw new HttpError(400, "invalid_run", "环境名格式无效。");
      const exists = deps.db
        .prepare("SELECT 1 AS ok FROM project_environments WHERE project_id = ? AND env = ?")
        .get(projectId, body.env) as { ok?: number } | undefined;
      if (body.env !== "" && !exists) throw new HttpError(400, "unknown_environment", "该环境未在项目中登记。");
    }
    if (body.dispatch !== undefined && (!body.dispatch || typeof body.dispatch !== "object" || Array.isArray(body.dispatch))) {
      throw new HttpError(400, "invalid_run", "派发载荷必须是对象。");
    }
    try {
      const run = registry.enqueueRun({
        projectId,
        sessionId,
        userId,
        runId,
        env: body.env as string | undefined,
        kind: (body.kind as RunKind | undefined) ?? "execution",
        resourcePool,
        deviceId: typeof body.deviceId === "string" ? body.deviceId : null,
        dispatch: (body.dispatch as Record<string, unknown> | undefined) ?? {},
        title: typeof body.title === "string" ? body.title : undefined,
      });
      return c.json({ run }, 201);
    } catch (error) {
      // 同一个 run_id 被派发两次：调用方拼错了 id，不是并发冲突，直接报出来。
      if (String((error as Error).message).includes("already exists")) {
        throw new HttpError(409, "run_exists", "该运行标识已存在，不能重复派发。");
      }
      throw error;
    }
  });

  /**
   * 领取。返回整条 run（含 dispatch 载荷）——执行器拿它去决定跑哪份计划。
   *
   * 没东西可领时是 204 而不是 404：轮询是常态，"现在没有"不是一个错误，
   * 让客户端用异常分支处理空闲状态，日志里会全是假错误。
   */
  app.post("/qa/run-queue/claim", async (c) => {
    const { projectId, userId } = scope(c);
    const body = await readJson(c);
    const workerId = claimOwner(userId, body.worker);
    const leaseMs = body.leaseMs === undefined ? undefined : Number(body.leaseMs);
    if (leaseMs !== undefined && (!Number.isFinite(leaseMs) || leaseMs <= 0)) {
      throw new HttpError(400, "invalid_worker", "租约时长必须是正数毫秒。");
    }
    if (body.kind !== undefined && !(RUN_KINDS as readonly string[]).includes(String(body.kind))) {
      throw new HttpError(400, "invalid_run", "运行类型无效。");
    }
    const claimed = registry.claimRun({
      projectId,
      workerId,
      leaseMs,
      kind: body.kind as RunKind | undefined,
    });
    if (!claimed) return c.body(null, 204);
    return c.json({ run: claimed.run, reclaimed: claimed.reclaimed, leaseUntil: claimed.leaseUntil });
  });

  /**
   * 回填。三处硬校验，少一处判据 1 就不成立：
   *   ① facts.runId 必须等于路径上的 runId——否则执行器可以拿自己的租约给另一条 run 登记结果，
   *      派发→执行→报告这条线在这里断开，而库里看不出断点；
   *   ② 指纹必须由调用方算好传上来，本层不读 manifest（读了就有两个真源）；
   *   ③ 只有持租约的执行器能交回（registry 校验 claimed_by）。
   */
  app.post("/qa/run-queue/:runId/report", async (c) => {
    const { projectId, userId } = scope(c);
    const runId = runIdOf(c);
    const body = await readJson(c);
    const workerId = claimOwner(userId, body.worker);
    if (!body.facts || typeof body.facts !== "object" || Array.isArray(body.facts)) {
      throw new HttpError(400, "invalid_run", "回填必须携带 manifest 事实。");
    }
    const facts = body.facts as Record<string, unknown>;
    if (facts.runId !== runId) {
      throw new HttpError(400, "run_mismatch", "回填事实的 run_id 与目标运行不一致。");
    }
    if (typeof facts.status !== "string" || !facts.status) {
      throw new HttpError(400, "invalid_run", "回填事实缺少 status。");
    }
    if (typeof body.manifestPath !== "string" || !body.manifestPath) {
      throw new HttpError(400, "invalid_run", "回填必须给出 manifest 路径。");
    }
    if (typeof body.manifestSha256 !== "string" || !body.manifestSha256) {
      throw new HttpError(400, "invalid_run", "回填必须给出 manifest 指纹。");
    }
    let counts: Record<string, number> | undefined;
    if (body.counts !== undefined) {
      if (!body.counts || typeof body.counts !== "object" || Array.isArray(body.counts)) {
        throw new HttpError(400, "invalid_run", "统计必须是对象。");
      }
      counts = {};
      for (const [key, value] of Object.entries(body.counts as Record<string, unknown>)) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "invalid_run", "统计值必须是非负数。");
        counts[key] = n;
      }
    }
    const normalized: RunManifestFacts = {
      runId,
      status: facts.status,
      manifestVersion: facts.manifestVersion === undefined || facts.manifestVersion === null ? null : Number(facts.manifestVersion),
      resourcePool: typeof facts.resourcePool === "string" ? facts.resourcePool : null,
      sutVersion: typeof facts.sutVersion === "string" ? facts.sutVersion : null,
      baselineHash: typeof facts.baselineHash === "string" ? facts.baselineHash : null,
    };
    try {
      const run = registry.reportRun({
        projectId,
        runId,
        workerId,
        facts: normalized,
        manifestPath: body.manifestPath,
        manifestSha256: body.manifestSha256,
        counts,
      });
      return c.json({ run });
    } catch (error) {
      const message = String((error as Error).message);
      if (message.includes("no active claim") || message.includes("is claimed by")) {
        throw new HttpError(409, "claim_lost", "该运行的租约已失效或不属于当前执行器，请重新领取。");
      }
      throw error;
    }
  });

  /** 交回：执行器发现环境不满足时主动放回队列，而不是占着租约装死。 */
  app.post("/qa/run-queue/:runId/release", async (c) => {
    const { projectId, userId } = scope(c);
    const runId = runIdOf(c);
    const body = await readJson(c);
    const workerId = claimOwner(userId, body.worker);
    const run = registry.releaseRun({
      projectId,
      runId,
      workerId,
      reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined,
    });
    if (!run) throw new HttpError(409, "claim_lost", "该运行的租约不属于当前执行器，无法交回。");
    return c.json({ run });
  });
}
