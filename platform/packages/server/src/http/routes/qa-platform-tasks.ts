/**
 * 平台任务列表路由（TL-3 切片）：列表 / 详情 / 新建本地任务 / 编辑 / AI 分析 / 开始测试 / 终止。
 *
 * 口径：见《AITestHarness平台任务列表建设方案-2026-11-20》T1~T5。数据源当前为演示种子
 * （service.seedDemoIfEmpty，source_system='demo'），平台侧交接包接口就绪后由 ingestion 替换。
 * 开始测试会创建真实测试工作会话（默认取项目内第一个智能体），前端拿到 sessionId 后
 * 打开既有全流程阶段页——本模块不做流程页。
 */
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { qaEnabled } from "../../services/qa-engine.js";
import { QaPlatformTaskService } from "../../services/qa-platform-task-service.js";
import type { PlatformTaskDb } from "../../services/qa-platform-task-service.js";
import type { AgentsRouteDeps } from "./agents.js";

const PRIORITIES = new Set(["high", "medium", "low"]);

function priorityOf(value: unknown, fallback = "medium"): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !PRIORITIES.has(value)) {
    throw new HttpError(400, "invalid_priority", "优先级必须是 high、medium 或 low。");
  }
  return value;
}

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

export function registerQaPlatformTaskRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  if (!qaEnabled || !deps.config) return;
  const svc = new QaPlatformTaskService(deps.db as unknown as PlatformTaskDb);
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
    const priority = priorityOf(body.priority);
    return c.json({ task: svc.createLocal({ projectId, userId, title, description, priority }) }, 201);
  });

  app.post("/qa/platform-tasks/:taskId/edit", async (c) => {
    const { projectId, userId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    const body = await readJson(c);
    try {
      const result = svc.edit({
        projectId,
        userId,
        id: taskId,
        localTitleNote: strField(body.localTitleNote, "invalid_note", "本地标题备注", { max: 500 }),
        localTestFocusNote: strField(body.localTestFocusNote, "invalid_note", "测试重点备注", { max: 2000 }),
        title: strField(body.title, "invalid_title", "任务名称", { max: 200 }) || undefined,
        description: strField(body.description, "invalid_description", "需求描述", { max: 8000 }) || undefined,
        priority: priorityOf(body.priority, ""),
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
      const result = svc.analyze({ projectId, userId, id: taskId });
      if (!result.updated) notFound();
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
    let sessionId: string;
    if (typeof body.sessionId === "string" && body.sessionId.trim()) {
      const existing = deps.sessionsRepo.findById(body.sessionId.trim());
      if (!existing || existing.projectId !== projectId) {
        throw new HttpError(404, "session_not_found", "指定的会话不存在或不属于当前项目。");
      }
      sessionId = existing.sessionId;
    } else {
      // 创建真实测试工作会话：默认取项目内第一个智能体；调用方可显式指定。
      const agentId =
        typeof body.agentId === "string" && body.agentId.trim()
          ? body.agentId.trim()
          : (await deps.agentService.listAgents(projectId))[0]?.agentId;
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
