/**
 * 平台任务列表路由（TL-3 切片）：列表 / 详情 / 新建本地任务 / 编辑 / AI 分析 / 开始测试 / 终止。
 *
 * 口径：见《AITestHarness平台任务列表建设方案-2026-11-20》T1~T5。数据源当前为演示种子
 * （service.seedDemoIfEmpty，source_system='demo'），平台侧交接包接口就绪后由 ingestion 替换。
 * AI 分析 = 总控预分析：建/复用 test_agent 分析会话自动发「平台任务简报」（sender=server），
 * 结论由总控经 POST /analysis-result 异步回写；engine 侧动作为 platform_task_writeback。
 * 开始测试：优先把分析会话原地升级为测试工作会话（否则新建总控会话），注入「平台任务
 * 开工」指令后再绑定状态；前端拿到 sessionId 后打开既有全流程阶段页——本模块不做流程页。
 * 本地任务的测试环境：保存时按 base_url 匹配项目环境（命中复用，未命中登记新环境），
 * 开始测试把 env 带进会话任务档案（qa_tasks.env），run 执行由此拿到被测地址。
 */
import type { Context, Hono } from "hono";
import { userText } from "@prismshadow/penguin-core";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { qaEnabled } from "../../services/qa-engine.js";
import { QaPlatformTaskService } from "../../services/qa-platform-task-service.js";
import type { AnalysisRuntime, PlatformTaskDb } from "../../services/qa-platform-task-service.js";
import { normalizeBaseUrl, upsertEnvironment } from "../../services/project-environment-service.js";
import { QaTaskRunRegistry } from "../../services/qa-task-run-registry.js";
import type { KnowledgeDb } from "../../services/qa-project-knowledge.js";
import type { AgentsRouteDeps } from "./agents.js";

function strField(value: unknown, code: string, label: string, opts: { required?: boolean; max?: number } = {}): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    if (opts.required) throw new HttpError(400, code, `${label}不能为空。`);
    return "";
  }
  if (opts.max && raw.length > opts.max) {
    throw new HttpError(400, code, `${label}不能超过 ${opts.max} 个字符。`);
  }
  return raw;
}

/**
 * 本地任务的测试环境解析：填了 URL 才处理——先按 base_url 精确匹配项目环境，再按主机名
 * 匹配（同主机不同入口路径复用同一环境，不覆盖已登记的地址）；都未命中才从 hostname
 * 派生合规 env 名登记（首个环境自动设默认，复用 upsertEnvironment 既有语义）。
 * 任务存关联的 env 名 + 用户填写的 URL 快照（含路径，环境页的 base_url 以登记时的为准）。
 * URL 格式非法直接 400，不带病入库。
 */
function resolveTaskEnv(db: AgentsRouteDeps["db"], projectId: string, rawUrl: unknown): { envName: string | null; envBaseUrl: string | null } {
  const raw = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!raw) return { envName: null, envBaseUrl: null };
  const baseUrl = normalizeBaseUrl(raw);
  const existing = db
    .prepare("SELECT env FROM project_environments WHERE project_id = ? AND base_url = ?")
    .get(projectId, baseUrl) as { env: string } | undefined;
  if (existing) return { envName: existing.env, envBaseUrl: baseUrl };
  const host = new URL(baseUrl).hostname.toLowerCase();
  const rows = db
    .prepare("SELECT env, base_url FROM project_environments WHERE project_id = ?")
    .all(projectId) as Array<{ env: string; base_url: string }>;
  const byHost = rows.find((r) => {
    try {
      return new URL(r.base_url).hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  });
  if (byHost) return { envName: byHost.env, envBaseUrl: baseUrl };
  const view = upsertEnvironment(db, projectId, { env: deriveEnvName(db, projectId, baseUrl), baseUrl });
  return { envName: view.env, envBaseUrl: baseUrl };
}

/** hostname → 合规 env 名（小写字母开头、[a-z0-9_-]、≤32）；IP 等数字开头的主机加 env- 前缀，撞名追加序号。 */
function deriveEnvName(db: AgentsRouteDeps["db"], projectId: string, baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const slug = host.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "test";
  const base = (/^[a-z]/.test(slug) ? slug : `env-${slug}`).slice(0, 32);
  let candidate = base;
  for (let n = 2; ; n++) {
    const taken = db
      .prepare("SELECT 1 AS ok FROM project_environments WHERE project_id = ? AND env = ?")
      .get(projectId, candidate) as { ok?: number } | undefined;
    if (!taken) return candidate;
    const suffix = `-${n}`;
    candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }
}

export function registerQaPlatformTaskRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  if (!qaEnabled || !deps.config) return;
  const svc = new QaPlatformTaskService(deps.db as unknown as PlatformTaskDb, { completeOnce: deps.completeOnce });
  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, userId: c.var.user.userId };
  };
  const notFound = (): never => {
    throw new HttpError(404, "task_not_found", "任务不存在或不属于当前项目。");
  };
  const asHttp = (e: unknown): never => {
    const err = e as { status?: number; code?: string; message?: string };
    if (err && typeof err.status === "number" && typeof err.code === "string") {
      throw new HttpError(err.status, err.code, err.message ?? "操作被拒绝。");
    }
    throw e as Error;
  };

  // 总控预分析运行时：会话通道与定时任务 scheduler 同源（startTask + userText("server")）。
  const analysisRuntime: AnalysisRuntime = {
    listAgents: (projectId) => deps.agentService.listAgents(projectId),
    createSession: (args) => deps.sessionService.createSession(args),
    findSession: (sessionId) => deps.sessionsRepo.findById(sessionId) ?? null,
    startTask: (sessionId, text, opts) =>
      deps.manager.startTask(sessionId, [userText(text, "server")], opts),
    isSessionBusy: (sessionId) =>
      deps.manager.statusOf(sessionId) !== "idle" || deps.manager.pendingFollowUpCount(sessionId) > 0,
  };

  app.get("/qa/platform-tasks", async (c) => {
    const { projectId } = scope(c);
    const seed = svc.seedDemoIfEmpty(projectId);
    const includeTerminated = c.req.query("includeTerminated") === "true";
    return c.json({ ...svc.list(projectId, includeTerminated), demoSeeded: seed.seeded });
  });

  app.get("/qa/platform-tasks/:taskId", async (c) => {
    const { projectId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    const detail = svc.detail(projectId, taskId);
    if (!detail) notFound();
    return c.json(detail);
  });

  app.post("/qa/platform-tasks/local", async (c) => {
    const { projectId, userId } = scope(c);
    const body = await readJson(c);
    const title = strField(body.title, "invalid_title", "任务名称", { required: true, max: 200 });
    const description = strField(body.description, "invalid_description", "需求描述", { max: 8000 });
    const account = strField(body.account, "invalid_account", "登录账号", { max: 128 });
    // 测试环境选填：填了就解析/登记进项目环境，任务存关联结果；不填两列为 null。
    const env = resolveTaskEnv(deps.db, projectId, body.envBaseUrl);
    return c.json(
      { task: svc.createLocal({ projectId, userId, title, description, envName: env.envName, envBaseUrl: env.envBaseUrl, account }) },
      201
    );
  });

  app.post("/qa/platform-tasks/:taskId/edit", async (c) => {
    const { projectId, userId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    const body = await readJson(c);
    try {
      // 环境解析只对本地任务做（平台任务没有该字段）；未携带 envBaseUrl = 不改环境。
      const target = svc.findAny(projectId, taskId) ?? notFound();
      const localCtx =
        target.source === "local" && body.envBaseUrl !== undefined
          ? resolveTaskEnv(deps.db, projectId, body.envBaseUrl)
          : null;
      const result = svc.edit({
        projectId,
        userId,
        id: taskId,
        localTitleNote: strField(body.localTitleNote, "invalid_note", "本地标题备注", { max: 500 }),
        localTestFocusNote: strField(body.localTestFocusNote, "invalid_note", "测试重点备注", { max: 2000 }),
        title: strField(body.title, "invalid_title", "任务名称", { max: 200 }) || undefined,
        description: strField(body.description, "invalid_description", "需求描述", { max: 8000 }) || undefined,
        ...(localCtx
          ? { envName: localCtx.envName ?? "", envBaseUrl: localCtx.envBaseUrl ?? "" }
          : {}),
        ...(target.source === "local" && body.account !== undefined
          ? { account: strField(body.account, "invalid_account", "登录账号", { max: 128 }) }
          : {}),
      });
      if (!result.updated) notFound();
      return c.json(result);
    } catch (e) {
      asHttp(e);
    }
  });

  app.post("/qa/platform-tasks/:taskId/analyze", async (c) => {
    const { projectId, userId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    try {
      // 总控预分析：登记 running 并发简报后立即返回，结论走 analysis-result 异步回写。
      const result = await svc.analyze({ projectId, userId, id: taskId }, analysisRuntime);
      if (!result.updated) notFound();
      return c.json(result);
    } catch (e) {
      asHttp(e);
    }
  });

  // 总控回写端点（platform_task_writeback 动作调用；Bearer api-token 或登录会话均可，
  // 非进行中（running）的回写被拒——重复回写/无主回写都挡在外面）。
  app.post("/qa/platform-tasks/:taskId/analysis-result", async (c) => {
    const { projectId, userId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    const body = await readJson(c);
    if (!body.summary || typeof body.summary !== "object" || Array.isArray(body.summary)) {
      throw new HttpError(400, "invalid_summary", "summary 必须是包含分析结论的对象。");
    }
    try {
      const result = svc.applyEngineAnalysis({
        projectId,
        userId,
        id: taskId,
        summary: body.summary,
        ...(typeof body.run_id === "string" && body.run_id.trim() ? { runId: body.run_id.trim() } : {}),
        ...(typeof body.session_id === "string" && body.session_id.trim() ? { sessionId: body.session_id.trim() } : {}),
      });
      return c.json(result);
    } catch (e) {
      asHttp(e);
    }
  });

  app.post("/qa/platform-tasks/:taskId/start", async (c) => {
    const { projectId, userId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    const body = await readJson(c);
    // TLQ-1 闸前置：未通过（未分析/已终止/影响待确认）不消耗会话资源
    try {
      svc.assertStartable(projectId, taskId);
    } catch (e) {
      asHttp(e);
    }
    const found = svc.findAny(projectId, taskId) ?? notFound();
    let sessionId: string;
    if (typeof body.sessionId === "string" && body.sessionId.trim()) {
      const existing = deps.sessionsRepo.findById(body.sessionId.trim());
      if (!existing || existing.projectId !== projectId) {
        throw new HttpError(404, "session_not_found", "指定的会话不存在或不属于当前项目。");
      }
      sessionId = existing.sessionId;
    } else if (
      found.row.analysis_session_id &&
      deps.sessionsRepo.findById(found.row.analysis_session_id)?.projectId === projectId
    ) {
      // 分析会话原地升级为测试工作会话：总控已掌握任务上下文，开工指令在同一会话续跑。
      sessionId = found.row.analysis_session_id;
    } else {
      // 新建测试工作会话：默认总控（test_agent，正式流程的编排者）；调用方可显式指定。
      const agents = await deps.agentService.listAgents(projectId);
      const agentId =
        typeof body.agentId === "string" && body.agentId.trim()
          ? body.agentId.trim()
          : agents.find((a) => a.agentId === "test_agent")?.agentId ?? agents[0]?.agentId;
      if (!agentId) {
        throw new HttpError(409, "no_agent_available", "项目内没有可用智能体，请先在项目视图中创建。");
      }
      try {
        const session = await deps.sessionService.createSession({
          projectId,
          agentId,
          userId,
          client: "web",
        });
        sessionId = session.sessionId;
      } catch (e) {
        throw new HttpError(
          409,
          "session_create_failed",
          `测试工作会话创建失败：${e instanceof Error ? e.message : "未知错误"}`
        );
      }
    }
    // 本地任务带环境：开始测试即把 env 绑进会话任务档案（ensureTask 幂等，已有档案不动），
    // run 执行由此拿到被测地址。绑定失败不回滚开始测试——环境可在会话内补选。
    if (found.source === "local" && found.row.env_name) {
      try {
        new QaTaskRunRegistry(deps.db as unknown as KnowledgeDb).ensureTask({
          projectId,
          sessionId,
          userId,
          env: found.row.env_name,
          title: found.row.title,
        });
      } catch {
        // 环境绑定是增强，不是闸：失败留给会话内补选。
      }
    }
    // 开工指令先于状态绑定发送（忙时排队）：失败任务保持可开始、可重试，不留半启动状态。
    const workStart = svc.workStartBriefing(projectId, taskId);
    if (!workStart) throw notFound();
    try {
      await deps.manager.startTask(sessionId, [userText(workStart, "server")], { queueIfBusy: true });
    } catch (e) {
      throw new HttpError(
        409,
        "work_dispatch_failed",
        `开工指令发送失败：${e instanceof Error ? e.message : "未知错误"}（任务未开始，可重试）`
      );
    }
    try {
      const result = svc.start({ projectId, userId, id: taskId, sessionId });
      if (!result.updated) notFound();
      return c.json({ task: result.updated, sessionId, previousStatus: result.previousStatus });
    } catch (e) {
      asHttp(e);
    }
  });

  app.post("/qa/platform-tasks/:taskId/terminate", async (c) => {
    const { projectId, userId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    const body = await readJson(c);
    const result = svc.terminate({
      projectId,
      userId,
      id: taskId,
      reason: strField(body.reason, "invalid_reason", "终止原因", { max: 500 }),
    });
    if (!result.updated) notFound();
    return c.json(result);
  });
}
