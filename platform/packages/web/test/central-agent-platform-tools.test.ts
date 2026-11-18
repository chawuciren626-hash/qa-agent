// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { mount, unmountAll, click } from "./helpers/dom";
import { CentralAgentPlatformTools } from "../src/features/admin/central-agent-platform-tools";
import { CentralAgentSettingsPage } from "../src/features/admin/central-agent-settings-page";
import { ApiError } from "../src/api/client";

const calls = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/api/control", () => ({ controlRequest: calls.request }));
afterEach(async () => { await unmountAll(); calls.request.mockReset(); });

const tool = (overrides: Record<string, unknown> = {}) => ({
  id: "tool_irval_check", name: "irval.check", displayName: "IR 校验链", categoryId: "common",
  permissions: "read", enabled: true, agents: ["automation_execution_agent"], ...overrides,
});
const catalog = (tools: unknown[]) => ({
  tools,
  categories: [{ id: "common", name: "通用", builtin: 1 }, { id: "web", name: "Web 自动化", builtin: 1 }],
});
const mountBlock = (agentId: string) => mount(h(MemoryRouter, { initialEntries: ["/agents/res-1"] },
  h(Routes, null,
    h(Route, { path: "/agents/:id", element: h(CentralAgentPlatformTools, { agentId }) }),
    h(Route, { path: "/tools", element: h("p", null, "工具管理页标记") }))));

it("shows only the tools bound to this agent, read-only, with category, permission and enabled state", async () => {
  calls.request.mockResolvedValue(catalog([
    tool(),
    tool({ id: "tool_dom_snapshot", name: "dom.snapshot", displayName: "DOM 快照与基线 diff", categoryId: "web", permissions: "write", enabled: false }),
    tool({ id: "tool_report_reviewer", name: "report.reviewer", displayName: "报告审阅", agents: ["test_report_agent"] }),
  ]));
  await mountBlock("automation_execution_agent");
  const section = document.querySelector('[aria-label="平台工具"]')!;
  expect(section.textContent).toContain("IR 校验链");
  expect(section.textContent).toContain("dom.snapshot");
  expect(section.textContent).toContain("Web 自动化");
  expect(section.textContent).toContain("已停用");
  expect(section.textContent).not.toContain("report.reviewer");
  expect(section.querySelectorAll("input, select, [role=switch]").length).toBe(0);
  expect([...section.querySelectorAll("button")].map(button => button.textContent)).toEqual(["在工具管理中查看"]);
  expect(calls.request).toHaveBeenCalledWith("/api/control/tools/admin");
});

it("navigates to the tools management page instead of editing bindings here", async () => {
  calls.request.mockResolvedValue(catalog([tool()]));
  await mountBlock("automation_execution_agent");
  await click([...document.querySelectorAll("button")].find(button => button.textContent === "在工具管理中查看")!);
  expect(document.body.textContent).toContain("工具管理页标记");
  expect(calls.request.mock.calls.every(([path, method]) => path === "/api/control/tools/admin" && (method ?? "GET") === "GET")).toBe(true);
});

it("says so when the agent has no platform tool bindings", async () => {
  calls.request.mockResolvedValue(catalog([tool({ agents: ["test_report_agent"] })]));
  await mountBlock("automation_execution_agent");
  expect(document.querySelector('[aria-label="平台工具"]')!.textContent).toContain("尚未绑定任何平台工具");
});

it("surfaces a read failure instead of pretending the agent has no tools", async () => {
  calls.request.mockRejectedValue(new ApiError(403, "admin_required", "Admins only."));
  await mountBlock("automation_execution_agent");
  const alert = document.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("仅管理员可执行此操作。");
  expect(document.body.textContent).not.toContain("尚未绑定任何平台工具");
});

it("renders nothing and requests nothing without an agentId", async () => {
  await mountBlock("");
  expect(document.querySelector('[aria-label="平台工具"]')).toBeNull();
  expect(calls.request).not.toHaveBeenCalled();
});

it("mounts under the central agent settings tools tab beside the untouched builtin table", async () => {
  const resource = {
    id: "res-1", kind: "agents", name: "自动化执行", description: "", revision: 1, version: 1, published: true,
    audience: [], payload: { agentId: "automation_execution_agent", prompt: "p", agentsMd: "a", toolsBuiltin: [{ name: "read_file" }] },
  };
  calls.request.mockImplementation(async (path: string) => {
    if (path === "/api/control/admin/agents/res-1/live") return resource;
    if (path === "/api/control/catalog") return { resources: [] };
    if (path === "/api/control/admin/agent-defaults") return { prompt: "", toolsBuiltin: [{ name: "read_file" }], kernelVersion: "1.0.0" };
    if (path === "/api/control/admin/resources/res-1/storage") return { directory: "" };
    if (path === "/api/control/tools/admin") return catalog([tool()]);
    throw new Error("Unexpected request: " + path);
  });
  await mount(h(MemoryRouter, { initialEntries: ["/agents/res-1?tab=tools"] },
    h(Routes, null, h(Route, { path: "/agents/:agentId", element: h(CentralAgentSettingsPage) }))));
  const panel = document.querySelector("#agent-settings-panel")!;
  expect(panel.textContent).toContain("read_file");
  const section = panel.querySelector('[aria-label="平台工具"]')!;
  expect(section.textContent).toContain("IR 校验链");
  expect(section.textContent).toContain("已启用");
}, 30_000);