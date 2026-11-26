/**
 * Project routes: GET|POST /api/projects, PATCH|DELETE /api/projects/:p.
 */
import type { UtilityCompletion, ProjectConfigStore } from "../../mechanisms/projects.js";
import { Hono } from "hono";
import type {
  ProjectCreateResponse,
  ProjectUpdateResponse,
  ProjectSummary,
  ProjectsResponse,
} from "../../api/types.js";
import type { AppEnv } from "../../auth/middleware.js";
import {
  badRequest,
  optionalString,
  readJson,
  requireString,
  requireValidId,
} from "../validate.js";
import { Bind, Component, Use } from "@prismshadow/penguin-core/kernel";
import type { AuthState, Desktop, Paths } from "../../hmr/capabilities.js";
import type { DesktopService } from "../../services/desktop-service.js";
import { membersRoutes } from "./members.js";
import type { ProjectLifecycle } from "../../mechanisms/projects.js";
import type { Machines } from "../../machines/service.js";
import type { Db } from "../../hmr/capabilities.js";
import { userAssistantProjectId, type ProjectRuns } from "../../services/project-service.js";
import { qaEnabled } from "../../services/qa-engine.js";
import { managedProjectsRoutes } from "./managed-projects.js";
import { projectEnvironmentsRoutes } from "./project-environments.js";
import type { LocalExecutionRuntime } from "../../services/local-execution-runtime.js";

/** What this route group reaches — bound by its module (src/modules). */
export interface ProjectsRouteDeps {
  projectService: ProjectLifecycle;
  db?: Db;
  runs?: ProjectRuns;
  /** 数据根目录：环境建档把 maps 落在 <root>/<projectId>/maps/<env>/。 */
  root?: string;
  /** The machines this Project uses carry its name too (machines/service.ts). */
  machines: Pick<Machines, "syncConfigEverywhere">;
  /** 项目默认模型的一次性补全（探索后 LLM 知识分析走它）；unset 时摘要如实说明未配置。 */
  completeOnce?: (projectId: string, prompt: string, opts?: { maxTokens?: number; requestTimeoutMs?: number }) => Promise<UtilityCompletion>;
  /** 一次性视觉补全（探索验证码自动识别走项目 vision_model）；unset 时退回人工。 */
  completeVision?: (projectId: string, prompt: string, imageDataUrl: string, opts?: { maxTokens?: number; requestTimeoutMs?: number }) => Promise<UtilityCompletion>;
  localExecution?: LocalExecutionRuntime | (() => LocalExecutionRuntime | undefined);
}

export function projectsRoutes(deps: ProjectsRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (deps.db && deps.runs) app.route("/managed", managedProjectsRoutes({ db: deps.db, projectService: deps.projectService, runs: deps.runs }));
  if (deps.db && deps.root) {
    app.route("/:projectId/environments", projectEnvironmentsRoutes({
      db: deps.db,
      projectService: deps.projectService,
      root: deps.root,
      engineRoot: process.env.AITEST_ENGINE_ROOT,
      completeOnce: deps.completeOnce,
      completeVision: deps.completeVision,
      localExecution: deps.localExecution,
    }));
  }

  app.get("/", async (c) => {
    const user = c.var.user;
    let assistantProject: ProjectSummary | undefined;
    if (qaEnabled && deps.db) {
      const id = userAssistantProjectId(user.userId);
      const existing = deps.db.prepare("SELECT purpose FROM project_management WHERE project_id=?").get(id) as { purpose: string | null } | undefined;
      if (!existing) {
        try {
          await deps.projectService.createProject(user, id, "测试助手");
        } catch (error) {
          // Concurrent first reads may both try to provision the same runtime.
          if (!(error instanceof Error && "code" in error && error.code === "project_exists")) throw error;
        }
        deps.db.prepare("INSERT OR IGNORE INTO project_management (project_id,purpose) VALUES (?,?)").run(id, "internal");
      } else if (existing.purpose !== "internal") {
        throw new Error(`Assistant runtime id is already used by a business project: ${id}`);
      }
      assistantProject = (await deps.projectService.listProjects(user.userId)).find((p) => p.projectId === id);
    }
    const projects = (await deps.projectService.listProjects(user.userId)).filter((p) => {
      if (!deps.db) return p.projectId !== assistantProject?.projectId;
      const meta = deps.db.prepare("SELECT purpose FROM project_management WHERE project_id=?").get(p.projectId) as { purpose: string | null } | undefined;
      return meta?.purpose !== "internal";
    });
    return c.json({ projects, ...(assistantProject ? { assistantProject } : {}) } satisfies ProjectsResponse);
  });

  app.post("/", async (c) => {
    const body = await readJson(c);
    const projectId = requireString(body, "projectId", { label: "projectId" });
    const name = optionalString(body, "name", { minLen: 1, maxLen: 100, label: "name" });
    const project = await deps.projectService.createProject(c.var.user, projectId, name);
    return c.json({ project } satisfies ProjectCreateResponse, 201);
  });

  /** Rename (owner): the display name only — the id names the directory and is immutable. */
  app.patch("/:projectId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    const body = await readJson(c);
    // Trimmed before the length check, so "   " is rejected rather than stored as a blank
    // display name (minLen alone counts the spaces). The web client trims too; this makes a
    // direct API call behave the same.
    const name = requireString(body, "name", { maxLen: 100, label: "name" }).trim();
    if (name === "") throw badRequest("name must be at least 1 characters.");
    const project = await deps.projectService.renameProject(c.var.user.userId, projectId, name);
    // Not awaited: the person renaming is not the one who should wait for a set of ssh tunnels.
    void deps.machines.syncConfigEverywhere(projectId);
    return c.json({ project } satisfies ProjectUpdateResponse);
  });

  app.delete("/:projectId", async (c) => {
    // Defensive id validation: deleteProject constructs the project directory path and recursively deletes it.
    await deps.projectService.deleteProject(c.var.user.userId, requireValidId(c, "projectId"));
    return c.body(null, 204);
  });

  return app;
}

@Component({
  contributes: {
    "HttpModule.routes": [
      {
        id: "project-admin.projects",
        prefix: "/api/projects",
        auth: "user",
        order: 80,
      },
      {
        id: "project-admin.members",
        prefix: "/api/projects/:projectId/members",
        auth: "user",
        order: 90,
      },
    ],
  },
})
export class ProjectAdminRoutes {
  @Use() private readonly projectService!: ProjectLifecycle;
  @Use() private readonly db!: Db;
  @Use() private readonly projectConfig!: ProjectConfigStore;
  @Use() private readonly runs!: ProjectRuns;
  @Use() private readonly desktop!: Desktop;
  @Use() private readonly machines!: Machines;
  @Use() private readonly paths!: Paths;
  @Use() private readonly authState!: AuthState;
  @Bind("project-admin.projects") projectsRoutes!: Hono<AppEnv>;
  @Bind("project-admin.members") membersRoutes!: Hono<AppEnv>;
  setup() {
    this.projectsRoutes = projectsRoutes({
      projectService: this.projectService,
      db: this.db,
      runs: this.runs,
      root: this.paths.root,
      machines: this.machines,
      completeOnce: (projectId, prompt, opts) => this.projectConfig.completeOnce(projectId, prompt, opts),
      completeVision: (projectId, prompt, imageDataUrl, opts) => this.projectConfig.completeVisionOnce(projectId, prompt, imageDataUrl, opts),
      localExecution: () => this.authState.localExecution,
    });
    this.membersRoutes = membersRoutes({
      projectService: this.projectService,
      desktop: this.desktop.current() as DesktopService | null,
    });
  }
}
