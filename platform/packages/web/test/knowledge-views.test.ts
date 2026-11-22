// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, run, click } from "./helpers/dom";
import { SystemMapView } from "../src/features/qa/system-map-view";
import { RunArchiveView } from "../src/features/qa/run-archive-view";
import { ProjectKnowledgePage } from "../src/features/qa/project-knowledge-page";

vi.mock("../src/state/auth", () => ({ useAuth: () => ({ user: { userId: "owner-1" } }) }));
vi.mock("../src/state/project", () => ({ useProject: () => ({ currentProject: { projectId: "demo", role: "owner" } }), projectDisplayName: () => "演示项目" }));

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  knowledge: null as unknown,
  tasks: [] as unknown[],
  failEnvironments: false,
}));

vi.mock("../src/features/qa/project-management/api", () => ({
  listEnvironments: async () => { if (state.failEnvironments) throw new Error("环境读取失败"); return { environments: state.environments, defaultEnv: null }; },
  getEnvironmentKnowledge: async () => ({ knowledge: state.knowledge, hypotheses: {} }),
}));

afterEach(async () => { await unmountAll(); state.environments = []; state.knowledge = null; state.tasks = []; state.failEnvironments = false; });

it("shows the system map with counts, coverage and knowledge lists for the default environment (A4)", async () => {
  state.environments = [{ env: "staging", endType: "web", baseUrl: "https://staging.example.com", isDefault: true, status: "registered", pages: { total: 10, registered: 5 }, apis: { total: 4, modules: ["登录", "订单"] }, mapsPath: "kb/staging/map.md", steps: [], revision: 1 }];
  state.knowledge = {
    env: "staging", lastRound: 2,
    counts: { module: 2, flow: 1, wall: 0, interface: 3 },
    layers: { module: [{ layer: "module", key: "登录模块", summary: "账号密码登录", relPath: null, round: 1, sourceSessionId: null, updatedAt: "2026-11-01T00:00:00Z" }, { layer: "module", key: "订单模块", summary: null, relPath: null, round: 2, sourceSessionId: null, updatedAt: "2026-11-02T00:00:00Z" }], flow: [], wall: [], interface: [{ layer: "interface", key: "POST /api/login", summary: "登录接口", relPath: null, round: 1, sourceSessionId: null, updatedAt: "2026-11-01T00:00:00Z" }] },
  };
  await mount(h(SystemMapView, { projectId: "demo" }));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const panel = document.querySelector('[aria-label="系统地图"]');
  expect(panel?.textContent).toContain("页面建档计数");
  expect(panel?.textContent).toContain("50%");
  expect(panel?.textContent).toContain("接口模块");
  expect(panel?.textContent).toContain("登录");
  expect(panel?.textContent).toContain("POST /api/login");
  expect(panel?.textContent).toContain("逐条明细清单接口尚未提供");
});

it("keeps the map honest when nothing was explored or no environment exists (A4)", async () => {
  state.environments = [];
  await mount(h(SystemMapView, { projectId: "demo" }));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector('[aria-label="系统地图"]')?.textContent).toContain("还没有登记环境");
  state.environments = [{ env: "staging", endType: "web", baseUrl: "https://staging.example.com", isDefault: true, status: "unregistered", pages: null, apis: null, mapsPath: null, steps: [], revision: 1 }];
  state.knowledge = { env: "staging", lastRound: 0, counts: { module: 0, flow: 0, wall: 0, interface: 0 }, layers: { module: [], flow: [], wall: [], interface: [] } };
  await unmountAll();
  await mount(h(SystemMapView, { projectId: "demo" }));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector('[aria-label="系统地图"]')?.textContent).toContain("还没有探索记录");
});

vi.mock("../src/api/client", () => ({
  ApiError: class ApiError extends Error { status = 0; code = "test"; },
  apiFetch: async (path: string) => {
    if (path.endsWith("/overview")) return { tasks: state.tasks };
    throw new Error(`unexpected path ${path}`);
  },
}));

it("lists the run archive read-only with run id, task, counts and artifact downloads (A5)", async () => {
  state.tasks = [{
    session: { sessionId: "session-a", title: "会员任务" },
    runs: [
      { id: "run-2", status: "completed", caseCount: 5, defectCount: 2, artifacts: [{ path: "output/runs/run-2/report/report.html", category: "reports" }] },
      { id: "run-1", status: "failed", caseCount: 3, defectCount: 0, artifacts: [] },
    ],
  }];
  await mount(h(RunArchiveView, { projectId: "demo" }));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const table = document.querySelector('[aria-label="历史档案"]');
  expect(table?.textContent).toContain("run-2");
  expect(table?.textContent).toContain("run-1");
  expect(table?.textContent).toContain("会员任务");
  expect(table?.textContent).toContain("report.html");
  const link = table?.querySelector("a") as HTMLAnchorElement | null;
  expect(link?.getAttribute("href")).toContain("/api/sessions/session-a/files/content");
  expect(link?.getAttribute("download")).toBe("");
  expect(table?.textContent).toContain("无可下载产物");
});

it("shows the archive empty state without inventing runs (A5)", async () => {
  state.tasks = [];
  await mount(h(RunArchiveView, { projectId: "demo" }));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector('[aria-label="历史档案"]')?.textContent).toContain("还没有已登记的测试运行产物");
});

it("exposes the system map and run archive tabs on the standalone knowledge page (A4/A5)", async () => {
  await mount(h(ProjectKnowledgePage));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const tabLabels = [...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent);
  expect(tabLabels).toContain("系统地图");
  expect(tabLabels).toContain("历史档案");
  await click([...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === "系统地图") as HTMLButtonElement);
  expect(document.querySelector('[aria-label="系统地图"]')?.textContent).toContain("还没有登记环境");
  await click([...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === "历史档案") as HTMLButtonElement);
  expect(document.querySelector('[aria-label="历史档案"]')).not.toBeNull();
});
