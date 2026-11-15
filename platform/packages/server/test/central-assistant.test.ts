import { afterEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { createAgent } from "@prismshadow/penguin-core";
import { createTestApp, provisionUser } from "./helpers.js";
import { CentralAssistant } from "../src/http/central-assistant.js";
import { AuthState } from "../src/hmr/capabilities.js";

describe("central administrator assistant capabilities", () => {
  const previous = process.env.AITEST_ACCOUNT_CENTER;
  afterEach(() => {
    if (previous === undefined) delete process.env.AITEST_ACCOUNT_CENTER;
    else process.env.AITEST_ACCOUNT_CENTER = previous;
  });

  it("executes skill lifecycle and permissions through central APIs, with ordinary-user isolation", async () => {
    process.env.AITEST_ACCOUNT_CENTER = "1";
    const test = await createTestApp();
    try {
      const token = test.boot.tree.api<AuthState>("RuntimeModule", "AuthState").apiToken!;
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const endpoint = "/api/control/admin/assistant/mcp";
      const call = async (name: string, args: object = {}, auth = headers) => {
        const response = await test.app.request(endpoint, { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        expect(response.status).toBe(200);
        return (await response.json() as { result: { isError: boolean; content: { text: string }[] } }).result;
      };
      const created = await call("skill_create", { body: { name: "assistant-test", description: "中央技能", content: "原始正文" } });
      expect(created.isError).toBe(false);
      const skill = JSON.parse(created.content[0]!.text);
      const updated = await call("skill_update", { id: skill.id, body: { description: "更新技能", content: "中央最新正文", revision: skill.revision } });
      expect(updated.isError).toBe(false);
      expect((await call("skill_update", { id: skill.id, body: { description: "过期写入", content: "错误正文", revision: skill.revision } })).isError).toBe(true);
      expect((await call("skill_category_assign", { body: { skillName: "assistant-test", categoryId: "api" } })).isError).toBe(false);
      const ordinary = await provisionUser(test.app, "assistant_reader");
      const catalog = await test.app.request("/api/control/skills/catalog", { headers: { cookie: ordinary.cookie } });
      expect(await catalog.json()).toMatchObject({ skills: [expect.objectContaining({ id: skill.id, content: expect.stringContaining("中央最新正文"), categoryId: "api" })] });
      expect((await test.app.request(endpoint, { method: "POST", headers: { cookie: ordinary.cookie, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) })).status).toBe(403);
      expect((await test.app.request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      expect((await call("permissions_set", { id: "assistant_reader", body: { modules: ["skills", "models"] } })).isError).toBe(false);
      const permissions = await test.app.request("/api/control/admin/permissions/assistant_reader", { headers });
      expect(await permissions.json()).toMatchObject({ modules: expect.arrayContaining(["skills", "models"]) });
      expect((await call("skill_delete", { id: skill.id })).isError).toBe(false);
      expect(await (await test.app.request("/api/control/skills/catalog", { headers: { cookie: ordinary.cookie } })).json()).toMatchObject({ skills: [] });
      expect((await call("skill_delete", { id: "../../api/admin/users/admin" })).isError).toBe(true);
      expect((await call("local_command", { command: "penguin agent list" })).isError).toBe(true);
      expect((await call("skills_list", { url: "http://localhost:59764" })).isError).toBe(true);
      expect(Number(test.deps.db.prepare("SELECT COUNT(*) AS n FROM public_admin_audit WHERE actor='admin'").get()?.n)).toBeGreaterThan(0);
    } finally { await test.cleanup(); }
  });

  it("discovers actual runtime MCP tools without local tools or credentials in prompts", async () => {
    process.env.AITEST_ACCOUNT_CENTER = "1";
    const test = await createTestApp();
    const server = serve({ fetch: test.app.fetch, hostname: "localhost", port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const state = test.boot.tree.api<AuthState>("RuntimeModule", "AuthState");
    const assistant = new CentralAssistant(`http://localhost:${port}`, () => state.apiToken);
    const definition = assistant.definition({ projectId: "admin_agent_catalog", agentId: "default_agent", sessionId: "test" })!;
    try {
      expect(assistant.definition({ projectId: "default_project", agentId: "default_agent", sessionId: "test" })).toBeNull();
      expect(definition.builtinTools).toEqual([]);
      expect(definition.prompt).not.toContain(state.apiToken!);
      expect(definition.refreshPromptOnResume).toBe(true);
      const headers = { authorization: `Bearer ${state.apiToken}`, "content-type": "application/json" };
      expect((await test.app.request("/api/projects", { method: "POST", headers, body: JSON.stringify({ projectId: "admin_agent_catalog" }) })).status).toBe(201);
      expect((await test.app.request("/api/projects/admin_agent_catalog/models", { method: "PUT", headers, body: JSON.stringify({ defaultModel: { provider: "custom", modelId: "central-test" }, models: [{ provider: "custom", modelId: "central-test", clientType: "openai", apiKey: "fake-test-key" }] }) })).status).toBe(200);
      let currentPrompt = definition.prompt;
      const agent = await createAgent({ root: test.root, projectId: "admin_agent_catalog", agentId: "default_agent", assembly: { publishedDefinition: async context => ({ ...assistant.definition(context)!, prompt: currentPrompt }) } });
      const session = await agent.createSession();
      try {
        expect((session.metaMessage.payload as { system_prompt: string }).system_prompt).toContain("中央服务的技能");
        let discovered = false;
        // Stop at discovery, before requesting any model; this exercises the real Agent assembly.
        for await (const event of session.run([])) {
          const payload = event.payload as { type: string; tools?: { name: string }[] };
          if (payload.type === "tool_list_ready") {
            expect(payload.tools!.map(tool => tool.name)).toContain("mcp__central_admin__skill_create");
            expect(payload.tools!.map(tool => tool.name)).toContain("mcp__central_admin__permissions_set");
            expect(payload.tools!.every(tool => tool.name.startsWith("mcp__central_admin__"))).toBe(true);
            expect(session.toolPermission("mcp__central_admin__skills_list")).toBe("r");
            expect(session.toolPermission("mcp__central_admin__skill_update")).toBe("rw");
            discovered = true;
            break;
          }
        }
        expect(discovered).toBe(true);
      } finally { session.dispose(); }
      currentPrompt += "\n恢复会话必须读取当前中央管理能力。";
      const resumed = await agent.resumeSession({ sessionId: session.sessionId });
      try {
        expect((resumed.metaMessage.payload as { system_prompt: string }).system_prompt).toContain("恢复会话必须读取当前中央管理能力。");
      } finally { resumed.dispose(); }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await test.cleanup();
    }
  });
});
