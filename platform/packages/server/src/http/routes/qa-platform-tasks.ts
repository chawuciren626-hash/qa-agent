/**
 * 平台任务列表路由（TL-3 切片）：列表 / 详情 / 新建本地任务 / 编辑 / AI 分析 / 开始测试 / 终止。
 *
 * 口径：见《AITestHarness平台任务列表建设方案-2026-11-20》T1~T5。数据来源为平台同步任务与用户创建的本地任务；列表查询不创建数据。
 * AI 分析 = 总控预分析：建/复用 test_agent 分析会话自动发「平台任务简报」（sender=server），
 * 结论由总控经 POST /analysis-result 异步回写；engine 侧动作为 platform_task_writeback。
 * 开始测试：优先把分析会话原地升级为测试工作会话（否则新建总控会话），注入「平台任务
 * 开工」指令后再绑定状态；前端拿到 sessionId 后打开既有全流程阶段页——本模块不做流程页。
 * 本地任务的测试环境：保存时按 base_url 匹配项目环境（命中复用，未命中登记新环境），
 * 开始测试把 env 带进会话任务档案（qa_tasks.env），run 执行由此拿到被测地址。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { userText } from "@prismshadow/penguin-core";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { qaEnabled } from "../../services/qa-engine.js";
import { QaPlatformTaskService } from "../../services/qa-platform-task-service.js";
import type { PlatformTaskDb } from "../../services/qa-platform-task-service.js";
import { normalizeBaseUrl, upsertEnvironment } from "../../services/project-environment-service.js";
import { QaTaskRunRegistry } from "../../services/qa-task-run-registry.js";
import { loadPoolCapacity } from "../../services/pool-capacity.js";
import type { KnowledgeDb } from "../../services/qa-project-knowledge.js";
import { readUserModelRef } from "./user-models.js";
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

/**
 * 平台预建 run：建 manifest + 六阶段计划 + 交付范围名全是确定性文件写入，
 * 不该占用总控的 LLM 往返。run_id 来自预登记；会话工作区的目录上下文通过
 * .qa-session.json 传给引擎脚本，与子 agent 后续工具调用看到的是同一个上下文。
 * 任何一步失败都回退旧路径（开工指令仍要求队长 create_run/plan_run），不阻断开始测试。
 */
const PLATFORM_STAGES = ["analysis", "test_points", "test_cases", "execution", "defects", "report"];

function precreatePlatformRun(deps: AgentsRouteDeps, sessionId: string, runId: string, scopeName: string): boolean {
  // Desktop runtimes create their run through the installed stage tools; never spawn VM scripts for their mirror.
  if (deps.authState?.localExecution?.broker.binding(sessionId)) return false;
  if (!qaEnabled || !/^run-[A-Za-z0-9-]+$/.test(runId)) return false;
  const engineRoot = process.env.AITEST_ENGINE_ROOT;
  if (!engineRoot) return false;
  const workspace = deps.sessionsRepo.findById(sessionId)?.workspace;
  if (!workspace) return false;
  try {
    const marker = JSON.parse(readFileSync(resolve(workspace, ".qa-session.json"), "utf8")) as Record<string, unknown>;
    if (marker.session_id !== sessionId || resolve(String(marker.session_root)) !== resolve(workspace)) return false;
    if (marker.engine_root !== resolve(engineRoot)) return false;
    const manifestPath = resolve(String(marker.run_root), runId, "manifest.json");
    if (existsSync(manifestPath)) {
      const existing = JSON.parse(readFileSync(manifestPath, "utf8")) as { orchestration?: { plan?: { stages?: unknown[] } } };
      if (existing.orchestration?.plan?.stages?.length) return true;
    }
    const env = { ...process.env, QA_DIRECTORY_CONTEXT: JSON.stringify(marker) };
    const runScript = (name: string, args: string[]) =>
      execFileSync(process.execPath, [resolve(engineRoot, "scripts", name), ...args], {
        cwd: engineRoot, env, windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024,
      });
    runScript("create-run.mjs", [`--run-id=${runId}`]);
    runScript("plan-run.mjs", [
      `--run-id=${runId}`, `--stages=${PLATFORM_STAGES.join(",")}`,
      "--review-mode=staged", "--workflow-mode=lifecycle", "--source-mode=provided_materials",
      "--execution-platform=web", `--scope-name=${scopeName}`, "--platform-bootstrap",
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 建分析/工作会话：默认走项目默认模型；项目未设默认时回退**当前账号**的模型设置
 * （设置 → 模型 的 default_model，未设默认再取第一条——与聊天页模型选择器同源），
 * 成员在自己配置过模型时也能发起分析。两处都没有模型时给出可操作的错误。
 */
async function createWorkSession(
  deps: AgentsRouteDeps,
  args: { projectId: string; agentId: string; userId?: string },
): Promise<{ sessionId: string }> {
  const base = { projectId: args.projectId, agentId: args.agentId, userId: args.userId, client: "web" as const };
  try {
    return await deps.sessionService.createSession(base);
  } catch (e) {
    if ((e as { code?: string }).code !== "no_default_model") throw e;
    // 账号级回退需要知道是哪个用户；无用户上下文（理论不可达）保持原错误。
    if (!args.userId) throw e;
    const ref = await readUserModelRef(deps.config!.root, args.userId);
    if (!ref) {
      throw new HttpError(
        409,
        "no_model_configured",
        "没有可用模型：项目未设置默认模型，当前账号的「设置 → 模型」里也没有已配置的模型。请任配其一后重试。"
      );
    }
    return await deps.sessionService.createSession({ ...base, modelId: ref.modelId, provider: ref.provider });
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

  app.get("/qa/platform-tasks", async (c) => {
    const { projectId } = scope(c);
    const includeTerminated = c.req.query("includeTerminated") === "true";
    return c.json(svc.list(projectId, includeTerminated));
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
      { task: svc.createLocal({ projectId, userId, title, description, envName: env.envName, envBaseUrl: env.envBaseUrl, account, ends: Array.isArray(body.ends) ? body.ends : undefined, changeSource: typeof body.changeSource === "string" ? body.changeSource : undefined }) },
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
        ...(target.source === "local" && Array.isArray(body.ends)
          ? { ends: body.ends as string[] }
          : {}),
        ...(target.source === "local" && body.changeSource !== undefined
          ? { changeSource: strField(body.changeSource, "invalid_change_source", "变更关联", { max: 200 }) }
          : {}),
      });
      if (!result.updated) notFound();
      return c.json(result);
    } catch (e) {
      asHttp(e);
    }
  });

  // 附件（B1-3b）：AI 分析的文本型补充输入。base64 JSON 传输（同 trace import 先例），
  // 仅收文本类——二进制对同步模型通道没有输入位置，明确拒收而不是静默丢内容。
  app.post("/qa/platform-tasks/:taskId/attachments", async (c) => {
    const { projectId, userId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    try {
      const body = await readJson(c);
      const filename = strField(body.filename, "invalid_filename", "附件文件名", { required: true, max: 200 });
      const mime = strField(body.mime, "invalid_mime", "附件类型", { max: 100 }) || "text/plain";
      const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64.trim() : "";
      if (!dataBase64) throw new HttpError(400, "attachment_empty", "附件内容为空。");
      if (dataBase64.length > 90 * 1024) throw new HttpError(400, "attachment_too_large", "单个附件超过 60KB 上限。");
      const contentText = Buffer.from(dataBase64, "base64").toString("utf8");
      if (!contentText.trim()) throw new HttpError(400, "attachment_empty", "附件内容为空。");
      if (/[\u0000]/.test(contentText) || (contentText.match(/[\u0001-\u0008\u000e-\u001f]/g)?.length ?? 0) > 8) {
        throw new HttpError(400, "attachment_not_text", "仅支持文本类附件（md/txt/json/csv/html/yaml 等）。");
      }
      const attachment = svc.addAttachment({ projectId, userId, id: taskId, filename, mime, contentText });
      return c.json({ attachment, attachments: svc.listAttachments(projectId, taskId) }, 201);
    } catch (e) {
      asHttp(e);
    }
  });

  app.get("/qa/platform-tasks/:taskId/attachments", async (c) => {
    const { projectId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    return c.json({ attachments: svc.listAttachments(projectId, taskId) });
  });

  app.delete("/qa/platform-tasks/:taskId/attachments/:attachmentId", async (c) => {
    const { projectId, userId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    const attachmentId = requireValidId(c, "attachmentId");
    const removed = svc.removeAttachment(projectId, taskId, attachmentId, userId);
    if (!removed) notFound();
    return c.json({ removed: true });
  });

  app.post("/qa/platform-tasks/:taskId/analyze", async (c) => {
    const { projectId, userId } = scope(c);
    const taskId = requireValidId(c, "taskId");
    try {
      // 同步分析：项目默认模型直接分析任务填写内容并回填结构化结论（无会话、无流程）。
      const result = await svc.analyze({ projectId, userId, id: taskId });
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
    const found = svc.findAny(projectId, taskId) ?? notFound();
    // B3 状态登记闸（同步层方案 K5）——仅本机服务模式有意义：平台镜像任务（server_link_id
    // 非空）开工前先经本地 sync worker 登记服务端（A3）——成功才继续建会话；离线/冲突
    // 409 拦截提示（"开始测试必须在线登记"，本地缓存照常可看）。服务端直写行
    // （server_link_id NULL）与本地任务跳过；未配置同步（registerPlatformTaskState 返回
    // null）= 放行。remote 客户端模式下本机服务不启动，开始测试请求直接落在远程服务
    // 进程——行是服务端直写行（NULL），闸天然旁路，业务数据只在远程库。
    if (found.source === "platform") {
      const serverLinkId = (deps.db
        .prepare("SELECT server_link_id FROM platform_task_links WHERE link_id = ?")
        .get(taskId) as { server_link_id: string | null } | undefined)?.server_link_id ?? null;
      if (serverLinkId) {
        try {
          const applied = await deps.authState?.accountClient?.registerPlatformTaskState(userId, serverLinkId, "in_progress");
          if (applied !== null && applied !== undefined && !applied.applied) {
            throw new HttpError(409, "sync_state_rejected", applied.reason || "服务端状态登记未生效，请刷新后重试。");
          }
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(409, "sync_offline", `服务端不可达，开始测试被拦截（开始测试需在线登记）：${e instanceof Error ? e.message : "未知错误"}`);
        }
      }
    }
    let sessionId: string;
    if (typeof body.sessionId === "string" && body.sessionId.trim()) {
      const existing = deps.sessionsRepo.findById(body.sessionId.trim());
      if (!existing || existing.projectId !== projectId) {
        throw new HttpError(404, "session_not_found", "指定的会话不存在或不属于当前项目。");
      }
      sessionId = existing.sessionId;
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
        const session = await createWorkSession(deps, { projectId, agentId, userId });
        sessionId = session.sessionId;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(
          409,
          "session_create_failed",
          `测试工作会话创建失败：${e instanceof Error ? e.message : "未知错误"}`
        );
      }
    }
    // B1-5 登记前移：先建任务档案并预登记 run（status='planned'）。run_id 平台分配、随开工
    // 指令下发；随后服务端用同一 id 预建 manifest/计划，队长直接进入派发。manifest 落盘后
    // observeRun 升级为事实行，startRun 把发起升级为 running。预登记/预建失败都不拦开始
    // 测试——登记是判据通道不是闸，失败退回旧路径由队长 create_run/引擎 startRun 兜底。
    let plannedRunId: string | null = null;
    try {
      const planned = new QaTaskRunRegistry(deps.db as unknown as KnowledgeDb, undefined, undefined, undefined, loadPoolCapacity(deps.config?.root)).createPlannedRun({
        projectId,
        sessionId,
        userId,
        env: found.source === "local" ? found.row.env_name ?? "" : undefined,
        title: found.row.title,
        briefing: { taskId, source: found.source },
      });
      plannedRunId = planned.runId;
    } catch {
      // 环境绑定与预登记都是增强，不是闸：失败留给会话内补选/引擎侧兜底。
    }
    // 开工指令先于状态绑定发送（忙时排队）：失败任务保持可开始、可重试，不留半启动状态。
    // 业务材料与运行预登记合并为同一条 server 消息：引擎按「最后一条用户消息」归档 run 输入，
    // 拆成两条会让预登记元数据挤掉任务原文，导致需求分析首轮因缺材料停工、再返修重派。
    const workStart = svc.workStartBriefing(projectId, taskId);
    if (!workStart) throw notFound();
    const runPrepared = plannedRunId
      ? precreatePlatformRun(deps, sessionId, plannedRunId, found.row.title ?? "")
      : false;
    const briefing = plannedRunId
      ? runPrepared
        ? `${workStart}\n\n【运行已就绪】run_id=${plannedRunId} 的 manifest、六阶段计划（需求分析→测试点→用例→执行→缺陷→报告）与交付范围名已由平台预建，输入材料在本条消息中、派发时由引擎归档。直接进入需求分析派发，禁止再调用 create_run/plan_run/configure_delivery/extend_plan；逐阶段人工审阅保持不变。`
        : `${workStart}\n\n【运行预登记】本次运行已由平台预登记，run_id=${plannedRunId}。create_run 必须复用该 id（请求体带 "run_id":"${plannedRunId}"），不得自行生成新 id；plan/extend 均沿用此 run。manifest 将以此 id 落盘并与预登记行对账。`
      : workStart;
    const startMessages = [userText(briefing, "server")];
    try {
      await deps.manager.startTask(sessionId, startMessages, { queueIfBusy: true });
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

/**
 * 跨项目任务列表（`/api/me/qa-platform-tasks`）。
 *
 * 任务列表是「全部项目的任务」：项目管理是独立模块，在里面点项目视图 / 环境 / 资料
 * 不该反向筛掉别的模块的列表。作用域因此由调用者身份决定——按 Access 给出的可访问项目
 * 聚合，而不是按当前选中项目过滤。行内操作仍回落到项目作用域接口，所以每行都带 projectId。
 */
export interface QaPlatformTaskGlobalDeps {
  db: PlatformTaskDb;
  /** 用户名下（拥有 + 被授权）的项目 id；跨项目查询的唯一作用域来源。 */
  accessibleProjectIds: (userId: string) => string[];
  /**
   * 项目显示名（projectConfig.getName）。跨项目列表按 id 聚合，前端项目切换器可能尚未
   * 加载或缓存过期——由服务端随列表一并给出名称，避免"所属项目"列回落成项目编号。
   */
  projectName?: (projectId: string) => Promise<string | undefined>;
}

export function qaPlatformTasksGlobalRoutes(deps: QaPlatformTaskGlobalDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (!qaEnabled) return app;
  const svc = new QaPlatformTaskService(deps.db);
  app.get("/", async (c) => {
    const userId = c.var.user.userId;
    const includeTerminated = c.req.query("includeTerminated") === "true";
    const projectIds = deps.accessibleProjectIds(userId);
    const projectNames: Record<string, string> = {};
    if (deps.projectName) {
      const names = await Promise.all(projectIds.map(async (id) => [id, await deps.projectName!(id)] as const));
      for (const [id, name] of names) if (name) projectNames[id] = name;
    }
    return c.json({ ...svc.listAcrossProjects(projectIds, includeTerminated), projectIds, projectNames });
  });
  return app;
}
