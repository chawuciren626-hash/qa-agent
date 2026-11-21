import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, provisionUser } from "./helpers.js";

describe("central login and public configuration routes", () => {
  const previous = process.env.AITEST_ACCOUNT_CENTER;
  afterEach(() => {
    if (previous === undefined) delete process.env.AITEST_ACCOUNT_CENTER;
    else process.env.AITEST_ACCOUNT_CENTER = previous;
  });

  it("refuses local account fallback for a managed client without a server connection", async () => {
    const previousManaged = process.env.AITEST_MANAGED_RUNTIME;
    process.env.AITEST_MANAGED_RUNTIME = "1";
    delete process.env.AITEST_ACCOUNT_CENTER;
    let test: Awaited<ReturnType<typeof createTestApp>> | undefined;
    try {
      test = await createTestApp();
      expect(await (await test.app.request("/api/account-client/config")).json()).toMatchObject({enabled:false,required:true});
      expect((await test.app.request("/api/auth/claim?token=local")).headers.get("location")).toBe("/login");
      expect((await test.app.request("/api/auth/login", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({userId:"admin",password:test.adminPassword})})).status).toBe(503);
      expect((await test.app.request("/api/me")).status).toBe(503);
    } finally {
      await test?.cleanup();
      if (previousManaged === undefined) delete process.env.AITEST_MANAGED_RUNTIME;
      else process.env.AITEST_MANAGED_RUNTIME = previousManaged;
    }
  });

  it("allows ordinary client login but refuses the same account at the admin login endpoint", async () => {
    process.env.AITEST_ACCOUNT_CENTER = "1";
    const test = await createTestApp();
    try {
      await provisionUser(test.app, "client_user");
      const request = {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({userId:"client_user",password:"password-123"})};
      const client = await test.app.request("/api/auth/login", request);
      expect(client.status).toBe(200);
      expect(await client.json()).toMatchObject({user:{userId:"client_user",isAdmin:false}});
      const admin = await test.app.request("/api/auth/admin-login", request);
      expect(admin.status).toBe(403);
      expect(admin.headers.get("set-cookie")).toBeNull();
    } finally { await test.cleanup(); }
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
      const modelUpdate = { method: "PUT", headers: projectHeaders, body: JSON.stringify({ defaultModel: { provider: "custom", modelId: "central-test" }, models: [{ provider: "custom", modelId: "central-test", clientType: "openai", apiKey: "sk-central-test" }] }) };
      const redirect = await test.app.request(modelPath, modelUpdate);
      expect(redirect.status).toBe(307);
      expect(redirect.headers.get("location")).toBe("/api/control/admin/model-config/central-model-catalog");
      expect((await test.app.request(redirect.headers.get("location")!, modelUpdate)).status).toBe(200);
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
