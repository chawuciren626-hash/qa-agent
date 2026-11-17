/**
 * 环境路由：/api/projects/:projectId/environments
 *
 * 五个动作：列、建/改、看单个、触发建档、等建档。建档是后台任务（202 + 轮询），
 * 失败一律落在该环境的 status/lastError 上，不会伪造成功。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { projectDir } from "@prismshadow/penguin-core";
import type { AppEnv } from "../../auth/middleware.js";
import type { Db } from "../../hmr/capabilities.js";
import type { ProjectLifecycle } from "../../mechanisms/projects.js";
import {
  awaitBootstrap,
  defaultEnvironment,
  findEnvironment,
  listEnvironments,
  startBootstrap,
  upsertEnvironment,
} from "../../services/project-environment-service.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";

export interface ProjectEnvironmentDeps {
  db: Db;
  projectService: Pick<ProjectLifecycle, "requireProjectAccess" | "requireProjectOwner">;
  /** 数据根目录；项目目录 = root/<projectId>，maps 落在其 maps/<env>/ 下。 */
  root: string;
  /** 引擎仓库根；未配置时不伪造成功，直接 503。 */
  engineRoot?: string;
  /** 测试注入：替换子进程执行器。 */
  run?: Parameters<typeof startBootstrap>[0]["run"];
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

  return app;
}
