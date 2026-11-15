import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import type { Db } from "../../hmr/capabilities.js";
import type { ProjectLifecycle } from "../../mechanisms/projects.js";
import type { ProjectRuns } from "../../services/project-service.js";
import { readTaskRuns } from "../../services/qa-project-overview.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";

interface ManagedDeps {
  db: Db;
  projectService: ProjectLifecycle;
  runs: ProjectRuns;
}

type Summary = Awaited<ReturnType<ProjectLifecycle["listProjects"]>>[number];
type Metadata = Record<string, unknown>;

function metadata(db: Db, projectId: string): Metadata {
  return (db.prepare("SELECT * FROM project_management WHERE project_id=?").get(projectId) ?? {}) as Metadata;
}

function projectView(deps: ManagedDeps, userId: string, summary: Summary) {
  const id = summary.projectId;
  const meta = metadata(deps.db, id);
  const pref = (deps.db.prepare("SELECT is_pinned, last_visited_at FROM project_management_prefs WHERE user_id=? AND project_id=?").get(userId, id) ?? {}) as Metadata;
  const owner = deps.db.prepare("SELECT COALESCE(display_name,user_id) AS name FROM users WHERE user_id=?").get(summary.ownerUserId) as { name?: string } | undefined;
  const activity = deps.db.prepare("SELECT MAX(last_active_at) AS at FROM sessions WHERE project_id=?").get(id) as { at: string | null };
  const exchange = deps.db.prepare("SELECT status, COUNT(*) AS n FROM exchange_tasks WHERE project_ref=? AND status IN ('queued','claimed','running') GROUP BY status").all(id) as { status: string; n: number }[];
  const unattended = deps.db.prepare("SELECT status, COUNT(*) AS n FROM unattended_runs WHERE project_id=? AND status IN ('queued','claimed','running','needs_approval') GROUP BY status").all(id) as { status: string; n: number }[];
  const runningTaskCount = deps.runs.activeCount(id) + [...exchange, ...unattended].filter(r => r.status === "running").reduce((n, r) => n + r.n, 0);
  const queuedTaskCount = [...exchange, ...unattended].filter(r => r.status !== "running").reduce((n, r) => n + r.n, 0);
  const sourceType = meta.source_type === "sync" ? "sync" : "manual";
  const status = meta.status === "archived" || meta.status === "disabled" ? meta.status : "active";
  const ownerRole = summary.role === "owner";
  return {
    projectId: id,
    name: summary.name ?? id,
    description: (meta.description as string | null) ?? null,
    sourceType,
    sourceSystemName: (meta.source_system_name as string | null) ?? null,
    externalProjectId: (meta.external_project_id as string | null) ?? null,
    externalUrl: (meta.external_url as string | null) ?? null,
    status,
    purpose: meta.purpose === "business" || meta.purpose === "internal" ? meta.purpose : null,
    myRole: ownerRole ? "创建者" : "成员",
    createdByDisplayName: owner?.name ?? summary.ownerUserId,
    createdAt: summary.createdAt,
    lastActivityAt: activity.at ?? null,
    lastSyncedAt: (meta.last_synced_at as string | null) ?? null,
    runningTaskCount,
    queuedTaskCount,
    isPinned: pref.is_pinned === 1,
    lastVisitedAt: (pref.last_visited_at as string | null) ?? null,
    revision: Number(meta.revision ?? 1),
    capabilities: {
      canEnter: status === "active",
      cannotEnterReason: status === "archived" ? "项目已归档" : status === "disabled" ? "项目已停用" : null,
      canMaintain: ownerRole && sourceType === "manual" && status === "active",
      canManageMembers: ownerRole && status === "active",
      canArchive: ownerRole && sourceType === "manual" && status === "active",
      canRestore: ownerRole && sourceType === "manual" && status === "archived",
      canPin: true,
    },
  };
}

function stringField(value: unknown, label: string, max: number, required: boolean): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_project", `${label}格式无效`);
  const result = value.trim();
  if ((required && !result) || result.length > max) throw new HttpError(400, "invalid_project", `${label}长度无效`);
  return result;
}

export function managedProjectsRoutes(deps: ManagedDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const withRunCount = async (project: ReturnType<typeof projectView>) => {
    const sessions = deps.db.prepare("SELECT session_id, workspace FROM sessions WHERE project_id=?").all(project.projectId) as { session_id: string; workspace: string }[];
    const results = await Promise.all(sessions.map(session => readTaskRuns(session.workspace, session.session_id)));
    const manifestCount = results.reduce((count, result) => count + result.runs.filter(run => run.status === "in_progress").length, 0);
    return { ...project, runningTaskCount: Math.max(project.runningTaskCount, manifestCount) };
  };
  const visible = async (userId: string, id: string) => {
    deps.projectService.requireProjectAccess(userId, id);
    const summary = (await deps.projectService.listProjects(userId)).find(p => p.projectId === id);
    if (!summary) throw new HttpError(404, "project_not_found", "项目不存在或没有访问权限");
    return projectView(deps, userId, summary);
  };
  const owner = async (userId: string, id: string) => {
    deps.projectService.requireProjectOwner(userId, id);
    const project = await visible(userId, id);
    if (project.sourceType !== "manual") throw new HttpError(403, "sync_project_readonly", "同步项目由来源平台维护");
    return project;
  };

  app.get("/", async c => {
    const userId = c.var.user.userId;
    const params = c.req.query();
    const page = Number(params.page ?? 1);
    const pageSize = Number(params.pageSize ?? 20);
    if (!Number.isInteger(page) || page < 1 || ![20, 50, 100].includes(pageSize)) throw new HttpError(400, "invalid_page", "分页参数无效");
    const sourceType = params.sourceType ?? "all";
    const status = params.status ?? "active";
    const sort = params.sort ?? "activity";
    if (!["all", "manual", "sync"].includes(sourceType) || !["all", "active", "archived", "disabled"].includes(status) || !["activity", "created", "name"].includes(sort)) throw new HttpError(400, "invalid_filter", "筛选参数无效");
    const keyword = (params.keyword ?? "").trim().toLocaleLowerCase();
    let projects = (await Promise.all((await deps.projectService.listProjects(userId)).map(async p => projectView(deps, userId, p))));
    projects = projects.filter(p => (sourceType === "all" || p.sourceType === sourceType) && (status === "all" || p.status === status) && (!keyword || p.name.toLocaleLowerCase().includes(keyword) || p.projectId.toLocaleLowerCase().includes(keyword) || p.externalProjectId?.toLocaleLowerCase().includes(keyword)));
    projects.sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || (sort === "name" ? a.name.localeCompare(b.name, "zh-Hans-CN") : sort === "created" ? b.createdAt.localeCompare(a.createdAt) : (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "")) || a.projectId.localeCompare(b.projectId));
    const pageProjects = await Promise.all(projects.slice((page - 1) * pageSize, page * pageSize).map(withRunCount));
    c.header("Cache-Control", "no-store");
    return c.json({ total: projects.length, page, pageSize, projects: pageProjects, canCreate: true });
  });

  app.get("/quick-switch", async c => {
    const current = c.req.query("currentProjectId") ?? null;
    const userId = c.var.user.userId;
    const projects = (await deps.projectService.listProjects(userId)).map(p => projectView(deps, userId, p)).filter(p => p.status === "active");
    projects.sort((a, b) => Number(b.projectId === current) - Number(a.projectId === current) || Number(b.isPinned) - Number(a.isPinned) || (b.lastVisitedAt ?? "").localeCompare(a.lastVisitedAt ?? "") || a.projectId.localeCompare(b.projectId));
    return c.json({ projects: projects.slice(0, 8) });
  });

  app.post("/", async c => {
    const body = await readJson(c);
    const id = stringField(body.projectId, "Project id", 64, true);
    const name = stringField(body.name, "项目名称", 80, true);
    const description = body.description === undefined ? "" : stringField(body.description, "项目简介", 500, false);
    const user = c.var.user;
    let created: Summary;
    try { created = await deps.projectService.createProject(user, id, name); }
    catch (error) {
      if (error instanceof HttpError && error.code === "project_exists") throw new HttpError(409, "project_exists", "Project id 已存在，请更换");
      if (error instanceof HttpError && ["invalid_project_id", "project_id_prefix_required"].includes(error.code)) throw new HttpError(400, error.code, "Project id 格式不正确");
      throw error;
    }
    try {
      deps.db.prepare("INSERT INTO project_management (project_id,description,purpose) VALUES (?,?,?)").run(created.projectId, description || null, "business");
    } catch (error) {
      await deps.projectService.destroyProject(created.projectId);
      throw error;
    }
    return c.json({ project: projectView(deps, user.userId, created) }, 201);
  });

  app.get("/:projectId", async c => {
    const project = await withRunCount(await visible(c.var.user.userId, requireValidId(c, "projectId")));
    c.header("Cache-Control", "no-store");
    return c.json({ project });
  });

  app.patch("/:projectId", async c => {
    const id = requireValidId(c, "projectId");
    const body = await readJson(c);
    const current = await owner(c.var.user.userId, id);
    if (current.status !== "active") throw new HttpError(409, "project_inactive", "项目当前不可编辑");
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision !== current.revision) throw new HttpError(409, "revision_conflict", "项目已被更新，请刷新后重试");
    const name = body.name === undefined ? current.name : stringField(body.name, "项目名称", 80, true);
    const description = body.description === undefined ? current.description : stringField(body.description, "项目简介", 500, false);
    deps.db.prepare("INSERT OR IGNORE INTO project_management (project_id) VALUES (?)").run(id);
    const changed = deps.db.prepare("UPDATE project_management SET description=?,revision=revision+1 WHERE project_id=? AND revision=?").run(description || null, id, current.revision);
    if (!changed.changes) throw new HttpError(409, "revision_conflict", "项目已被更新，请刷新后重试");
    try { if (name !== current.name) await deps.projectService.renameProject(c.var.user.userId, id, name); }
    catch (error) { deps.db.prepare("UPDATE project_management SET description=?,revision=? WHERE project_id=? AND revision=?").run(current.description, current.revision, id, current.revision + 1); throw error; }
    return c.json({ project: await visible(c.var.user.userId, id) });
  });

  app.put("/:projectId/pin", async c => {
    const id = requireValidId(c, "projectId");
    await visible(c.var.user.userId, id);
    const body = await readJson(c);
    if (typeof body.pinned !== "boolean") throw new HttpError(400, "invalid_pin", "置顶状态无效");
    deps.db.prepare("INSERT INTO project_management_prefs (user_id,project_id,is_pinned) VALUES (?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET is_pinned=excluded.is_pinned").run(c.var.user.userId, id, body.pinned ? 1 : 0);
    return c.json({ project: await visible(c.var.user.userId, id) });
  });

  app.post("/:projectId/enter", async c => {
    const id = requireValidId(c, "projectId");
    const project = await visible(c.var.user.userId, id);
    if (!project.capabilities.canEnter) throw new HttpError(409, "project_inactive", project.capabilities.cannotEnterReason ?? "当前不可进入该项目");
    deps.db.prepare("INSERT INTO project_management_prefs (user_id,project_id,last_visited_at) VALUES (?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET last_visited_at=excluded.last_visited_at").run(c.var.user.userId, id, new Date().toISOString());
    return c.json({ ok: true });
  });

  app.post("/:projectId/archive", async c => {
    const id = requireValidId(c, "projectId");
    const project = await owner(c.var.user.userId, id);
    if (project.status !== "active") throw new HttpError(409, "project_inactive", "项目当前不可归档");
    if (project.runningTaskCount > 0 || project.queuedTaskCount > 0) throw new HttpError(409, "project_tasks_active", "该项目存在运行中或排队中的任务，请先处理后再归档");
    deps.db.prepare("INSERT OR IGNORE INTO project_management (project_id) VALUES (?)").run(id);
    deps.db.prepare("UPDATE project_management SET status='archived',revision=revision+1 WHERE project_id=? AND status='active'").run(id);
    return c.json({ project: await visible(c.var.user.userId, id) });
  });

  app.post("/:projectId/restore", async c => {
    const id = requireValidId(c, "projectId");
    const project = await owner(c.var.user.userId, id);
    if (project.status !== "archived") throw new HttpError(409, "project_not_archived", "项目未归档");
    deps.db.prepare("UPDATE project_management SET status='active',revision=revision+1 WHERE project_id=? AND status='archived'").run(id);
    return c.json({ project: await visible(c.var.user.userId, id) });
  });
  return app;
}
