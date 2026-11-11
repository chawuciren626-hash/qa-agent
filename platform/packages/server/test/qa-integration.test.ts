/** Run with AITEST_ENGINE_ROOT pointing to the checkout; no model requests or installed data. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { apiClient, createTestApp, provisionUser, loginAdmin } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import type { SessionCreateResponse } from "../src/api/types.js";
import type { Http } from "../src/http/app.js";

describe.skipIf(!process.env.AITEST_ENGINE_ROOT)("QA project integration", () => {
  let app: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let member: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  const project = "qa_owner-shared";
  const base = `/api/projects/${project}/agents/qa`;
  const dataEnvKeys = ["QA_APP_DATA_ROOT", "QA_WORKSPACE_ROOT"] as const;
  let previousDataEnv: (string | undefined)[] = [];
  beforeEach(async () => {
    previousDataEnv = dataEnvKeys.map((key) => process.env[key]);
    app = await createTestApp({
      beforeSeed: async (root) => {
        // Use the test's disposable root instead of the installation's fixed E: workspace.
        process.env.QA_APP_DATA_ROOT = path.join(root, "qa-data");
        process.env.QA_WORKSPACE_ROOT = path.join(root, "qa-workspaces");
      },
    });
    owner = apiClient(app.app, (await provisionUser(app.app, "qa_owner")).cookie);
    member = apiClient(app.app, (await provisionUser(app.app, "qa_member")).cookie);
    outsider = apiClient(app.app, (await provisionUser(app.app, "qa_outsider")).cookie);
    expect((await owner.post("/api/projects", { projectId: project })).status).toBe(201);
    expect(
      (await owner.post(`/api/projects/${project}/members`, { userId: "qa_member" })).status,
    ).toBe(201);
  });
  afterEach(async () => {
    await app?.cleanup();
    dataEnvKeys.forEach((key, index) => {
      const previous = previousDataEnv[index];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  });
  it("restricts initialization to owners, installs ten roles, and preserves existing edits on repeat", async () => {
    const admin = apiClient(app.app, (await loginAdmin(app.app)).cookie);
    expect((await outsider.get(base)).status).toBe(404);
    expect((await member.post(base + "/initialize", {})).status).toBe(403);
    expect((await admin.post(base + "/initialize", {})).status).toBe(403);
    expect(((await (await admin.get(base)).json()) as { canInitialize: boolean }).canInitialize).toBe(false);
    const result = await owner.post(base + "/initialize", {});
    expect(result.status, JSON.stringify(await result.clone().json())).toBe(200);
    expect(((await (await member.get(base)).json()) as { enabled: boolean }).enabled).toBe(true);
    const roles = ((await (await owner.get(base)).json()) as { roles: { id: string }[] }).roles;
    expect(roles).toHaveLength(10);
    const config = await app.deps.agentConfigService.getConfig(project, "test_agent");
    const dispatch = config.config.toolsBuiltin?.find((tool) => tool.name === "run_subagent");
    expect(dispatch?.parameters?.required).toContain("agent_id");
    for (const role of roles)
      expect(
        await fs.readFile(
          path.join(app.root, project, "agents", role.id, "agent_state/AGENTS.md"),
          "utf8",
        ),
      ).not.toBe("");
    const prompt = path.join(app.root, project, "agents/test_agent/agent_state/AGENTS.md");
    await fs.appendFile(prompt, "\nuser-owned-edit\n");
    expect(
      ((await (await owner.post(base + "/initialize", {})).json()) as { changed: boolean }).changed,
    ).toBe(false);
    expect(await fs.readFile(prompt, "utf8")).toContain("user-owned-edit");
  });
  it("refuses colliding roles without modifying their prompt", async () => {
    // Simulate a pre-migration project with roles but no adoption marker.
    await fs.unlink(path.join(app.root, project, "qa-project.json"));
    const prompt = path.join(app.root, project, "agents/test_agent/agent_state/AGENTS.md");
    const before = await fs.readFile(prompt, "utf8");
    expect((await owner.post(base + "/initialize", {})).status).toBe(409);
    expect(await fs.readFile(prompt, "utf8")).toBe(before);
  });
  it("creates testing projects ready to use, with empty task data and project-scoped access", async () => {
    const agents = await (await owner.get(`/api/projects/${project}/agents`)).json() as {agents:{agentId:string}[]};
    expect(agents.agents.map(agent => agent.agentId)).toContain("test_agent");
    expect(agents.agents.map(agent => agent.agentId)).not.toContain("default_agent");
    await expect(fs.access(path.join(app.root, project, "agents/default_agent"))).rejects.toThrow();
    const initial = await (await owner.get("/api/projects")).json() as {projects:{projectId:string}[]};
    const ownDefault = initial.projects.find(item => item.projectId === "qa_owner-default_project")?.projectId;
    expect(ownDefault).toBe("qa_owner-default_project");
    const initialAgents = await (await owner.get(`/api/projects/${ownDefault}/agents`)).json() as {agents:{agentId:string}[]};
    expect(initialAgents.agents.map(agent => agent.agentId)).not.toContain("default_agent");
    const admin = apiClient(app.app, (await loginAdmin(app.app)).cookie);
    const adminAgents = await (await admin.get("/api/projects/default_project/agents")).json() as {agents:{agentId:string}[]};
    expect(adminAgents.agents.map(agent => agent.agentId)).toContain("default_agent");
    expect((await admin.post("/api/projects", {projectId: "admin_agent_catalog"})).status).toBe(201);
    const catalogAgents = await (await admin.get("/api/projects/admin_agent_catalog/agents")).json() as {agents:{agentId:string}[]};
    expect(catalogAgents.agents.map(agent => agent.agentId)).toContain("default_agent");
    const status = await (await owner.get(base)).json() as {enabled: boolean};
    expect(status.enabled).toBe(true);
    const overview = await owner.get(base + "/overview");
    expect(overview.status).toBe(200);
    expect(await overview.json()).toEqual({projectId: project, tasks: []});
    expect((await outsider.get(base + "/overview")).status).toBe(404);
    expect((await member.get(base + "/overview")).status).toBe(200);
    expect((await admin.get(base + "/overview")).status).toBe(200);
    expect((await owner.post(`/api/projects/${project}/agents`, {agentId: "custom"})).status).toBe(403);
    expect((await owner.get(`/api/projects/${project}/usage`)).status).toBe(403);
    expect((await owner.get(`/api/projects/${project}/machines`)).status).toBe(403);
    expect((await member.post(`/api/projects/${project}/agents/test_agent/skills/archive`, {})).status).toBe(403);
  });
  it("keeps personal library records separated by account and project and rejects stale revisions", async () => {
    const library = `/api/projects/${project}/agents/test_agent/memory/library`;
    const created = await owner.post(library, { name: "需求.md", kind: "file", content: "合成需求", encoding: "utf8" });
    expect(created.status).toBe(201);
    const record = await created.json() as { id: string; revision: string };
    expect((await outsider.get(library)).status).toBe(404);
    expect((await member.get(`${library}/${record.id}`)).status).toBe(404);
    expect((await (await member.get(library)).json() as { entries: unknown[] }).entries).toHaveLength(0);
    expect((await owner.put(`${library}/${record.id}`, { name: "需求.md", content: "修改", revision: "stale" })).status).toBe(409);
    const changed = await owner.put(`${library}/${record.id}`, { name: "需求.md", content: "修改", revision: record.revision });
    expect(changed.status).toBe(200);
    expect((await (await owner.get(`${library}/${record.id}`)).json() as { content: string }).content).toBe("修改");
    const other = "qa_owner-second";
    expect((await owner.post("/api/projects", {projectId: other})).status).toBe(201);
    expect((await owner.get(`/api/projects/${other}/agents/test_agent/memory/library/${record.id}`)).status).toBe(404);
  });
  it("session extensions enforce session ownership and reject native open on Web", async () => {
    const model = {
      provider: "custom",
      modelId: "qa-session-test",
      clientType: "openai",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
    };
    const configured = await owner.put(`/api/projects/${project}/models`, {
      defaultModel: { provider: model.provider, modelId: model.modelId },
      models: [model],
    });
    expect(configured.status, JSON.stringify(await configured.clone().json())).toBe(200);
    const result = await owner.post(`/api/projects/${project}/agents/test_agent/sessions`, {});
    expect(result.status, JSON.stringify(await result.clone().json())).toBe(201);
    const { session } = (await result.json()) as SessionCreateResponse;
    const prefix = `/api/sessions/${session.sessionId}`;
    expect((await owner.get(prefix)).status).toBe(200);
    expect((await owner.get(prefix + "/human-actions")).status).toBe(200);
    expect((await owner.get(prefix + "/files/evidence?path=../../credentials.json")).status).toBe(
      400,
    );
    expect((await owner.post(prefix + "/files/open-deliverable?path=anything", {})).status).toBe(
      403,
    );
    expect((await owner.post(prefix + "/human-actions", { decision: "invented" })).status).toBe(
      400,
    );
    expect((await outsider.get(prefix + "/human-actions")).status).toBe(404);
    expect((await member.get(prefix + "/human-actions")).status).toBe(404);
    expect((await outsider.get(prefix + "/files/evidence?path=anything")).status).toBe(404);
    expect((await member.get(prefix + "/files/evidence?path=anything")).status).toBe(404);
    expect((await member.post(prefix + "/files/open-deliverable?path=anything", {})).status).toBe(
      404,
    );
    expect((await member.post(prefix + "/human-actions", { decision: "continue" })).status).toBe(
      404,
    );
    const admin = apiClient(app.app, (await loginAdmin(app.app)).cookie);
    expect((await admin.get(prefix)).status).toBe(404);
    expect((await admin.patch(prefix, { title: "代改任务" })).status).toBe(404);
    expect((await admin.post("/api/me/archived-sessions/delete", { sessionIds: [session.sessionId] })).status).toBe(403);
    expect((await admin.post("/api/me/archived-sessions/unarchive", { sessionIds: [session.sessionId] })).status).toBe(403);
    expect((await admin.post("/api/me/archived-sessions/delete", { filter: { projectId: project } })).status).toBe(403);
    const files = `/api/projects/${project}/workspace-files/content?workspace=${encodeURIComponent(session.workspace)}&path=admin-probe.txt`;
    expect((await admin.put(files, { dataBase64: Buffer.from("probe").toString("base64") })).status).toBe(403);
    expect((await admin.post(`/api/projects/${project}/benchmarks/archive`, {})).status).toBe(403);
    expect((await owner.get(prefix)).status).toBe(200);
    const socket = app.boot.tree.api<Http>("HttpModule", "http");
    expect((await socket.fetchAs("admin", new Request(`http://localhost${prefix}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "代改任务" }) }))).status).toBe(404);
  });
  it("lets an administrator inspect agents but not create another user's task", async () => {
    const admin = apiClient(app.app, (await loginAdmin(app.app)).cookie);
    expect((await admin.get(`/api/projects/${project}/agents`)).status).toBe(200);
    expect((await admin.post(`/api/projects/${project}/agents/test_agent/sessions`, {})).status).toBe(403);
    const socket = app.boot.tree.api<Http>("HttpModule", "http");
    expect((await socket.fetchAs("admin", new Request(`http://localhost/api/projects/${project}/agents/test_agent/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(403);
  });
});
