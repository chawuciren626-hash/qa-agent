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

it.skipIf(!process.env.AITEST_ENGINE_ROOT)("initializes a new user's default and two later projects with separate memories and shared references", async () => {
  const app = await createTestApp();
  const prior = process.env.AITEST_SHARED_AGENT_RUNTIME;
  try {
    const roles = (qaEngineModule("qa-project-bootstrap").qaRoles() as { id: string }[]).map(role => role.id);
    const authState = app.boot.tree.api<AuthState>("RuntimeModule", "AuthState");
    authState.accountClient = { listSharedRoleIds: async () => ["default_agent", ...roles] } as unknown as AuthState["accountClient"];
    process.env.AITEST_SHARED_AGENT_RUNTIME = "1";
    const userId = "shared_user";
    await app.deps.adminService.createUser(userId, "local-test-password");
    const owner = { userId, isAdmin: false } as Parameters<typeof app.deps.projectService.createProject>[0];
    for (const suffix of ["second", "third"]) {
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
