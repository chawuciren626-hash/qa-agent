import { describe, expect, it } from "vitest";
import { formatLatency, parseArgLines, parseKeyValueLines, keyValuesToText, testLabel } from "../src/features/admin/admin-mcp-page";
import { ADMIN_MENU_KEYS, ADMIN_MENU_LABELS, defaultAdminMenus, normalizeAdminMenus } from "../src/features/admin/admin-system-pages";
import type { McpServer } from "../src/features/admin/admin-mcp-page";

describe("MCP 目录：配置文本解析", () => {
  it("参数按行拆分，丢弃空行与注释行", () => {
    expect(parseArgLines("\n  --stdio \n # comment \npath/to/server.mjs\n\n")).toEqual([
      "--stdio",
      "path/to/server.mjs",
    ]);
  });

  it("环境变量按 KEY=VALUE 拆分，等号后的值允许含等号", () => {
    expect(parseKeyValueLines("API_KEY=abc\nBASE_URL=https://host?a=1\n# 注释\n无效行")).toEqual({
      API_KEY: "abc",
      BASE_URL: "https://host?a=1",
    });
  });

  it("键值表与文本互为往返", () => {
    const value = { A: "1", B: "x=y" };
    expect(parseKeyValueLines(keyValuesToText(value))).toEqual(value);
  });
});

describe("MCP 目录：展示结论", () => {
  const server = (lastTest: McpServer["lastTest"]): McpServer => ({
    name: "demo", transport: "stdio", command: "node", args: [], env: {}, url: "", headers: {},
    description: "", stageTags: [], enabled: true, source: "custom", tools: null,
    lastTest, assignments: [], createdAt: "", updatedAt: "",
  });

  it("从未测试不是失败：显示「未测试」", () => {
    expect(testLabel(server({ at: null, ok: null, latencyMs: null }))).toBe("未测试");
  });

  it("连通成功带延迟；失败只说失败", () => {
    expect(testLabel(server({ at: "2026-11-21T00:00:00.000Z", ok: true, latencyMs: 233 }))).toBe("连通 · 233 ms");
    expect(testLabel(server({ at: "2026-11-21T00:00:00.000Z", ok: false, latencyMs: 40 }))).toBe("失败");
    expect(formatLatency(null)).toBe("—");
  });
});

describe("MCP 目录：管理菜单注册", () => {
  it("mcp 是内置菜单键且归入平台管理分组", () => {
    expect(ADMIN_MENU_KEYS).toContain("mcp");
    expect(ADMIN_MENU_LABELS.mcp).toBe("MCP 服务");
    const items = defaultAdminMenus();
    expect(items.find(item => item.key === "mcp")).toMatchObject({ group: "main", path: "/mcp" });
  });

  it("旧中央服务持久化的菜单清单没有 mcp 键时，归一化补回默认项", () => {
    const legacy = [{ key: "overview", visible: true }];
    const items = normalizeAdminMenus(legacy);
    expect(items.some(item => item.key === "mcp")).toBe(true);
  });
});
