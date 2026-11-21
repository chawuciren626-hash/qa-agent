/**
 * 管理后台 MCP 服务目录（routes/mcp-catalog.ts）：登记 → 测试 → 下发 → 撤销的全链路。
 *
 * 目录条目本身不动任何 Agent；「下发」把条目写进目标 Agent 的 tools.mcpServers
 * （plugin=admin-catalog）并失效运行期缓存。这里逐条核对容易悄悄写错的地方：
 *   - 非管理员一律 403，目录是管理面；
 *   - 同名同配置的重复下发是幂等成功，同名不同配置是 409（绝不静默覆盖）；
 *   - 停用的服务不能下发；删除已下发的服务被拒；内置出口不可删、不可改命令；
 *   - 连通测试在本机真的起了子进程（坏命令 → ok:false），`${KEY}` 引用一律不外联；
 *   - 台账与审计随每次动作落行，管理页不靠猜。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfigResponse } from "../src/api/types.js";
import { apiClient, createTestApp, loginUser, loginAdmin, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const AGENT = "/api/projects/default_project/agents/default_agent";
const BASE = "/api/admin/mcp-servers";

type CatalogResponse = {
  servers: {
    name: string; transport: "stdio" | "http"; enabled: boolean; source: "builtin" | "custom";
    tools: { name: string }[] | null;
    lastTest: { at: string | null; ok: boolean | null; latencyMs: number | null };
    assignments: { projectId: string; agentId: string }[];
  }[];
  audit: { serverName: string; action: string }[];
  engineRootPresent: boolean;
};

describe("管理后台 MCP 服务目录", () => {
  let t: TestApp;

  afterEach(async () => {
    await t.cleanup();
  });

  const boot = async () => {
    t = await createTestApp();
    return apiClient(t.app, (await loginAdmin(t.app)).cookie);
  };

  const createServer = async (admin: ReturnType<typeof apiClient>, name = "team-tools", overrides: Record<string, unknown> = {}) => {
    const res = await admin.post(BASE, {
      name, transport: "stdio", command: "node",
      args: ["${SERVER_ROOT}/server.mjs"], env: { TOKEN: "literal" },
      description: "团队自建工具", stageTags: ["cross"],
      ...overrides,
    });
    return res;
  };

  it("非管理员一律 403：目录是管理面，普通用户与未登录都进不来", async () => {
    t = await createTestApp();
    await provisionUser(t.app, "member1");
    const member = apiClient(t.app, (await loginUser(t.app, "member1", "password-123")).cookie);
    expect((await member.get(BASE)).status).toBe(403);
    expect((await member.post(BASE, { name: "x", transport: "stdio", command: "node" })).status).toBe(403);
    expect((await t.app.request(BASE)).status).toBe(401);
  });

  it("登记 → 列表 → 修改 → 停用；重复登记 409", async () => {
    const admin = await boot();
    expect((await createServer(admin)).status).toBe(201);
    expect((await createServer(admin)).status).toBe(409);

    const listed = (await (await admin.get(BASE)).json()) as CatalogResponse;
    const mine = listed.servers.find(item => item.name === "team-tools");
    expect(mine).toMatchObject({ transport: "stdio", enabled: true, source: "custom" });
    expect(mine?.lastTest.ok).toBeNull();

    const patched = await admin.patch(`${BASE}/team-tools`, {
      command: "node", args: ["${SERVER_ROOT}/server.mjs", "--verbose"], description: "更新说明", enabled: false,
    });
    expect(patched.status).toBe(200);
    const after = (await (await admin.get(BASE)).json()) as CatalogResponse;
    const updated = after.servers.find(item => item.name === "team-tools");
    expect(updated).toMatchObject({ enabled: false });
    // 配置变了，旧的健康状态不再表达这条服务。
    expect(updated?.lastTest.ok).toBeNull();
    expect(after.audit.map(item => item.action)).toContain("disable");
  });

  it("下发：写入 Agent tools.mcpServers（plugin=admin-catalog）、台账落行；重复下发幂等；撤销还原", async () => {
    const admin = await boot();
    await createServer(admin);
    const assigned = await admin.post(`${BASE}/team-tools/assign`, { projectId: "default_project", agentId: "default_agent" });
    expect(assigned.status).toBe(201);

    const config = (await (await admin.get(`${AGENT}/config`)).json()) as AgentConfigResponse;
    const entry = config.config.mcpServers.find(item => item.name === "team-tools");
    expect(entry).toMatchObject({ name: "team-tools", plugin: "admin-catalog" });
    expect((entry?.config as Record<string, unknown>).command).toBe("node");

    const again = await admin.post(`${BASE}/team-tools/assign`, { projectId: "default_project", agentId: "default_agent" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, idempotent: true });

    const listed = (await (await admin.get(BASE)).json()) as CatalogResponse;
    expect(listed.servers.find(item => item.name === "team-tools")?.assignments.map(item => ({
      projectId: item.projectId, agentId: item.agentId,
    }))).toEqual([{ projectId: "default_project", agentId: "default_agent" }]);

    const revoked = await admin.post(`${BASE}/team-tools/unassign`, { projectId: "default_project", agentId: "default_agent" });
    expect(revoked.status).toBe(200);
    const after = (await (await admin.get(`${AGENT}/config`)).json()) as AgentConfigResponse;
    expect(after.config.mcpServers.find(item => item.name === "team-tools")).toBeUndefined();
    const ledger = (await (await admin.get(`${BASE}/assignments`)).json()) as { assignments: unknown[] };
    expect(ledger.assignments).toEqual([]);
    expect((await admin.delete(`${BASE}/team-tools`)).status).toBe(204);
  });

  it("同名不同配置的装配冲突是 409，绝不静默覆盖 Agent 手填的条目", async () => {
    const admin = await boot();
    await createServer(admin, "team-tools", { command: "node", args: ["${SERVER_ROOT}/server.mjs"] });
    const own = [{ name: "team-tools", config: { command: "python", args: ["other.mjs"] } }];
    expect((await admin.put(`${AGENT}/config`, { config: { mcpServers: own } })).status).toBe(200);

    const res = await admin.post(`${BASE}/team-tools/assign`, { projectId: "default_project", agentId: "default_agent" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "mcp_server_name_taken" } });
    // Agent 的原条目原样保留。
    const config = (await (await admin.get(`${AGENT}/config`)).json()) as AgentConfigResponse;
    expect(config.config.mcpServers[0]?.config).toMatchObject({ command: "python" });
  });

  it("停用的服务不能下发；已下发的服务不能删除；Agent 名义上不存在的下发给 404", async () => {
    const admin = await boot();
    await createServer(admin);
    expect((await admin.patch(`${BASE}/team-tools`, { enabled: false })).status).toBe(200);
    const disabled = await admin.post(`${BASE}/team-tools/assign`, { projectId: "default_project", agentId: "default_agent" });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ error: { code: "server_disabled" } });

    expect((await admin.patch(`${BASE}/team-tools`, { enabled: true })).status).toBe(200);
    expect((await admin.post(`${BASE}/team-tools/assign`, { projectId: "default_project", agentId: "default_agent" })).status).toBe(201);
    const blocked = await admin.delete(`${BASE}/team-tools`);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "mcp_server_assigned" } });

    const missing = await admin.post(`${BASE}/team-tools/assign`, { projectId: "default_project", agentId: "ghost_agent" });
    expect(missing.status).toBe(404);
  });

  it("连通测试在本机真实起子进程：坏命令得到 ok:false 并留审计；${KEY} 引用一律不外联", async () => {
    const admin = await boot();
    await createServer(admin, "broken", { command: "definitely-not-an-executable-xyz" });
    const failed = (await (await admin.post(`${BASE}/broken/test`, {})).json()) as { ok: boolean; error?: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeTruthy();

    await createServer(admin, "with-vault", { env: { TOKEN: "${SECRET_KEY}" } });
    const vaultProbe = (await (await admin.post(`${BASE}/with-vault/test`, {})).json()) as { ok: boolean; vaultRefs?: boolean };
    expect(vaultProbe.ok).toBe(false);
    expect(vaultProbe.vaultRefs).toBe(true);

    const listed = (await (await admin.get(BASE)).json()) as CatalogResponse;
    const broken = listed.servers.find(item => item.name === "broken");
    expect(broken?.lastTest.ok).toBe(false);
    expect(broken?.tools).toBeNull();
    expect(listed.audit.filter(item => item.serverName === "broken").map(item => item.action)).toContain("test_fail");
  });

  it("内置出口：有 AITEST_ENGINE_ROOT 时自动入列，只可启停/下发，不可删除或改命令", async () => {
    t = await createTestApp();
    const scriptsDir = path.join(t.root, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, "central-mcp.mjs"), "// egress placeholder\n");
    const previous = process.env.AITEST_ENGINE_ROOT;
    process.env.AITEST_ENGINE_ROOT = t.root;
    try {
      const admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
      const listed = (await (await admin.get(BASE)).json()) as CatalogResponse;
      const builtin = listed.servers.find(item => item.name === "aitest-internal-tools");
      expect(builtin).toMatchObject({ source: "builtin", transport: "stdio", enabled: false });
      expect(listed.engineRootPresent).toBe(true);

      expect((await admin.patch(`${BASE}/aitest-internal-tools`, { enabled: true })).status).toBe(200);
      // 命令是代码事实：管理员改不了。
      const forged = await admin.patch(`${BASE}/aitest-internal-tools`, { command: "evil.exe" });
      expect(forged.status).toBe(400);
      const deleted = await admin.delete(`${BASE}/aitest-internal-tools`);
      expect(deleted.status).toBe(409);
      expect(await deleted.json()).toMatchObject({ error: { code: "builtin_server" } });

      // 启用后可以下发到 Agent —— 内部工具出口第一次进入 agent 装配（admin-tool-console §8 的差距补上）。
      const assigned = await admin.post(`${BASE}/aitest-internal-tools/assign`, { projectId: "default_project", agentId: "default_agent" });
      expect(assigned.status).toBe(201);
      const config = (await (await admin.get(`${AGENT}/config`)).json()) as AgentConfigResponse;
      const entry = config.config.mcpServers.find(item => item.name === "aitest-internal-tools");
      expect(entry).toMatchObject({ plugin: "admin-catalog" });
      expect(((entry?.config as { args?: string[] }).args ?? [])[0]).toContain("central-mcp.mjs");
    } finally {
      if (previous === undefined) delete process.env.AITEST_ENGINE_ROOT;
      else process.env.AITEST_ENGINE_ROOT = previous;
    }
  });
});
