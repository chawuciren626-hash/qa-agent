import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { agentSkillsRoutes } from "../src/http/routes/skills.js";
import type { SkillsRouteDeps } from "../src/http/routes/skills.js";
import type { AppEnv } from "../src/auth/middleware.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it("lists published and declared local Skills, hides stale legacy Skills, and refuses local edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-skill-route-"));
  roots.push(root);
  const state = path.join(root, "project", "agents", "role", "agent_state");
  for (const name of ["local-skill", "stale-skill"]) {
    const directory = path.join(state, "skills", name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  }
  await fs.writeFile(path.join(state, "shared-agent.json"), JSON.stringify({ version: 1, agentId: "role", localSkillOverrides: ["local-skill"] }));
  const bundle = { resources: [{ kind: "agents", payload: { agentId: "role" } },
    { kind: "skills", name: "Central", description: "Central description", version: 3, payload: { skillName: "central-skill" } }] };
  const deps = { config: { root }, access: { requireProjectAccess: () => ({}) },
    agentConfigService: { requireExists: async () => {} },
    authState: { accountClient: { resolveRoleBundle: async () => bundle } } } as unknown as SkillsRouteDeps;
  const app = new Hono<AppEnv>();
  app.onError(error => new Response(error.message, { status: "status" in error && typeof error.status === "number" ? error.status : 500 }));
  app.use("*", async (c, next) => { c.set("user", { userId: "owner" } as AppEnv["Variables"]["user"]); await next(); });
  app.route("/api/projects/:projectId/agents/:agentId/skills", agentSkillsRoutes(deps));
  const base = "http://localhost/api/projects/project/agents/role/skills";
  const response = await app.request(base);
  expect(response.status).toBe(200);
  const body = await response.json() as { skills: { name: string }[] };
  expect(body.skills.map(skill => skill.name)).toEqual(["central-skill", "local-skill"]);
  expect((await app.request(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(409);
});
