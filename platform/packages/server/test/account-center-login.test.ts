import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, provisionUser } from "./helpers.js";

describe("central login and public configuration routes", () => {
  const previous = process.env.AITEST_ACCOUNT_CENTER;
  afterEach(() => {
    if (previous === undefined) delete process.env.AITEST_ACCOUNT_CENTER;
    else process.env.AITEST_ACCOUNT_CENTER = previous;
  });

  it("keeps the central assistant on an administrator-owned project", async () => {
    process.env.AITEST_ACCOUNT_CENTER = "1";
    const test = await createTestApp();
    try {
      const config = await test.app.request("/api/account-client/config");
      expect(await config.json()).toMatchObject({ central: true });
      expect((await test.app.request("/api/control/access")).status).toBe(401);
      const login = await test.app.request("/api/auth/admin-login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "admin", password: test.adminPassword }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const access = await test.app.request("/api/control/access", { headers: { cookie: cookie! } });
      expect(access.status).toBe(200);
      expect(((await access.json()) as { modules: string[] }).modules).toContain("agents");
      expect((await test.app.request("/api/projects", { headers: { cookie: cookie! } })).status).toBe(200);
      const projectHeaders = { cookie: cookie!, "content-type": "application/json" };
      expect((await test.app.request("/api/projects", { method: "POST", headers: projectHeaders, body: JSON.stringify({ projectId: "other_project" }) })).status).toBe(403);
      expect((await test.app.request("/api/projects/default_project/agents", { headers: { cookie: cookie! } })).status).toBe(404);
      expect((await test.app.request("/api/projects", { method: "POST", headers: projectHeaders, body: JSON.stringify({ projectId: "admin_agent_catalog" }) })).status).toBe(201);
      const agents = await test.app.request("/api/projects/admin_agent_catalog/agents", { headers: { cookie: cookie! } });
      expect(agents.status).toBe(200);
      expect(((await agents.json()) as { agents: { agentId: string }[] }).agents.map(agent => agent.agentId)).toContain("default_agent");
      const modelPath = "/api/projects/admin_agent_catalog/models";
      expect((await test.app.request(modelPath, { method: "PUT", headers: projectHeaders, body: JSON.stringify({ defaultModel: { provider: "custom", modelId: "central-test" }, models: [{ provider: "custom", modelId: "central-test", clientType: "openai", apiKey: "sk-central-test" }] }) })).status).toBe(200);
      const createdSession = await test.app.request("/api/projects/admin_agent_catalog/agents/default_agent/sessions", { method: "POST", headers: projectHeaders, body: "{}" });
      expect(createdSession.status).toBe(201);
      const sessionId = ((await createdSession.json()) as { session: { sessionId: string } }).session.sessionId;
      expect((await test.app.request(`/api/sessions/${sessionId}/messages`, { headers: { cookie: cookie! } })).status).toBe(200);
      expect((await test.app.request("/api/projects/admin_agent_catalog/agents/default_agent/sessions", { headers: { cookie: cookie! } })).status).toBe(200);
      const ordinary = await provisionUser(test.app, "ordinary_user");
      expect((await test.app.request("/api/projects/admin_agent_catalog/agents/default_agent/sessions", { headers: { cookie: ordinary.cookie } })).status).toBe(403);
    } finally { await test.cleanup(); }
  });
});
