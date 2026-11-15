// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click, run } from "./helpers/dom";
import { QaTaskDetail } from "../src/features/qa/task-detail";

const state = vi.hoisted(() => ({ calls: [] as string[], navigate: vi.fn(), noRuns: false }));
vi.mock("react-router", () => ({ useParams: () => ({ sessionId: "session-a" }), useNavigate: () => state.navigate }));
vi.mock("../src/state/project", () => ({ useProject: () => ({ currentProject: { projectId: "demo", role: "owner" }, setCurrentAgentId: vi.fn() }) }));
vi.mock("../src/state/auth", () => ({ useAuth: () => ({ previewIsolated: true }) }));
vi.mock("../src/api/client", () => ({ apiFetch: async (path: string) => {
  state.calls.push(path);
  if (path.endsWith("/overview")) return { tasks: [{ session: { sessionId: "session-a", title: "会员测试", agentId: "test_agent" }, runs: state.noRuns ? [] : [{ id: "run-one", status: "awaiting_confirmation" }] }] };
  return { runId: "run-one", status: "awaiting_confirmation", workflowMode: "lifecycle", reviewMode: "staged", executionPlatform: "web",
    stages: [{ id: "analysis", status: "awaiting_confirmation", agent: "requirement_analysis_agent", reason: "", revisionId: "", summary: "已完成需求分析", questions: ["规则待确认"], limitations: [], pendingConfirmationId: "confirm-1", history: [{ status: "pending", reason: "", at: "2026-11-02T00:00:00Z" }] }],
    artifacts: [{ path: "output/runs/run-one/analysis/requirement_analysis.md", name: "requirement_analysis.md", stage: "analysis", type: "文档", size: 128, available: true, verified: true }] };
} }));
afterEach(async () => { await unmountAll(); vi.unstubAllGlobals(); state.calls.length = 0; state.navigate.mockReset(); state.noRuns = false; });
it("opens an owned run with only its recorded stage, summary, artifact and review history", async () => {
  await mount(h(QaTaskDetail));
  await run(() => {});
  expect(document.body.textContent).toContain("会员测试");
  expect(document.body.textContent).toContain("规则待确认");
  expect(document.body.textContent).toContain("requirement_analysis.md");
  expect(document.body.textContent).toContain("审阅历史");
  expect(document.querySelector(".qtd-history")?.textContent).toContain("待审核");
  expect(document.querySelector(".qtd-history")?.textContent).not.toContain("pending");
  expect(document.querySelectorAll(".qtd-step")).toHaveLength(1);
  expect(document.body.textContent).not.toContain("1128");
  await click(document.querySelector('[aria-label="返回项目视图"]') as HTMLButtonElement);
  expect(state.navigate).toHaveBeenCalledWith("/qa/project");
});
it("shows default stages without claiming a run exists", async () => {
  state.noRuns = true;
  await mount(h(QaTaskDetail));
  await run(() => {});
  expect(document.querySelectorAll('[aria-label="默认流程阶段"] .qtd-step')).toHaveLength(7);
  expect(document.body.textContent).toContain("默认阶段示意");
  expect(document.body.textContent).toContain("未开始");
  expect(document.querySelector('[aria-label="选择运行"]')).toBeNull();
});
it("shows verified Markdown in results and keeps the artifact table in its own tab", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("# 分析原文\n\n这是阶段结论。", { status: 200 })));
  await mount(h(QaTaskDetail));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.querySelector('[aria-label="阶段分析原文"]')?.textContent).toContain("这是阶段结论");
  expect(document.querySelector(".qtd-table-wrap")).toBeNull();
  await click([...document.querySelectorAll('[role="tab"]')].find(node => node.textContent === "阶段产物") as HTMLButtonElement);
  expect(document.querySelector(".qtd-table-wrap")?.textContent).toContain("requirement_analysis.md");
  expect(document.querySelector(".qtd-stage-toolbar .qtd-artifact-filter select")).not.toBeNull();
  expect(document.querySelector(".qtd-tools")).toBeNull();
  expect(document.querySelector(".qtd-table-wrap th")?.textContent).toBe("产物名称");
  expect(document.querySelector('[aria-label="选择运行"]')).toBeNull();
  expect(document.body.textContent).not.toContain("完整流程 · 自动运行");
});
it("keeps review controls in the fixed stage header and opens feedback above the scroll area", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("# 分析原文\n\n## 规则一\n\n**风险**\n\n高\n\n## 规则二\n\n内容", { status: 200 })));
  await mount(h(QaTaskDetail));
  await run(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.querySelector(".qtd-panel-head .qtd-review-actions")?.textContent).toContain("确认当前版本并继续");
  expect(document.querySelector(".qtd-panel-body .qtd-review-actions")).toBeNull();
  expect(document.querySelectorAll(".qtd-markdown-section-2")).toHaveLength(2);
  expect(document.querySelector(".qtd-markdown")?.textContent).toContain("风险： 高");
  await click([...document.querySelectorAll(".qtd-review-actions button")].find(button => button.textContent === "有疑问或需要修改") as HTMLButtonElement);
  expect(document.querySelector(".qtd-panel > .qtd-feedback textarea")).not.toBeNull();
});
