import type { Migration } from "../migration.js";

/**
 * 管理后台 MCP 服务目录（MCP 目录全闭环）。
 *
 * 在此之前，Agent 能用哪些 MCP 服务由三处分散的事实决定：插件安装写入的
 * `tools.mcpServers`、Agent 配置页手填的条目、以及 scripts/central-mcp.mjs 已建成却
 * 从未进入装配的内部工具出口（docs/admin-tool-console.md §8 明确差距）。管理员没有
 * 一个"这台部署上有哪些 MCP 服务、健康与否、下发给了谁"的台账——这张表就是台账。
 *
 * ## 目录条目 ≠ Agent 装配
 *
 * 目录条目是部署级资产（deployment-global，与插件库/技能库同层）：登记 → 测试连通 →
 * 下发给具体 Agent（写入该 Agent 的 tools.mcpServers）才会生效。enabled 只控制"这条
 * 服务还能不能被再次下发/出现在目录里"，不移除已下发的装配——与插件启停语义一致。
 *
 * ## 内置出口不在迁移里 seed
 *
 * `aitest-internal-tools` 的 command 依赖运行期的 AITEST_ENGINE_ROOT，迁移是冻结 DDL，
 * 不能读运行环境；内置条目由路由层在首次访问时 INSERT OR IGNORE（routes/mcp-catalog.ts）。
 *
 * ## 凭据边界
 *
 * env/headers 允许 `${KEY}` 引用，但目录层不持有 vault：管理端连通测试不填引用（明确
 * 返回提示），下发到 Agent 后由该 Agent 的 vault 在会话运行期照常解析（既有行为）。
 * 字段名带 `_json` 后缀与 qa_tasks.scope_json 等既有列一致——序列化结构由写入方校验。
 */
export const mcpServerCatalog: Migration = {
  name: "2026-11-21-mcp-server-catalog",
  // 纯新增表：旧平台读不到也不会写坏；目录缺失只损失管理能力，运行期装配不受影响。
  swapSafe: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS mcp_server_catalog (
  name            TEXT PRIMARY KEY,          -- MCP 服务名；下发后即 Agent tools.mcpServers 的条目名
  transport       TEXT NOT NULL DEFAULT 'stdio' CHECK(transport IN ('stdio','http')),
  command         TEXT NOT NULL DEFAULT '',  -- stdio：可执行文件；http 恒为 ''
  args_json       TEXT NOT NULL DEFAULT '[]',
  env_json        TEXT NOT NULL DEFAULT '{}',-- 支持 \${KEY} 引用；目录层不解析，Agent vault 运行期解析
  url             TEXT NOT NULL DEFAULT '',  -- http：Streamable HTTP 端点；stdio 恒为 ''
  headers_json    TEXT NOT NULL DEFAULT '{}',
  description     TEXT NOT NULL DEFAULT '',
  stage_tags_json TEXT NOT NULL DEFAULT '[]',-- 阶段标签（cross/analysis/…/desktop），目录页分组用
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  source          TEXT NOT NULL DEFAULT 'custom' CHECK(source IN ('builtin','custom')),
  tool_cache_json TEXT,                      -- 最近一次连通成功的 tools/list 结果；NULL=未测出工具
  last_test_at    TEXT,
  last_test_ok    INTEGER CHECK(last_test_ok IN (0,1)), -- NULL=从未测试
  last_latency_ms INTEGER,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_catalog_enabled ON mcp_server_catalog(enabled, name);

-- 下发台账：目录把条目推进了哪些 Agent。只记「目录推送」的装配（Agent 配置页手填的
-- 不经这里）；Agent 侧被手工移除后台账行仍在，列表页把这种行当作漂移展示，不自动清理。
CREATE TABLE IF NOT EXISTS mcp_server_assignments (
  server_name  TEXT NOT NULL REFERENCES mcp_server_catalog(name) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  assigned_by  TEXT NOT NULL,
  assigned_at  TEXT NOT NULL,
  PRIMARY KEY (server_name, project_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_assign_agent ON mcp_server_assignments(project_id, agent_id);

-- 目录审计：登记/修改/启停/测试/下发/撤销各留一条，管理页「最近变更」直接可读。
CREATE TABLE IF NOT EXISTS mcp_server_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
`);
  },
  down(db) {
    db.exec("DROP TABLE IF EXISTS mcp_server_audit");
    db.exec("DROP TABLE IF EXISTS mcp_server_assignments");
    db.exec("DROP TABLE IF EXISTS mcp_server_catalog");
  },
};
