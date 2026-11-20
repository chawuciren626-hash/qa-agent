/**
 * 执行登记（判据 1 的排查线）：发起时写一行，结束时回填结论。
 *
 * **这里没有队列。** 产品模型是"用户发起会话，会话里就跑起来"，多个会话天然并行；
 * 不存在"等待某个执行器来领走"的任务池。所以只有两个动作：
 *
 *   开始 → `running`（带上要跑哪份计划、哪个环境）
 *   结束 → manifest 事实 + 统计，状态收敛
 *
 * 为什么还要这两行数据：不登记的话，"执行器没启动"、"浏览器崩了"、"跑到一半会话被关掉"
 * 在数据上都是"什么都没有"，三者在排查时长得一模一样。登记之后，至少能回答"这次发起过
 * 没有、跑到哪、是不是卡住了"。
 *
 * 边界：
 *   - 不判定结果对错：status / counts 都来自 manifest，本层不重新解读；
 *   - 不自动重跑：疑似中断只在读时标 `stalled`，由人决定重跑（真机上有写操作）；
 *   - 不做派发：谁在什么时候发起执行，是会话/阶段编排的事，不在这条路由里；
 *   - 管资源池但不调度：声明了池的 run 必须先拿到槽位，拿不到直接拒（不排队、不忙等），
 *     结束后归还；租约到期也会自动空出来，所以崩溃的 run 不会永久占住设备。
 */
import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
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
import { readRunTrace } from "../../services/qa-run-trace.js";
import { runHealthSummary } from "../../services/qa-run-health.js";

const RUN_ID = /^run-[A-Za-z0-9-]+$/;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function registerQaRunExecutionRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  if (!qaEnabled || !deps.config) return;
  const registry = new QaTaskRunRegistry(deps.db as unknown as KnowledgeDb);

  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, userId: c.var.user.userId };
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

  /** 结束（或发起失败）时归还槽位。槽位可能已被 TTL 过期后的别人接管，那时什么都不做。 */
  const releaseLeaseOf = (projectId: string, run: { runId: string; resourcePool: string | null }): void => {
    if (!run.resourcePool || !(RESOURCE_POOLS as readonly string[]).includes(run.resourcePool)) return;
    registry.releasePoolSlotOfRun({ projectId, pool: run.resourcePool as ResourcePool, runId: run.runId });
  };

  /**
   * 开始：发起执行的那一刻登记一行 `running`。
   *
   * run_id 由调用方（执行器/剧本编译器）分配，不是服务端随机生成——执行器写完 manifest
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
      throw new HttpError(400, "invalid_run", "发起载荷必须是对象。");
    }
    /*
     * 资源池：声明了池就必须先拿到槽位。
     *
     * 物理设备只有那么多（Android 1-2 台、小程序 1-2 个），两个 run 抢同一台设备的结果是双方
     * 都出现"偶发失败"——而偶发失败最容易被归因成 flaky，flaky 又会被重试掩盖（§14.2 那个
     * 失效模式）。所以这里**拒绝**而不是排队：产品里没有队列，"发起会话就跑"是用户看到的行为，
     * 排到半小时后再跑等于骗人。拒了至少能说清是谁占着、什么时候到期。
     *
     * 不声明池则不受管——池是物理事实，猜一个（比如默认 web）会把纯 API 的 run 也卡住。
     */
    let lease: { slot: number; leaseUntil: string } | null = null;
    if (resourcePool) {
      lease = registry.acquirePoolSlot({ projectId, pool: resourcePool, runId });
      if (!lease) {
        const status = registry.poolStatus(resourcePool);
        const holders = status.holders
          .filter((holder) => !holder.expired)
          .map((holder) => `${holder.runId}（至 ${holder.leaseUntil}）`)
          .join("、");
        throw new HttpError(
          409,
          "pool_full",
          `资源池 ${resourcePool} 没有空槽位（容量 ${status.capacity}）：${holders || "租约刚被释放，请重试"}。`,
        );
      }
    }
    try {
      const run = registry.startRun({
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
      return c.json({ run, lease }, 201);
    } catch (error) {
      // 登记没成，槽位必须还回去，否则这次拼错 id 会白占一个设备直到 TTL 到期。
      if (lease && resourcePool) registry.releasePoolSlot({ projectId, pool: resourcePool, slot: lease.slot, runId });
      // 同一个 run_id 被发起两次：调用方拼错了 id，不是并发冲突，直接报出来。
      if (String((error as Error).message).includes("already exists")) {
        throw new HttpError(409, "run_exists", "该运行标识已存在，不能重复发起。");
      }
      throw error;
    }
  });

  /**
   * 结束：交回 manifest 事实与统计。两处硬校验，少一处这条线就断在看不见的地方：
   *   ① facts.runId 必须等于路径上的 runId——`observeRun` 以 facts 为键，不一致会另插
   *      一条 run，发起的那条永远停在 running；
   *   ② 指纹由调用方算好传上来，本层不读 manifest（读了就有两个真源）。
   */
  app.post("/qa/task-records/:sessionId/runs/:runId/finish", async (c) => {
    const { projectId } = scope(c);
    const sessionId = sessionOf(c, projectId);
    const runId = runIdOf(c);
    const current = registry.run(projectId, runId);
    if (!current || current.sessionId !== sessionId) throw new HttpError(404, "run_not_found", "运行记录不存在。");
    const body = await readJson(c);
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
      const run = registry.finishRun({
        projectId,
        runId,
        facts: normalized,
        manifestPath: body.manifestPath,
        manifestSha256: body.manifestSha256,
        counts,
      });
      // 结束即归还：不归还的话，下一个 run 要等到 TTL 到期才能用这台设备，而"刚跑完一个"
      // 恰恰是最常见的连续调用场景。中断的不走这里——执行器崩了不会调它，租约交给 TTL 兜底。
      releaseLeaseOf(projectId, run);
      return c.json({ run });
    } catch (error) {
      const message = String((error as Error).message);
      if (message.includes("not running")) {
        // 已经结束的 run 又交一次结果：拿旧结果覆盖新结果，或同一次执行发起了两遍。
        throw new HttpError(409, "run_not_running", "该运行已结束，不能再次回填。");
      }
      throw error;
    }
  });

  /**
   * 一次运行的执行痕迹：**这次发起过没有、跑起来了没有、是不是卡住了**。
   *
   * 三个问题的答案来自三处不同的事实，故意不合并成一个"状态"字段：
   *   - `registered`：平台有没有这次运行的登记行（`qa_runs`）；
   *   - `trace.execution`：执行器自己写在 run 目录里的痕迹（锁 / 状态 / 密封尝试）；
   *   - `trace.stalled`：把上面两者放在时间轴上推出来的判断，附原因。
   *
   * `registered=false` 而 `trace.present=true` 是**有价值的不一致**：目录里有这次运行，
   * 平台没登记过——说明它绕过所有服务端写入就开跑了（或登记那一步失败了）。这里不替它补
   * 一行，因为"补"会把这个事实抹掉；要不要补由人决定（重跑或补登记都行，但得知道补了什么）。
   */
  app.get("/qa/task-records/:sessionId/runs/:runId/trace", async (c) => {
    const { projectId } = scope(c);
    const sessionId = sessionOf(c, projectId);
    const runId = runIdOf(c);
    const workspace = deps.sessionsRepo.findById(sessionId)?.workspace ?? "";
    const run = registry.run(projectId, runId);
    // 登记行存在但与本次会话无关时，不返回它的内容（跨会话猜 run_id 也看不到别人在跑什么）。
    const registered = Boolean(run && run.sessionId === sessionId);
    const trace = readRunTrace(workspace, runId);
    if (!registered && !trace.present) throw new HttpError(404, "run_not_found", "运行记录不存在。");
    return c.json({ registered, run: registered ? run : null, trace });
  });

  /**
   * 一次 run 的健康摘要（§6.5 缺口②）：工具调用 / 降级 / 检查诊断 + 会话 token 用量
   * （全量与本 run 开始后的增量）。排障的"看哪里"从这里开始，不用再翻三条流水。
   */
  app.get("/qa/task-records/:sessionId/runs/:runId/health", async (c) => {
    const { projectId } = scope(c);
    const sessionId = sessionOf(c, projectId);
    const runId = runIdOf(c);
    const workspace = deps.sessionsRepo.findById(sessionId)?.workspace ?? "";
    const run = registry.run(projectId, runId);
    const registered = Boolean(run && run.sessionId === sessionId);
    // 与 trace 路由同一纪律：登记行不在且 run 目录没有痕迹 → 这个 run 不存在。
    if (!registered && !readRunTrace(workspace, runId).present) throw new HttpError(404, "run_not_found", "运行记录不存在。");
    return c.json(runHealthSummary({ db: deps.db as unknown as DatabaseSync, engineRoot: (process.env.AITEST_ENGINE_ROOT ?? "").trim(), workspace }, sessionId, runId));
  });
}
