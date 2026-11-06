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
const toggle = (index: number) => rows()[index]?.querySelector(".qp-task-toggle") as HTMLButtonElement;
const select = async (label: string, value: string) => run(() => {
  const el = document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  el.value = value; el.dispatchEvent(new Event("change", {bubbles: true}));
});
async function start() {
  state.tasks = Array.from({length: 45}, (_, i) => ({ session: {sessionId: `task-${i}`, title: `任务 ${i}`, agentId: "test_agent", status: i < 5 ? "running" : "idle", workspace: "/demo", lastActiveAt: "2026-10-27T00:00:00Z"}, runs: [{id: `run-${i}`, status: "completed", stages: [], artifacts: [], caseCount: 1, cases: [{id: `case-${i}`, title: `用例 ${i}`, type: "Web", status: "passed"}], defectCount: 0, defects: []}], unavailable: 0, truncated: false }));
  return mount(h(QaProjectView));
}
it("paginates task cards without duplicate or missing tasks and clamps the last page", async () => {
  await start();
  expect(rows()).toHaveLength(20);
  expect(button("上一页").disabled).toBe(true);
  await click(button("下一页"));
  expect(rows()[0]?.textContent).toContain("任务 20");
  expect(document.querySelector(".qp-view-toggle")).toBeNull();
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
  expect(document.querySelectorAll(".qp-record-table tbody tr")).toHaveLength(10);
  expect(document.querySelectorAll(".qp-record-table tbody tr")).toHaveLength(10);
  expect(document.querySelector(".qp-record-table tbody")?.textContent).toContain("case-0");
  await click(button("末页")); expect(document.querySelectorAll(".qp-record-table tbody tr")).toHaveLength(5);
  await select("每页条数", "50"); expect(document.querySelectorAll(".qp-record-table tbody tr")).toHaveLength(45);
});
it("expands one task at a time, shows its own stages and supports keyboard activation", async () => {
  state.tasks = [
    { session: {sessionId: "task-current", title: "当前任务", agentId: "test_agent", status: "idle", workspace: "/demo", lastActiveAt: "2026-10-27T00:00:00Z"}, runs: [
      {id: "run-latest", status: "in_progress", stages: [{id: "analysis", status: "completed"}], artifacts: []},
      {id: "run-older", status: "completed", stages: [{id: "analysis", status: "failed"}], artifacts: []}], unavailable: 0, truncated: false },
    { session: {sessionId: "task-new", title: "新任务", agentId: "test_agent", status: "idle", workspace: "/demo", lastActiveAt: "2026-10-27T00:00:00Z"}, runs: [], unavailable: 0, truncated: false },
  ];
  await mount(h(QaProjectView));
  expect(document.querySelectorAll(".qp-expansion")).toHaveLength(0);
  await click(toggle(0));
  expect(toggle(0).getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".qp-expansion")?.textContent).toContain("需求分析");
  expect(document.querySelector(".qp-expansion")?.textContent).not.toContain("失败");
  expect(document.querySelector(".qp-expansion")?.textContent).not.toContain("测试点评审");
  expect(document.querySelector(".qp-expansion")?.textContent).toContain("自动化执行");
  expect(document.querySelectorAll(".qp-timeline-child")).toHaveLength(4);
  await run(() => toggle(1).click());
  expect(toggle(0).getAttribute("aria-expanded")).toBe("false");
  expect(toggle(1).getAttribute("aria-expanded")).toBe("true");
  expect(rows()[0]?.getAttribute("role")).toBeNull();
  expect(toggle(1).getAttribute("aria-controls")).toBe("qp-task-expansion-task-new");
  expect(document.querySelector(".qp-expansion")?.textContent).toContain("该任务尚未开始执行");
});
it("expands from the card body while action buttons keep their own behavior", async () => {
  await start();
  const card = rows()[0] as HTMLElement;
  await click(card.querySelector(".qp-task-bottom") as HTMLElement);
  expect(toggle(0).getAttribute("aria-expanded")).toBe("true");
  await click(card.querySelector(".qp-detail-action") as HTMLButtonElement);
  expect(toggle(0).getAttribute("aria-expanded")).toBe("true");
  await click(card.querySelector(".qp-source") as HTMLButtonElement);
  expect(toggle(0).getAttribute("aria-expanded")).toBe("true");
  await click(card.querySelector(".qp-run-chip") as HTMLElement);
  expect(toggle(0).getAttribute("aria-expanded")).toBe("false");
});
it("lists case and defect records across tasks with consistent summary counts", async () => {
  state.tasks = [0, 1].map(i => ({session:{sessionId:`task-${i}`,title:`任务 ${i}`,agentId:"test_agent",status:"idle",workspace:"/demo",createdAt:"2026-11-03T08:01:02Z",lastActiveAt:"2026-11-03T08:01:02Z"},runs:[{id:`run-${i}`,status:"completed",stages:[],artifacts:[],caseCount:1,cases:[{id:`C-${i}`,title:`用例 ${i}`,type:"Web",status:"passed"}],defectCount:1,defects:[{id:`D-${i}`,title:`缺陷 ${i}`,severity:"严重",source:"execution"}]}],unavailable:0,truncated:false}));
  await mount(h(QaProjectView));
  expect(document.querySelector(".qp-stats")?.textContent).toContain("用例数量");
  expect(document.querySelector(".qp-stats")?.textContent).toContain("缺陷数量");
  await click(document.querySelector('[role="tablist"] button:nth-child(2)') as HTMLButtonElement);
  expect(document.querySelectorAll(".qp-record-table tbody tr")).toHaveLength(2);
  expect(document.querySelector(".qp-record-table tbody")?.textContent).toContain("C-1");
  await click(document.querySelector('[role="tablist"] button:nth-child(3)') as HTMLButtonElement);
  expect(document.querySelectorAll(".qp-record-table tbody tr")).toHaveLength(2);
  expect(document.querySelector(".qp-record-table tbody")?.textContent).toContain("D-0");
  expect(document.querySelector(".qp-tabs")?.textContent).toContain("缺陷清单");
  expect(document.querySelector(".qp-tabs")?.textContent).not.toContain("缺陷产物");
  expect(document.querySelector(".qp-record-table tbody button")?.textContent).toBe("查看");
});
it("mounts project record dialogs at document level so the project scroller cannot clip the overlay",async()=>{
  state.tasks=[{session:{sessionId:"task-a",title:"任务 A",agentId:"test_agent",status:"idle",workspace:"/demo"},runs:[{id:"run-a",status:"completed",stages:[],artifacts:[],caseCount:1,cases:[{id:"C-1",title:"登录",type:"Web",status:"不通过",results:[]}]}],unavailable:0,truncated:false}];
  await mount(h(QaProjectView));
  await click(document.querySelector('[role="tablist"] button:nth-child(2)') as HTMLButtonElement);
  await click(document.querySelector('.qp-record-table tbody button') as HTMLButtonElement);
  expect(document.body.lastElementChild?.classList.contains("qp-project-mask")).toBe(true);
  expect(document.querySelector('.qp-project-mask [role="dialog"]')).not.toBeNull();
});
it("groups execution types under automation and shows unselected types as excluded", async () => {
  state.tasks = [{session:{sessionId:"app-task",title:"应用任务",agentId:"test_agent",status:"idle",workspace:"/demo",lastActiveAt:"2026-11-03T08:01:02Z"},runs:[{id:"run-app",status:"in_progress",executionPlatform:"android",stages:[{id:"analysis",status:"completed"},{id:"execution",status:"in_progress"}],artifacts:[]}],unavailable:0,truncated:false}];
  await mount(h(QaProjectView));
  await click(toggle(0));
  const children = [...document.querySelectorAll(".qp-timeline-child")];
  expect(children.map(row => row.textContent)).toEqual(["Web 自动化未纳入","接口自动化未纳入","App 自动化执行中","小程序自动化未纳入"]);
  expect(document.querySelector(".qp-expansion")?.textContent).not.toContain("测试用例评审");
  expect(document.querySelector(".qp-expansion-main")?.classList.contains("qp-expansion-main")).toBe(true);
});
