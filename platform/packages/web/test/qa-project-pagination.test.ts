// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click, button, run, type } from "./helpers/dom";
import { QaProjectView } from "../src/features/qa/project-view";

const state = vi.hoisted(() => ({ projectId: "demo", tasks: [] as any[] }));
vi.mock("../src/state/auth", () => ({ useAuth: () => ({ user: { userId: "tester" } }) }));
vi.mock("../src/state/project", () => ({ useProject: () => ({ currentProject: { projectId: state.projectId }, agents: [{agentId: "test_agent"}], setCurrentAgentId: vi.fn() }), projectDisplayName: () => "测试项目" }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../src/api/client", () => ({ apiFetch: async () => ({projectId: state.projectId, tasks: state.tasks}) }));
vi.mock("../src/features/qa/project-entry", () => ({ QaProjectEntry: () => null }));

afterEach(async () => { await unmountAll(); localStorage.clear(); state.projectId = "demo"; });
const rows = () => [...document.querySelectorAll(".qp-task")];
const select = async (label: string, value: string) => run(() => {
  const el = document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  el.value = value; el.dispatchEvent(new Event("change", {bubbles: true}));
});
async function start() {
  state.tasks = Array.from({length: 45}, (_, i) => ({ session: {sessionId: `task-${i}`, title: `任务 ${i}`, agentId: "test_agent", status: i < 5 ? "running" : "idle", workspace: "/demo", lastActiveAt: "2026-10-27T00:00:00Z"}, runs: [{id: `run-${i}`, status: "completed", stages: [], artifacts: [{path: `case-${i}.md`, category: "cases"}]}], unavailable: 0, truncated: false }));
  return mount(h(QaProjectView));
}
it("paginates both views without duplicate or missing tasks and clamps the last page", async () => {
  await start();
  expect(rows()).toHaveLength(20);
  expect(button("上一页").disabled).toBe(true);
  await click(button("下一页"));
  expect(rows()[0]?.textContent).toContain("任务 20");
  await click(button("列表"));
  expect(rows()).toHaveLength(20);
  expect(rows()[0]?.textContent).toContain("任务 20");
  await click(button("末页"));
  expect(rows()).toHaveLength(5);
  expect(button("下一页").disabled).toBe(true);
  state.tasks = state.tasks.slice(0, 3);
  await click(document.querySelector('[aria-label="刷新项目视图"]') as HTMLButtonElement);
  expect(rows()).toHaveLength(3);
  expect(button("上一页").disabled).toBe(true);
});
it("resets page and scroll after filtering and handles empty results", async () => {
  await start(); await click(button("末页"));
  const main = document.querySelector(".qp-scroll") as HTMLElement;
  main.scrollTop = 500;
  await select("筛选状态", "running");
  expect(rows()).toHaveLength(5); expect(main.scrollTop).toBe(0);
  await type(document.querySelector("input")!, "不存在");
  expect(rows()).toHaveLength(0);
  expect(document.querySelector(".qp-pagination")?.textContent).toContain("共 0 条");
  expect(button("下一页").disabled).toBe(true);
});
it("supports page size, direct navigation and independent artifact pagination", async () => {
  await start(); await select("每页条数", "10");
  await select("跳转页码", "3");
  expect(rows()[0]?.textContent).toContain("任务 20");
  await click(document.querySelector('[role="tablist"] button:nth-child(2)') as HTMLButtonElement);
  expect(rows()).toHaveLength(10);
  expect(rows()[0]?.textContent).toContain("case-0.md");
  await click(button("末页")); expect(rows()).toHaveLength(5);
  await select("每页条数", "50"); expect(rows()).toHaveLength(45);
});
