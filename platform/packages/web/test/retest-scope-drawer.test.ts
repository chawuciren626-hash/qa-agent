// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, run, click } from "./helpers/dom";
import { RetestScopeDrawer, retestCandidates } from "../src/features/qa/retest-scope-drawer";

const state = vi.hoisted(() => ({
  tasks: [] as unknown[],
  posted: [] as { url: string; body: unknown }[],
  retestAvailable: false,
}));

vi.mock("../src/api/client", () => ({
  ApiError: class ApiError extends Error { status = 404; code = "not_found"; constructor(message: string) { super(message); } },
  apiFetch: async (url: string, init?: { method?: string; body?: unknown }) => {
    if (url.endsWith("/overview")) return { tasks: state.tasks };
    if (url.endsWith("/retest") && init?.method === "POST") {
      if (!state.retestAvailable) throw new Error("Not Found");
      state.posted.push({ url, body: init.body });
      return { roundNo: 2 };
    }
    throw new Error(`unexpected path ${url}`);
  },
}));

afterEach(async () => { await unmountAll(); state.tasks = []; state.posted = []; state.retestAvailable = false; });

it("collects defect-related cases and P0 smoke subset from validated runs (A6)", () => {
  const { defectCases, smokeCases } = retestCandidates([{
    session: { sessionId: "s1", title: "任务" },
    runs: [
      { id: "run-1", defects: [{ id: "BUG-1", title: "登录失败", detail: { related_cases: ["case-1", "case-2"] } }], cases: [{ id: "case-1", title: "登录", priority: "P0" }, { id: "case-9", title: "列表", priority: "P2" }] },
      { id: "run-2", defects: [{ id: "BUG-2", title: "导出失败", detail: { related_cases: ["case-2", "case-3"] } }], cases: [{ id: "case-3", title: "导出", priority: "P0" }] },
    ],
  }]);
  expect(defectCases).toEqual(["case-1", "case-2", "case-3"]);
  expect(smokeCases.map(item => item.id)).toEqual(["case-1", "case-3"]);
});

it("renders the three scope layers, counts picks and submits the scope (A6)", async () => {
  state.tasks = [{
    session: { sessionId: "s1", title: "任务" },
    runs: [{ id: "run-1", defects: [{ id: "BUG-1", title: "登录失败", detail: { related_cases: ["case-1"] } }], cases: [{ id: "case-1", title: "登录", priority: "P0" }] }],
  }];
  state.retestAvailable = true;
  await mount(h(RetestScopeDrawer, { projectId: "demo", taskId: "task-1", taskTitle: "会员回归", onClose: () => {} }));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const dialog = document.querySelector('[aria-label="发起复测"]');
  expect(dialog?.textContent).toContain("缺陷关联用例");
  expect(dialog?.textContent).toContain("回归影响选集");
  expect(dialog?.textContent).toContain("冒烟子集");
  expect(dialog?.textContent).toContain("regression-impact 分析端点尚未提供");
  const checkboxes = [...dialog!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(checkboxes).toHaveLength(2);
  await click(checkboxes[0]!);
  await click(checkboxes[1]!);
  expect(dialog?.querySelector(".qrs-count")?.textContent).toContain("已选用例 2 条");
  await click([...dialog!.querySelectorAll("footer button")].find(button => button.textContent === "提交复测范围") as HTMLButtonElement);
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(state.posted).toHaveLength(1);
  expect(state.posted[0]?.body).toMatchObject({ scope: { defectCases: ["case-1"], regressionCases: [], smokeCases: ["case-1"] } });
  expect(dialog?.querySelector(".qrs-ok")?.textContent).toContain("复测轮次已创建");
});

it("keeps the failure honest while the retest endpoint is not available yet (A6)", async () => {
  state.tasks = [];
  await mount(h(RetestScopeDrawer, { projectId: "demo", taskId: "task-1", taskTitle: "会员回归", onClose: () => {} }));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const dialog = document.querySelector('[aria-label="发起复测"]');
  expect(dialog?.textContent).toContain("现有缺陷没有登记关联用例");
  expect(dialog?.textContent).toContain("没有登记 P0 用例");
  const submit = [...dialog!.querySelectorAll("footer button")].find(button => button.textContent === "提交复测范围") as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
});
