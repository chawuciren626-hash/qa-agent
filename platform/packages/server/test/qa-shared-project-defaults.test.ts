import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { provisionQaProject } from "../src/services/qa-project-defaults.js";
import { qaEngineModule } from "../src/services/qa-engine.js";
import { createTestApp } from "./helpers.js";
import type { AuthState } from "../src/hmr/capabilities.js";

it.skipIf(!process.env.AITEST_ENGINE_ROOT)("creates QA roles as references with separate empty memories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-shared-project-"));
  try {
    const roles = await provisionQaProject(root, "project_a", true);
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      const state = path.join(root, "project_a", "agents", role, "agent_state");
      expect(JSON.parse(await fs.readFile(path.join(state, "shared-agent.json"), "utf8"))).toEqual({ version: 1, agentId: role });
      await expect(fs.stat(path.join(state, "system_config.yaml"))).rejects.toThrow();
      await expect(fs.stat(path.join(state, "skills"))).rejects.toThrow();
      expect((await fs.stat(path.join(state, "memory", "user", "MEMORY.md"))).isFile()).toBe(true);
    }
    expect(JSON.parse(await fs.readFile(path.join(root, "project_a", "qa-project.json"), "utf8")).source).toBe("shared-agent-service");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.skipIf(!process.env.AITEST_ENGINE_ROOT)("initializes explicitly created Projects with separate memories and shared professional-role references", async () => {
  const app = await createTestApp();
  const prior = process.env.AITEST_SHARED_AGENT_RUNTIME;
  try {
    const roles = (qaEngineModule("qa-project-bootstrap").qaRoles() as { id: string }[]).map(role => role.id);
    const authState = app.boot.tree.api<AuthState>("RuntimeModule", "AuthState");
    authState.accountClient = { listSharedRoleIds: async () => roles } as unknown as AuthState["accountClient"];
    process.env.AITEST_SHARED_AGENT_RUNTIME = "1";
    const userId = "shared_user";
    await app.deps.adminService.createUser(userId, "local-test-password");
    const owner = { userId, isAdmin: false } as Parameters<typeof app.deps.projectService.createProject>[0];
    for (const suffix of ["default_project", "second", "third"]) {
      await app.deps.projectService.createProject(owner, `${userId}-${suffix}`);
    }
    for (const projectId of [`${userId}-default_project`, `${userId}-second`, `${userId}-third`]) {
      for (const role of roles) {
        const state = path.join(app.root, projectId, "agents", role, "agent_state");
        expect(JSON.parse(await fs.readFile(path.join(state, "shared-agent.json"), "utf8"))).toEqual({ version: 1, agentId: role });
        await expect(fs.stat(path.join(state, "AGENTS.md"))).rejects.toThrow();
        await expect(fs.stat(path.join(state, "skills"))).rejects.toThrow();
        expect((await fs.stat(path.join(state, "memory", "user", "MEMORY.md"))).isFile()).toBe(true);
      }
    }
    await app.deps.adminService.createUser("other_user", "local-test-password");
    await app.deps.projectService.createProject(
      { userId: "other_user", isAdmin: false } as Parameters<typeof app.deps.projectService.createProject>[0],
      "other_user-default_project",
    );
    const memory = (projectId: string) => path.join(app.root, projectId, "agents", "test_agent",
      "agent_state", "memory", "user", "MEMORY.md");
    await fs.writeFile(memory(`${userId}-default_project`), "private marker for the first project");
    for (const projectId of [`${userId}-second`, `${userId}-third`, "other_user-default_project"]) {
      expect(await fs.readFile(memory(projectId), "utf8")).not.toContain("private marker");
    }
  } finally {
    if (prior === undefined) delete process.env.AITEST_SHARED_AGENT_RUNTIME;
    else process.env.AITEST_SHARED_AGENT_RUNTIME = prior;
    await app.cleanup();
  }
});

it.skipIf(!process.env.AITEST_ENGINE_ROOT)("ordinary Projects do not require default_agent, while the administrator assistant catalog does", async () => {
  const app = await createTestApp();
  const prior = process.env.AITEST_SHARED_AGENT_RUNTIME;
  try {
    const roles = (qaEngineModule("qa-project-bootstrap").qaRoles() as { id: string }[]).map(role => role.id);
    const authState = app.boot.tree.api<AuthState>("RuntimeModule", "AuthState");
    authState.accountClient = { listSharedRoleIds: async () => roles } as unknown as AuthState["accountClient"];
    process.env.AITEST_SHARED_AGENT_RUNTIME = "1";
    await app.deps.adminService.createUser("role_boundary", "local-test-password");
    const owner = { userId: "role_boundary", isAdmin: false } as Parameters<typeof app.deps.projectService.createProject>[0];
    const project = await app.deps.projectService.createProject(owner, "role_boundary-ordinary");
    const agentDir = path.join(app.root, project.projectId, "agents");
    await expect(fs.stat(path.join(agentDir, "default_agent"))).rejects.toThrow();
    for (const role of roles) expect((await fs.stat(path.join(agentDir, role))).isDirectory()).toBe(true);

    const admin = { userId: "admin", isAdmin: true } as Parameters<typeof app.deps.projectService.createProject>[0];
    await expect(app.deps.projectService.createProject(admin, "admin_agent_catalog"))
      .rejects.toMatchObject({ code: "shared_roles_incomplete" });
  } finally {
    if (prior === undefined) delete process.env.AITEST_SHARED_AGENT_RUNTIME;
    else process.env.AITEST_SHARED_AGENT_RUNTIME = prior;
    await app.cleanup();
  }
});
