// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click, run } from "./helpers/dom";
import { QaTaskDetail, attemptGroups } from "../src/features/qa/task-detail";

const state = vi.hoisted(() => {
  const defaultTrace: {
    registered: boolean;
    trace: { runId: string; present: boolean; manifest: { status: string; manifestVersion: number; baselineHash: string | null; sha256: string } | null;
      execution: { invocationId: string | null; startedAt: string | null; finishedAt: string | null; phase: string | null; state: string | null; lastActivityAt: string | null; attempts: number; locked: boolean; orphaned: boolean; pidStatus: string; blockReason: string | null };
      dispatch: { dispatchedAt: string | null; sessionId: string | null; host: string | null; ownerPid: number | null } | null;
      startedAt: string | null; stalled: boolean; stalledReason: string | null; staleAfterMs: number };
  } = {
    registered: true,
    trace: { runId: "run-one", present: true, manifest: { status: "completed", manifestVersion: 1, baselineHash: null, sha256: "9f3ca71e" },
      execution: { invocationId: "attempt-1", startedAt: "2026-11-19T01:58:20Z", finishedAt: "2026-11-19T02:06:32Z", phase: "finished", state: "completed", lastActivityAt: "2026-11-19T02:06:32Z", attempts: 1, locked: false, orphaned: false, pidStatus: "unknown", blockReason: null },
      dispatch: null, startedAt: "2026-11-19T01:58:20Z", stalled: false, stalledReason: null, staleAfterMs: 1800000 }
  };
  // A1：0=默认单条运行；1=后端已登记 attempt（分组展示）；2=多条运行但 attempt 未登记（平铺兜底）
  return { calls: [] as string[], navigate: vi.fn(), noRuns: false, attemptRuns: 0, defaultTrace, trace: defaultTrace };
});
vi.mock("react-router", () => ({ useParams: () => ({ sessionId: "session-a" }), useNavigate: () => state.navigate }));
vi.mock("../src/state/project", () => ({ useProject: () => ({ currentProject: { projectId: "demo", role: "owner" }, setCurrentAgentId: vi.fn() }) }));
vi.mock("../src/state/auth", () => ({ useAuth: () => ({ previewIsolated: true }) }));
vi.mock("../src/api/client", () => ({
  ApiError: class ApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } },
  apiFetch: async (path: string) => {
  state.calls.push(path);
  if (path.endsWith("/overview")) return { tasks: [{ session: { sessionId: "session-a", title: "会员测试", agentId: "test_agent" }, runs: state.noRuns ? [] : state.attemptRuns === 1 ? [{ id: "run-one", status: "confirmed", attempt: 1 }, { id: "run-two", status: "awaiting_confirmation", attempt: 2 }] : state.attemptRuns === 2 ? [{ id: "run-one", status: "confirmed" }, { id: "run-two", status: "awaiting_confirmation" }] : [{ id: "run-one", status: "awaiting_confirmation" }] }] };
  if (path.endsWith("/trace")) return state.trace;
  return { runId: "run-one", status: "awaiting_confirmation", workflowMode: "lifecycle", reviewMode: "staged", executionPlatform: "web",
    stages: [{ id: "analysis", status: "awaiting_confirmation", agent: "requirement_analysis_agent", reason: "", revisionId: "", summary: "已完成需求分析", questions: ["规则待确认"], limitations: [], pendingConfirmationId: "confirm-1", history: [{ status: "pending", reason: "", at: "2026-11-02T00:00:00Z" }] }],
    artifacts: [{ path: "output/runs/run-one/analysis/requirement_analysis.md", name: "requirement_analysis.md", stage: "analysis", type: "文档", size: 128, available: true, verified: true }] };
} }));
afterEach(async () => { await unmountAll(); vi.unstubAllGlobals(); state.calls.length = 0; state.navigate.mockReset(); state.noRuns = false; state.attemptRuns = 0; state.trace = state.defaultTrace; });
it("attemptGroups labels rounds and revisions, and falls back flat without attempt data (A1)", () => {
  expect(attemptGroups([{ id: "run-b", status: "confirmed", attempt: 2 }, { id: "run-a", status: "confirmed", attempt: 1 }, { id: "run-c", status: "confirmed", attempt: 2 }])).toEqual([
    { label: "第 1 轮", runs: [{ id: "run-a", status: "confirmed", attempt: 1 }] },
    { label: "修订 v2", runs: [{ id: "run-b", status: "confirmed", attempt: 2 }, { id: "run-c", status: "confirmed", attempt: 2 }] },
  ]);
  expect(attemptGroups([{ id: "run-a", status: "confirmed" }, { id: "run-b", status: "confirmed" }])).toEqual([
    { label: "运行记录", runs: [{ id: "run-a", status: "confirmed" }, { id: "run-b", status: "confirmed" }] },
  ]);
  expect(attemptGroups([])).toEqual([]);
});
it("groups the run list by revision attempt when the backend records it (A1)", async () => {
  state.attemptRuns = 1;
  await mount(h(QaTaskDetail));
  await run(() => {});
  const select = document.querySelector('[aria-label="选择任务运行"]') as HTMLSelectElement | null;
  expect(select).not.toBeNull();
  const groups = [...select!.querySelectorAll("optgroup")];
  expect(groups.map(group => group.label)).toEqual(["第 1 轮", "修订 v2"]);
  expect(groups[0]?.querySelector("option")?.value).toBe("run-one");
  expect(groups[1]?.querySelector("option")?.value).toBe("run-two");
  expect(document.querySelector(".qtd-runbar-hint")).toBeNull();
});
it("keeps a flat fallback while attempts are not registered (A1)", async () => {
  state.attemptRuns = 2;
  await mount(h(QaTaskDetail));
  await run(() => {});
  const select = document.querySelector('[aria-label="选择任务运行"]') as HTMLSelectElement | null;
  expect([...(select?.querySelectorAll("optgroup") ?? [])].map(group => group.label)).toEqual(["运行记录"]);
  // 2026-11-24：顶部证据区（含「修订轮次信息尚未登记」提示条）整块移除，改动后不再有 runbar。
  expect(document.querySelector(".qtd-runbar")).toBeNull();
  expect(document.querySelector(".qtd-runbar-hint")).toBeNull();
});
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
  // main 上即为存量失败：api_execution 已并入"测试执行"展示，默认流程是 6 个阶段（旧断言仍期望 7）
  expect(document.querySelectorAll('[aria-label="默认流程阶段"] .qtd-step')).toHaveLength(6);
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
