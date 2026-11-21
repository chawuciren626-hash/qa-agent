/**
 * Admin MCP server catalog (`/api/admin/mcp-servers`): the deployment-level registry of
 * MCP servers an administrator can register, connect-test, discover tools on, and push
 * into project Agents' `tools.mcpServers`.
 *
 * Why this lives under `/api/admin/*` and not `/api/control/admin/*`: the catalog must
 * execute where the Agents are. A stdio MCP server spawns on this host ("exactly where
 * Sessions run them", routes/agent-config.ts), and the assignment target — a Project
 * Agent's system_config.yaml — is local state. `/api/control/*` is intercepted by the
 * account bridge and forwarded to the central host in bound deployments, which has
 * neither; `/api/admin/*` passes the bridge through to this server in every topology
 * (central host, bound client, standalone), same as admin.ts's own routes.
 *
 * Catalog entry ≠ assembly. Registering only writes the catalog row; nothing reaches an
 * Agent until "assign" merges the entry into that Agent's `tools.mcpServers` (with
 * `plugin: "admin-catalog"` provenance, so the Agent page can tell it apart from a
 * plugin-provided server) and invalidates the running agent runtimes. Unassigning
 * removes the entry the same way. An entry the Agent already holds under the same name
 * with different config refuses the whole request (409 `mcp_server_name_taken`) — the
 * same rule plugin installs follow, never a silent overwrite.
 *
 * The builtin entry `aitest-internal-tools` is the M1 capability egress
 * (scripts/central-mcp.mjs) finally entering agent assembly — admin-tool-console.md §8
 * recorded it as a gap ("agent 装配的 tools.mcpServers 未加出口条目"). It is seeded when
 * AITEST_ENGINE_ROOT is present, is `builtin`, and can only be enabled/disabled and
 * assigned — never edited into something else or deleted.
 *
 * Vault boundary: env/headers may carry `${KEY}` references, but the catalog holds no
 * vault. The admin-side connect test refuses to contact anything when references are
 * present (`vaultRefs: true`); once assigned, the Agent's own vault resolves them at
 * session runtime exactly as a hand-added entry would.
 */
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import {
  McpToolProvider,
  collectVaultRefs,
  resolveMCPServer,
} from "@prismshadow/penguin-core";
import type { MCPServerConfig } from "@prismshadow/penguin-core";
import { Bind, Component, Use } from "@prismshadow/penguin-core/kernel";
import type { DatabaseSync } from "node:sqlite";
import type { Db } from "../../hmr/capabilities.js";
import type { AppEnv } from "../../auth/middleware.js";
import type { Sessions as ManagerIface } from "../../runtime/session-manager.js";
import type { AgentConfig } from "../../mechanisms/agents.js";
import type { Access } from "../../mechanisms/projects.js";
import { HttpError } from "../errors.js";
import { readJson, requireValidId } from "../validate.js";

/** MCP_TEST_TIMEOUT_CAP_MS twin: a probe must never hold a request open arbitrarily long. */
const PROBE_TIMEOUT_CAP_MS = 60_000;
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BUILTIN_NAME = "aitest-internal-tools";

interface CatalogRow {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args_json: string;
  env_json: string;
  url: string;
  headers_json: string;
  description: string;
  stage_tags_json: string;
  enabled: number;
  source: "builtin" | "custom";
  tool_cache_json: string | null;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_latency_ms: number | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

interface AssignmentRow {
  server_name: string;
  project_id: string;
  agent_id: string;
  assigned_by: string;
  assigned_at: string;
}

interface CachedTool {
  name: string;
  description?: string;
}

interface ProbeResult {
  ok: boolean;
  tools?: CachedTool[];
  latencyMs?: number;
  error?: string;
  vaultRefs?: boolean;
}

const parseJsonField = <T,>(raw: string | null, fallback: T): T => {
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringRecordOf = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};

const stringListOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))].slice(0, 8);
};

const stringOf = (value: unknown, maxLen: number): string =>
  typeof value === "string" ? value.slice(0, maxLen) : "";

const mcpsServerConfigOf = (row: CatalogRow): MCPServerConfig => {
  const config: MCPServerConfig["config"] =
    row.transport === "http"
      ? { transport: "http", url: row.url, headers: parseJsonField(row.headers_json, {} as Record<string, string>) }
      : {
          command: row.command,
          args: parseJsonField(row.args_json, [] as string[]),
          env: parseJsonField(row.env_json, {} as Record<string, string>),
        };
  return { name: row.name, config };
};

const serializeRow = (row: CatalogRow, assignments: AssignmentRow[]) => ({
  name: row.name,
  transport: row.transport,
  command: row.command,
  args: parseJsonField(row.args_json, [] as string[]),
  env: parseJsonField(row.env_json, {} as Record<string, string>),
  url: row.url,
  headers: parseJsonField(row.headers_json, {} as Record<string, string>),
  description: row.description,
  stageTags: parseJsonField(row.stage_tags_json, [] as string[]),
  enabled: row.enabled === 1,
  source: row.source,
  tools: row.tool_cache_json === null ? null : parseJsonField<CachedTool[]>(row.tool_cache_json, []),
  lastTest: {
    at: row.last_test_at,
    ok: row.last_test_ok === null ? null : row.last_test_ok === 1,
    latencyMs: row.last_latency_ms,
  },
  assignments: assignments
    .filter((item) => item.server_name === row.name)
    .map(({ project_id, agent_id, assigned_by, assigned_at }) => ({
      projectId: project_id,
      agentId: agent_id,
      assignedBy: assigned_by,
      assignedAt: assigned_at,
    })),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The engine root when this server runs the AITestHarness engine; empty otherwise. */
const engineRoot = (): string => (process.env.AITEST_ENGINE_ROOT ?? "").trim();

@Component({
  contributes: {
    "HttpModule.routes": [
      { id: "McpCatalog.routes", prefix: "/api/admin/mcp-servers", auth: "user", order: 47 },
    ],
  },
})
export class McpCatalogRoutes {
  @Use() private readonly db!: Db;
  @Use() private readonly access!: Access;
  @Use() private readonly agentConfig!: AgentConfig;
  @Use() private readonly manager!: ManagerIface;
  @Bind("McpCatalog.routes") routes!: Hono<AppEnv>;

  setup() {
    const db = this.db as unknown as DatabaseSync;
    const now = () => new Date().toISOString();
    const fail = (message: string): never => { throw new HttpError(400, "bad_request", message); };
    const idFrom = (value: unknown, label: string): string => {
      if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(`${label} 无效。`);
      return value as string;
    };

    const audit = (actor: string, serverName: string, action: string, detail = "") => {
      db.prepare("INSERT INTO mcp_server_audit(server_name,action,actor,detail,created_at) VALUES (?,?,?,?,?)")
        .run(serverName, action, actor, detail, now());
    };

    /**
     * The builtin egress is a code fact, like central-tools' impl_path: seed on setup
     * (INSERT OR IGNORE keeps any admin change), and refresh the spawn command whenever
     * the engine root moved — a stale command would fail every connect with a path
     * nobody recognizes. `created_by` stays "builtin"; it is not an operator action.
     */
    const ensureBuiltin = () => {
      const root = engineRoot();
      if (!root) return;
      const command = process.execPath;
      const args = JSON.stringify([join(root, "scripts", "central-mcp.mjs")]);
      const description = "AITestHarness 内部阶段工具 MCP 出口（scripts/central-mcp.mjs）：10 个确定性阶段工具，启停状态由管理后台工具台账同步；工具调用需绑定运行（缺 AITEST_RUN_ID / AITEST_CONTROLLER_SESSION 会被拒）。";
      db.prepare(
        "INSERT OR IGNORE INTO mcp_server_catalog(name,transport,command,args_json,env_json,url,headers_json,description,stage_tags_json,enabled,source,tool_cache_json,last_test_at,last_test_ok,last_latency_ms,created_at,created_by,updated_at) VALUES (?,'stdio',?,?,'{}','','{}',?,'[\"cross\"]',0,'builtin',NULL,NULL,NULL,NULL,?,'builtin',?)",
      ).run(BUILTIN_NAME, command, args, description, now(), now());
      db.prepare("UPDATE mcp_server_catalog SET command=?, args_json=?, updated_at=? WHERE name=? AND source='builtin'")
        .run(command, args, now(), BUILTIN_NAME);
    };

    const row = (name: string): CatalogRow => {
      const found = db.prepare("SELECT * FROM mcp_server_catalog WHERE name=?").get(name) as unknown as CatalogRow | undefined;
      if (!found) throw new HttpError(404, "unknown_mcp_server", `目录中没有 MCP 服务 ${name}。`);
      return found;
    };
    const assignments = (): AssignmentRow[] =>
      db.prepare("SELECT * FROM mcp_server_assignments ORDER BY assigned_at DESC").all() as unknown as AssignmentRow[];

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      if (!c.var.user.isAdmin) throw new HttpError(403, "admin_required", "仅管理员可以管理 MCP 服务目录。");
      await next();
    });

    // ---- listing / CRUD ---------------------------------------------------------------

    app.get("/", (c) => {
      ensureBuiltin();
      const rows = db.prepare("SELECT * FROM mcp_server_catalog ORDER BY source DESC, name").all() as unknown as CatalogRow[];
      const ledger = assignments();
      const auditRows = db.prepare("SELECT server_name AS serverName,action,actor,detail,created_at AS createdAt FROM mcp_server_audit ORDER BY id DESC LIMIT 100").all();
      return c.json({ servers: rows.map((item) => serializeRow(item, ledger)), audit: auditRows, engineRootPresent: Boolean(engineRoot()) });
    });

    app.post("/", async (c) => {
      ensureBuiltin();
      const body = await readJson(c);
      const name = stringOf(body.name, 64).trim();
      if (!SERVER_NAME_PATTERN.test(name)) fail("服务名只能包含字母、数字、下划线或短横线（≤64 字符）。");
      const transport = body.transport === "http" ? "http" : "stdio";
      const command = stringOf(body.command, 1000).trim();
      const url = stringOf(body.url, 1000).trim();
      if (transport === "stdio" && !command) fail("stdio 服务必须填写启动命令。");
      if (transport === "http" && !/^https?:\/\//.test(url)) fail("http 服务必须填写 http(s) 端点。");
      const args = Array.isArray(body.args) ? body.args.filter((item): item is string => typeof item === "string").slice(0, 64) : [];
      const env = stringRecordOf(body.env);
      const headers = stringRecordOf(body.headers);
      const description = stringOf(body.description, 2000);
      const stageTags = stringListOf(body.stageTags);
      const stamp = now();
      try {
        db.prepare(
          "INSERT INTO mcp_server_catalog(name,transport,command,args_json,env_json,url,headers_json,description,stage_tags_json,enabled,source,tool_cache_json,last_test_at,last_test_ok,last_latency_ms,created_at,created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,'custom',NULL,NULL,NULL,NULL,?,?,?)",
        ).run(name, transport, command, JSON.stringify(args), JSON.stringify(env), url, JSON.stringify(headers), description, JSON.stringify(stageTags), stamp, c.var.user.userId, stamp);
      } catch {
        throw new HttpError(409, "mcp_server_exists", `MCP 服务 ${name} 已在目录中。`);
      }
      audit(c.var.user.userId, name, "create", transport);
      return c.body(null, 201);
    });

    app.patch("/:name", async (c) => {
      const name = requireValidId(c, "name");
      const target = row(name);
      const body = await readJson(c);
      const builtin = target.source === "builtin";
      // builtin 条目是代码事实：只有启停与描述可改，改了 command/transport 等于伪造出口。
      if (builtin && Object.keys(body).some((key) => !["enabled", "description", "stageTags"].includes(key))) {
        fail("内置 MCP 出口只能启停或修改描述，传输与命令由代码决定。");
      }
      const updates: string[] = [];
      const values: (string | number)[] = [];
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") fail("enabled 必须是布尔值。");
        updates.push("enabled=?");
        values.push(body.enabled ? 1 : 0);
      }
      if (body.description !== undefined) {
        if (typeof body.description !== "string") fail("description 必须是字符串。");
        updates.push("description=?");
        values.push((body.description as string).slice(0, 2000));
      }
      if (body.stageTags !== undefined) {
        if (!Array.isArray(body.stageTags)) fail("stageTags 必须是数组。");
        updates.push("stage_tags_json=?");
        values.push(JSON.stringify(stringListOf(body.stageTags)));
      }
      if (!builtin && (body.command !== undefined || body.url !== undefined || body.args !== undefined || body.env !== undefined || body.headers !== undefined || body.transport !== undefined)) {
        const transport = body.transport === "http" ? "http" : body.transport === "stdio" ? "stdio" : target.transport;
        const command = body.command === undefined ? target.command : stringOf(body.command, 1000).trim();
        const url = body.url === undefined ? target.url : stringOf(body.url, 1000).trim();
        if (transport === "stdio" && !command) fail("stdio 服务必须填写启动命令。");
        if (transport === "http" && !/^https?:\/\//.test(url)) fail("http 服务必须填写 http(s) 端点。");
        updates.push("transport=?", "command=?", "args_json=?", "env_json=?", "url=?", "headers_json=?", "tool_cache_json=NULL");
        values.push(
          transport,
          command,
          JSON.stringify(body.args === undefined ? parseJsonField(target.args_json, [] as string[]) : Array.isArray(body.args) ? body.args.filter((item): item is string => typeof item === "string").slice(0, 64) : []),
          JSON.stringify(body.env === undefined ? parseJsonField(target.env_json, {} as Record<string, string>) : stringRecordOf(body.env)),
          url,
          JSON.stringify(body.headers === undefined ? parseJsonField(target.headers_json, {} as Record<string, string>) : stringRecordOf(body.headers)),
        );
        // 配置变了，旧的工具缓存与健康状态不再表达这条服务。
        updates.push("last_test_at=NULL", "last_test_ok=NULL", "last_latency_ms=NULL");
      }
      if (updates.length === 0) return c.json({ ok: true });
      db.prepare(`UPDATE mcp_server_catalog SET ${updates.join(",")}, updated_at=? WHERE name=?`).run(...values, now(), name);
      const enabled = body.enabled === undefined ? target.enabled === 1 : body.enabled === true;
      audit(c.var.user.userId, name, body.enabled === undefined ? "update" : enabled ? "enable" : "disable");
      return c.json({ ok: true });
    });

    app.delete("/:name", (c) => {
      const name = requireValidId(c, "name");
      const target = row(name);
      if (target.source === "builtin") throw new HttpError(409, "builtin_server", "内置 MCP 出口不可删除，只能停用。");
      const count = db.prepare("SELECT COUNT(*) AS value FROM mcp_server_assignments WHERE server_name=?").get(name) as unknown as { value: number };
      if (count.value > 0) throw new HttpError(409, "mcp_server_assigned", `MCP 服务 ${name} 已下发到 ${count.value} 个 Agent，请先撤销全部下发。`);
      db.prepare("DELETE FROM mcp_server_catalog WHERE name=?").run(name);
      audit(c.var.user.userId, name, "delete", target.description.slice(0, 80));
      return c.body(null, 204);
    });

    // ---- connect test / tool discovery -------------------------------------------------

    /**
     * 连通测试：与 routes/agent-config.ts 的 mcp-test 同一套 resolver + provider（连接
     * 发生在本机，正是会话运行期 spawn 的地方），但目录层没有 vault——条目带 `${KEY}`
     * 引用时一律不发起连接，明确提示；下发到 Agent 后由 Agent 的 vault 在会话期解析。
     */
    const probe = async (entry: MCPServerConfig): Promise<ProbeResult> => {
      const refs = collectVaultRefs(entry.config);
      if (refs.length > 0) {
        return { ok: false, vaultRefs: true, error: `条目包含密钥引用（${refs.join("、")}）：管理端连通测试不解析引用。请直接填入字面值测试，或下发到 Agent 后由该 Agent 的密钥库解析。` };
      }
      let resolved;
      try {
        resolved = resolveMCPServer(entry);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const entryCopy: MCPServerConfig = { ...entry, config: { ...entry.config, connectTimeoutMs: Math.min(resolved.connectTimeoutMs, PROBE_TIMEOUT_CAP_MS) } };
      const warnings: string[] = [];
      const workspaceDir = await mkdtemp(join(tmpdir(), "penguin-mcp-catalog-test-"));
      const provider = new McpToolProvider([entryCopy], { workspaceDir, vault: {}, warn: (message) => warnings.push(message) });
      const startedAt = Date.now();
      try {
        const tools = await provider.listTools();
        const latencyMs = Date.now() - startedAt;
        const outcome = provider.connectResults()[0];
        if (outcome === undefined || outcome.status !== "completed") {
          return { ok: false, latencyMs, error: outcome?.error_message ?? (warnings.length > 0 ? warnings.join("; ") : "connect failed") };
        }
        return {
          ok: true,
          latencyMs,
          tools: tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })),
        };
      } catch (error) {
        return { ok: false, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
      } finally {
        await provider.close();
        void rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
      }
    };

    const recordProbe = (name: string, result: ProbeResult) => {
      db.prepare("UPDATE mcp_server_catalog SET tool_cache_json=?, last_test_at=?, last_test_ok=?, last_latency_ms=?, updated_at=? WHERE name=?")
        .run(result.ok && result.tools ? JSON.stringify(result.tools) : null, now(), result.ok ? 1 : 0, result.latencyMs ?? null, now(), name);
    };

    app.post("/:name/test", async (c) => {
      const name = requireValidId(c, "name");
      const target = row(name);
      const result = await probe(mcpsServerConfigOf(target));
      recordProbe(name, result);
      audit(c.var.user.userId, name, result.ok ? "test_ok" : "test_fail", `${result.latencyMs ?? 0}ms${result.error ? ` ${result.error.slice(0, 120)}` : ""}`);
      return c.json(result);
    });

    app.get("/:name/tools", async (c) => {
      const name = requireValidId(c, "name");
      const target = row(name);
      if (c.req.query("refresh") === "true" || target.tool_cache_json === null) {
        const result = await probe(mcpsServerConfigOf(target));
        recordProbe(name, result);
        if (!result.ok) return c.json(result);
        return c.json({ ok: true, tools: result.tools ?? [] });
      }
      return c.json({ ok: true, tools: parseJsonField<CachedTool[]>(target.tool_cache_json, []) });
    });

    // ---- assignment: catalog entry → Agent tools.mcpServers -----------------------------

    app.post("/:name/assign", async (c) => {
      const name = requireValidId(c, "name");
      const target = row(name);
      if (!target.enabled) throw new HttpError(409, "server_disabled", `MCP 服务 ${name} 已停用：请先启用再下发。`);
      const body = await readJson(c);
      const projectId = idFrom(body.projectId, "projectId");
      const agentId = idFrom(body.agentId, "agentId");
      // 管理员在 QA 部署下对所有项目有成员级访问（services/project-access.ts）；
      // requireExists 再兜一层：项目或 Agent 不存在时这里是权威报错。
      this.access.requireProjectAccess(c.var.user.userId, projectId);
      await this.agentConfig.requireExists(projectId, agentId);

      const view = await this.agentConfig.getConfig(projectId, agentId);
      const existing = view.config.mcpServers;
      const held = existing.find((item) => item.name === name);
      const entry = { ...mcpsServerConfigOf(target), plugin: "admin-catalog" } as MCPServerConfig;
      if (held) {
        const sameConfig = JSON.stringify(held.config) === JSON.stringify(entry.config);
        if (!sameConfig) {
          throw new HttpError(409, "mcp_server_name_taken", `Agent 已有一个名字相同但配置不同的 MCP 服务「${name}」；请先在 Agent 配置页移除它，或改用其他服务名。`);
        }
        // 同名同配置：幂等成功，台账补行即可。
        db.prepare("INSERT OR IGNORE INTO mcp_server_assignments(server_name,project_id,agent_id,assigned_by,assigned_at) VALUES (?,?,?,?,?)")
          .run(name, projectId, agentId, c.var.user.userId, now());
        return c.json({ ok: true, idempotent: true });
      }
      await this.agentConfig.updateConfig(projectId, agentId, { config: { mcpServers: [...existing, entry] } });
      this.manager.invalidateAgentRuntimes(projectId, agentId);
      db.prepare("INSERT OR IGNORE INTO mcp_server_assignments(server_name,project_id,agent_id,assigned_by,assigned_at) VALUES (?,?,?,?,?)")
        .run(name, projectId, agentId, c.var.user.userId, now());
      audit(c.var.user.userId, name, "assign", `${projectId}/${agentId}`);
      return c.json({ ok: true }, 201);
    });

    app.post("/:name/unassign", async (c) => {
      const name = requireValidId(c, "name");
      row(name);
      const body = await readJson(c);
      const projectId = idFrom(body.projectId, "projectId");
      const agentId = idFrom(body.agentId, "agentId");
      this.access.requireProjectAccess(c.var.user.userId, projectId);
      await this.agentConfig.requireExists(projectId, agentId);
      const view = await this.agentConfig.getConfig(projectId, agentId);
      const next = view.config.mcpServers.filter((item) => item.name !== name);
      const removed = next.length !== view.config.mcpServers.length;
      if (removed) {
        await this.agentConfig.updateConfig(projectId, agentId, { config: { mcpServers: next } });
        this.manager.invalidateAgentRuntimes(projectId, agentId);
      }
      // 台账行无论如何都撤：Agent 侧被手工移除后，管理页不应再把这条当作有效下发。
      db.prepare("DELETE FROM mcp_server_assignments WHERE server_name=? AND project_id=? AND agent_id=?").run(name, projectId, agentId);
      if (removed) audit(c.var.user.userId, name, "unassign", `${projectId}/${agentId}`);
      return c.json({ ok: true, removed });
    });

    app.get("/assignments", (c) => {
      return c.json({ assignments: assignments() });
    });

    this.routes = app;
  }
}
