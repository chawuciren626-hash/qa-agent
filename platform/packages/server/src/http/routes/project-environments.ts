/**
 * 环境路由：/api/projects/:projectId/environments
 *
 * 三组动作：环境（列、建/改、看单个、触发建档、等建档）；探索资产（knowledge 读/覆盖、
 * hypotheses 提/判）；探索派发（派发一轮、看轮次、等验证码答案、中止、取验证码截图）。
 * 建档与探索都是后台任务（202 + 轮询），失败一律如实落态，不伪造成功。
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import { projectDir } from "@prismshadow/penguin-core";
import type { AppEnv } from "../../auth/middleware.js";
import type { Db } from "../../hmr/capabilities.js";
import type { ProjectLifecycle } from "../../mechanisms/projects.js";
import {
  KNOWLEDGE_LAYERS,
  HYPOTHESIS_STATUSES,
  appendVerdict,
  createHypothesis,
  listHypotheses,
  listKnowledge,
  replaceKnowledgeLayer,
  summarizeHypotheses,
  type HypothesisStatus,
  type KnowledgeEntryInput,
  type KnowledgeLayer,
} from "../../services/environment-knowledge-service.js";
import {
  awaitBootstrap,
  defaultEnvironment,
  findEnvironment,
  listEnvironments,
  startBootstrap,
  upsertEnvironment,
} from "../../services/project-environment-service.js";
import {
  abortExploration,
  answerCaptcha,
  captchaImagePath,
  latestExploration,
  listExplorations,
  startExploration,
  type ExplorationDeps,
  type ExplorationMerge,
  type ExplorationRun,
} from "../../services/project-exploration-service.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";
import { explorationKnowledgeSync } from "../../services/exploration-knowledge-sync.js";

export interface ProjectEnvironmentDeps {
  db: Db;
  projectService: Pick<ProjectLifecycle, "requireProjectAccess" | "requireProjectOwner">;
  /** 数据根目录；项目目录 = root/<projectId>，maps 落在其 maps/<env>/ 下。 */
  root: string;
  /** 引擎仓库根；未配置时不伪造成功，直接 503。 */
  engineRoot?: string;
  /** 测试注入：替换子进程执行器。 */
  run?: Parameters<typeof startBootstrap>[0]["run"];
  /** 测试注入：替换探索脚本执行器与 maps 合并器。 */
  explorationRun?: ExplorationRun;
  explorationMerge?: ExplorationMerge;
}

export function projectEnvironmentsRoutes(deps: ProjectEnvironmentDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const scoped = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return projectId;
  };
  const owned = (c: Context<AppEnv>) => {
    const projectId = scoped(c);
    deps.projectService.requireProjectOwner(c.var.user.userId, projectId);
    return projectId;
  };
  const bootstrapDeps = (projectId: string) => ({
    db: deps.db,
    projectDir: projectDir(deps.root, projectId),
    engineRoot: deps.engineRoot,
    run: deps.run,
  });
  const explorationDeps = (projectId: string): ExplorationDeps => ({
    db: deps.db,
    projectDir: projectDir(deps.root, projectId),
    engineRoot: deps.engineRoot,
    run: deps.explorationRun,
    merge: deps.explorationMerge,
    // B1 联动：探索成功后把资产落成项目资料并触发知识构建（engine 未配置时联动
    // 失败会如实记进轮次摘要，不影响探索结论）。
    knowledgeSync: explorationKnowledgeSync({ db: deps.db, engineRoot: deps.engineRoot }),
  });

  app.get("/", async (c) => {
    const projectId = scoped(c);
    c.header("Cache-Control", "no-store");
    return c.json({
      projectId,
      environments: listEnvironments(deps.db, projectId),
      defaultEnv: defaultEnvironment(deps.db, projectId)?.env ?? null,
    });
  });

  app.post("/", async (c) => {
    const projectId = owned(c);
    const body = await readJson(c);
    const environment = upsertEnvironment(deps.db, projectId, {
      env: body.env,
      baseUrl: body.baseUrl,
      isDefault: body.isDefault === true,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ environment }, 201);
  });

  app.get("/:env", async (c) => {
    const projectId = scoped(c);
    const environment = findEnvironment(deps.db, projectId, c.req.param("env") ?? "");
    if (!environment) throw new HttpError(404, "environment_not_found", "环境不存在");
    c.header("Cache-Control", "no-store");
    return c.json({ environment });
  });

  /** 触发建档：立即 202，前端轮询 GET /:env 看 status 变化。 */
  app.post("/:env/bootstrap", async (c) => {
    const projectId = owned(c);
    const environment = startBootstrap(bootstrapDeps(projectId), projectId, c.req.param("env") ?? "");
    c.header("Cache-Control", "no-store");
    return c.json({ environment }, 202);
  });

  /** 同步等待建档结束（CLI/测试用；生产前端用轮询，避免长连接）。 */
  app.post("/:env/bootstrap/wait", async (c) => {
    const projectId = owned(c);
    const env = c.req.param("env") ?? "";
    startBootstrap(bootstrapDeps(projectId), projectId, env);
    const environment = await awaitBootstrap(bootstrapDeps(projectId), projectId, env);
    c.header("Cache-Control", "no-store");
    return c.json({ environment });
  });

  /**
   * 探索轮次：列表 + 最近一轮。探索是 append-only 的轮次账目，不覆盖历史——
   * 失败轮也要看得见，否则「第 2 轮失败」会被误读成「从来没探过」。
   */
  app.get("/:env/explorations", async (c) => {
    const projectId = scoped(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    c.header("Cache-Control", "no-store");
    return c.json({
      explorations: listExplorations(deps.db, projectId, env),
      latest: latestExploration(deps.db, projectId, env),
    });
  });

  /** 派发一轮探索：立即 202，前端轮询 GET /:env/explorations 看进度。 */
  app.post("/:env/explore", async (c) => {
    const projectId = owned(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    const body = await readJson(c);
    const exploration = startExploration(explorationDeps(projectId), projectId, env, {
      targetUrl: body.targetUrl,
      loginUrl: body.loginUrl,
      username: body.username,
      password: body.password,
      loginConfig: body.loginConfig,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ exploration }, 202);
  });

  /** 人工验证码答案：只在 waiting_human 的那一轮可用。 */
  app.post("/:env/explore/:explorationId/answer", async (c) => {
    const projectId = owned(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    const body = await readJson(c);
    const exploration = await answerCaptcha(
      explorationDeps(projectId),
      projectId,
      env,
      c.req.param("explorationId") ?? "",
      body.answer,
    );
    c.header("Cache-Control", "no-store");
    return c.json({ exploration });
  });

  /** 中止：封存已采部分，round 号照样占着。 */
  app.post("/:env/explore/:explorationId/abort", async (c) => {
    const projectId = owned(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    const exploration = abortExploration(
      explorationDeps(projectId),
      projectId,
      env,
      c.req.param("explorationId") ?? "",
    );
    c.header("Cache-Control", "no-store");
    return c.json({ exploration });
  });

  /** 验证码截图：只在等待人工时取得到；不缓存、不落证据清单。 */
  app.get("/:env/explore/:explorationId/captcha", async (c) => {
    const projectId = scoped(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    const file = captchaImagePath(explorationDeps(projectId), projectId, env, c.req.param("explorationId") ?? "");
    if (!file) throw new HttpError(404, "captcha_not_pending", "当前没有等待填答的验证码");
    const image = await readFile(file);
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "image/png");
    return c.body(new Uint8Array(image));
  });

  /** 环境存在性校验：所有探索资产都挂在环境上，环境不在就没有地方写。 */
  const requireEnv = (projectId: string, env: string) => {
    if (!findEnvironment(deps.db, projectId, env)) {
      throw new HttpError(404, "environment_not_found", "环境不存在");
    }
    return env;
  };

  /**
   * 一次拿全环境档案页要的东西：地图四层 + 假设计数。
   * 分开请求会让首屏出现"地图有了、计数还是 0"的错帧。
   */
  app.get("/:env/knowledge", async (c) => {
    const projectId = scoped(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    c.header("Cache-Control", "no-store");
    return c.json({
      knowledge: listKnowledge(deps.db, projectId, env),
      hypotheses: summarizeHypotheses(deps.db, projectId, env),
    });
  });

  /** 用一轮探索结果覆盖某一层。覆盖不是合并：不再出现的条目说明它已不成立。 */
  app.put("/:env/knowledge/:layer", async (c) => {
    const projectId = owned(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    const layer = c.req.param("layer") ?? "";
    if (!(KNOWLEDGE_LAYERS as readonly string[]).includes(layer)) {
      throw new HttpError(400, "invalid_knowledge_layer", `未知的知识层：${layer}`);
    }
    const body = await readJson(c);
    const knowledge = replaceKnowledgeLayer(
      deps.db,
      projectId,
      env,
      layer as KnowledgeLayer,
      Array.isArray(body.entries) ? (body.entries as KnowledgeEntryInput[]) : [],
      { round: body.round, sessionId: typeof body.sessionId === "string" ? body.sessionId : null },
    );
    c.header("Cache-Control", "no-store");
    return c.json({ knowledge });
  });

  app.get("/:env/hypotheses", async (c) => {
    const projectId = scoped(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    const status = c.req.query("status");
    if (status && !(HYPOTHESIS_STATUSES as readonly string[]).includes(status)) {
      throw new HttpError(400, "invalid_hypothesis_status", `未知的假设状态：${status}`);
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      hypotheses: listHypotheses(deps.db, projectId, env, status as HypothesisStatus | undefined),
      summary: summarizeHypotheses(deps.db, projectId, env),
    });
  });

  /** 人提交待验证假设。不写地图：验证通过后由探索程序写回。 */
  app.post("/:env/hypotheses", async (c) => {
    const projectId = owned(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    const body = await readJson(c);
    const hypothesis = createHypothesis(deps.db, projectId, env, body, c.var.user.userId);
    c.header("Cache-Control", "no-store");
    return c.json({ hypothesis }, 201);
  });

  /** 追加判定：append-only，不覆盖旧结论。 */
  app.post("/:env/hypotheses/:hypothesisId/verdicts", async (c) => {
    const projectId = owned(c);
    const env = requireEnv(projectId, c.req.param("env") ?? "");
    const body = await readJson(c);
    const hypothesis = appendVerdict(
      deps.db,
      projectId,
      env,
      c.req.param("hypothesisId") ?? "",
      body,
    );
    c.header("Cache-Control", "no-store");
    return c.json({ hypothesis }, 201);
  });

  return app;
}
