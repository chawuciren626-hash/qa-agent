import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyPublicResource } from "../src/auth/public-resource-apply.js";
import type { PublicResource } from "../src/http/control-plane.js";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function model(): PublicResource {
  return { id: "11111111-1111-1111-1111-111111111111", kind: "models", name: "DeepSeek Flash",
    description: "Public preset", payload: { provider: "deepseek", modelId: "deepseek-flash",
      baseUrl: "https://central.example", contextWindow: 1000000, vision: true,
      pricing: { cacheRead: 0.1, cacheWrite: 0.2, output: 0.3 } },
    audience: ["*"], revision: 2, version: 1, published: true, updatedAt: new Date().toISOString() };
}

describe("apply centrally managed model", () => {
  it("keeps the upstream identity and local URL while adopting explicitly requested public metadata", async () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    const writes: any[] = [];
    const dispatch = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/projects") return Response.json({ projects: [{ projectId: "test" }] });
      if (path === "/api/projects/test/models" && request.method === "GET") return Response.json({ models: [{
        provider: "deepseek", modelId: "deepseek-flash", displayName: "Personal name",
        credential: { baseUrl: "https://personal.example", apiKeyMasked: "sk-***" },
      }] });
      if (path === "/api/projects/test/models" && request.method === "PUT") {
        writes.push(await request.json()); return Response.json({ models: [] });
      }
      throw new Error(`Unexpected ${request.method} ${path}`);
    };
    const resource = model();
    await applyPublicResource(db, { projectId: "test", resourceId: resource.id }, [resource], dispatch);
    expect(writes).toHaveLength(1);
    expect(writes[0].models).toEqual([expect.objectContaining({
      provider: "deepseek", modelId: "deepseek-flash", displayName: "DeepSeek Flash",
      baseUrl: "https://personal.example", contextWindow: 1000000,
    })]);
    expect(JSON.stringify(writes[0])).not.toContain("sk-***");
    expect(JSON.stringify(writes[0])).not.toContain("public_11111111");
  });
});

describe("apply centrally managed Agent", () => {
  it("updates the same local Agent and saves its prior configuration", async () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    const id = "22222222-2222-2222-2222-222222222222";
    const resource = (version: number): PublicResource => ({ id, kind: "agents", name: "Managed Agent", description: "Public",
      payload: { prompt: `Prompt ${version}`, agentsMd: `Instructions ${version}`, maxTurns: 10 },
      audience: ["*"], revision: version, version, published: true, updatedAt: new Date().toISOString() });
    let agentId = "";
    let config = { agentsMd: "", config: { name: "Managed Agent", description: "Public", systemPrompt: "", maxTurns: 10 } };
    const writes: unknown[] = [];
    const dispatch = async (request: Request) => {
      const route = new URL(request.url).pathname;
      if (route === "/api/projects") return Response.json({ projects: [{ projectId: "test" }] });
      if (route === "/api/projects/test/agents" && request.method === "GET") return Response.json({ agents: agentId ? [{ agentId }] : [] });
      if (route === "/api/projects/test/agents" && request.method === "POST") {
        agentId = (await request.json() as { agentId: string }).agentId; return Response.json({ agent: { agentId } });
      }
      if (route === `/api/projects/test/agents/${agentId}/config` && request.method === "GET") return Response.json(config);
      if (route === `/api/projects/test/agents/${agentId}/config` && request.method === "PUT") {
        const value = await request.json() as { agentsMd?: string; config: Partial<typeof config.config> }; writes.push(value);
        config = { agentsMd: value.agentsMd ?? config.agentsMd, config: { ...config.config, ...value.config } };
        return Response.json(config);
      }
      throw new Error(`Unexpected ${request.method} ${route}`);
    };
    const first = await applyPublicResource(db, { projectId: "test", resourceId: id }, [resource(1)], dispatch);
    const second = await applyPublicResource(db, { projectId: "test", resourceId: id }, [resource(2)], dispatch);
    expect(second.agentId).toBe(first.agentId);
    expect(writes).toHaveLength(2);
    expect(config.config.systemPrompt).toBe("Prompt 2");
    const backup = db.prepare("SELECT config_json AS configJson FROM applied_agent_backups WHERE project_id='test' AND resource_id=? AND to_version=2").get(id);
    expect(JSON.parse(String(backup?.configJson)).config.systemPrompt).toBe("Prompt 1");
  });
});
