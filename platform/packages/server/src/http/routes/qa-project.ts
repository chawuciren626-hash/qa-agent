/** Project owners opt in to the bundled testing roles; members may inspect and use them. */
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import type { AgentsRouteDeps } from "./agents.js";
import { qaEnabled, qaEngineModule } from "../../services/qa-engine.js";
import { requireValidId } from "../validate.js";
import { HttpError } from "../errors.js";
import { readTaskRuns } from "../../services/qa-project-overview.js";
import { registerQaPersonalResources } from "./qa-personal-resources.js";

const initializing = new Set<string>();
export function registerQaProjectRoutes(app: Hono<AppEnv>, deps: AgentsRouteDeps): void {
  if (!qaEnabled || !deps.config) return;
  registerQaPersonalResources(app, deps);
  const root = deps.config.root;
  app.get("/qa/overview", async (c) => {
    const id = requireValidId(c, "projectId");
    deps.access.requireProjectAccess(c.var.user.userId, id);
    const tasks = [];
    for (const agent of await deps.agentService.listAgents(id)) {
      const listed = await deps.sessionService.listSessions(id, agent.agentId, { excludeOrg: true });
      for (const session of listed.sessions) {
        if (session.source === "subagent" || session.source === "company") continue;
        tasks.push({ session, ...await readTaskRuns(session.workspace, session.sessionId) });
      }
    }
    c.header("Cache-Control", "no-store");
    return c.json({ projectId: id, tasks });
  });
  const engine = qaEngineModule("qa-project-bootstrap");
  const roles: { id: string; skills: string[] }[] = engine.qaRoles();
  const markerPath = (id: string) => path.join(root, id, "qa-project.json");
  const readMarker = async (id: string) => {
    try {
      return JSON.parse(await fs.readFile(markerPath(id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  app.get("/qa", async (c) => {
    const id = requireValidId(c, "projectId");
    const access = deps.access.requireProjectAccess(c.var.user.userId, id);
    const marker = await readMarker(id);
    return c.json({
      enabled: marker?.status === "ready",
      status: marker?.status ?? "not_initialized",
      canInitialize: access.role === "owner",
      roles,
    });
  });
  app.post("/qa/initialize", async (c) => {
    const id = requireValidId(c, "projectId");
    deps.access.requireProjectOwner(c.var.user.userId, id);
    const key = markerPath(id);
    if (initializing.has(key))
      throw new HttpError(409, "qa_initializing", "项目测试能力正在初始化，请稍后刷新。");
    initializing.add(key);
    try {
      const marker = await readMarker(id);
      if (marker?.status === "ready") return c.json({ enabled: true, changed: false });
      const existing = new Set(
        (await deps.agentService.listAgents(id)).map((role) => role.agentId),
      );
      if (!marker && roles.some((role) => existing.has(role.id)))
        throw new HttpError(
          409,
          "qa_role_conflict",
          "项目已存在同名角色，需检查迁移后再启用；未覆盖现有配置。",
        );
      if (roles.some((role) => deps.manager.activeCountForAgent(id, role.id) > 0))
        throw new HttpError(409, "qa_project_busy", "测试角色有活动会话，暂不能初始化。");
      const writeMarker = async (status: string) => {
        const temp = key + ".tmp";
        await fs.writeFile(temp, JSON.stringify({ version: 1, status, projectId: id }, null, 2));
        await fs.rename(temp, key);
      };
      if (!marker) await writeMarker("initializing");
      for (const role of roles)
        if (!existing.has(role.id)) await deps.agentService.createAgent(id, role.id);
      engine.initializeQaRoles(path.join(root, id, "agents"));
      for (const role of roles) {
        const before = await deps.agentConfigService.getConfig(id, role.id);
        if (deps.manager.activeCountForAgent(id, role.id) > 0)
          throw new HttpError(409, "qa_project_busy", "测试角色有活动会话，暂不能修改工具接口。");
        await deps.agentConfigService.updateConfig(id, role.id, {
          config: { toolsBuiltin: await engine.qaRoleTools(role.id, before.config.toolsBuiltin) },
        });
      }
      await writeMarker("ready");
      return c.json({ enabled: true, changed: true });
    } finally {
      initializing.delete(key);
    }
  });
}
