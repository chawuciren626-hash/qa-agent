// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { mount, unmountAll, click, run } from "./helpers/dom";
import { QaTaskDetail } from "../src/features/qa/task-detail";

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
  return { calls: [] as string[], navigate: vi.fn(), noRuns: false, defaultTrace, trace: defaultTrace };
});
vi.mock("react-router", () => ({ useParams: () => ({ sessionId: "session-a" }), useNavigate: () => state.navigate }));
vi.mock("../src/state/project", () => ({ useProject: () => ({ currentProject: { projectId: "demo", role: "owner" }, setCurrentAgentId: vi.fn() }) }));
vi.mock("../src/state/auth", () => ({ useAuth: () => ({ previewIsolated: true }) }));
vi.mock("../src/api/client", () => ({
  ApiError: class ApiError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } },
  apiFetch: async (path: string) => {
  state.calls.push(path);
  if (path.endsWith("/overview")) return { tasks: [{ session: { sessionId: "session-a", title: "会员测试", agentId: "test_agent" }, runs: state.noRuns ? [] : [{ id: "run-one", status: "awaiting_confirmation" }] }] };
  if (path.endsWith("/trace")) return state.trace;
  return { runId: "run-one", status: "awaiting_confirmation", workflowMode: "lifecycle", reviewMode: "staged", executionPlatform: "web",
    stages: [{ id: "analysis", status: "awaiting_confirmation", agent: "requirement_analysis_agent", reason: "", revisionId: "", summary: "已完成需求分析", questions: ["规则待确认"], limitations: [], pendingConfirmationId: "confirm-1", history: [{ status: "pending", reason: "", at: "2026-11-02T00:00:00Z" }] }],
    artifacts: [{ path: "output/runs/run-one/analysis/requirement_analysis.md", name: "requirement_analysis.md", stage: "analysis", type: "文档", size: 128, available: true, verified: true }] };
} }));
afterEach(async () => { await unmountAll(); vi.unstubAllGlobals(); state.calls.length = 0; state.navigate.mockReset(); state.noRuns = false; state.trace = state.defaultTrace; });
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
it("raises the stalled trace card with its evidence and does not offer auto-rerun", async () => {
  const ex = { invocationId: "attempt-a", startedAt: "2026-11-19T03:02:40Z", finishedAt: null, phase: "playwright", state: "running", lastActivityAt: "2026-11-19T03:07:03Z", attempts: 0, locked: true, orphaned: true, pidStatus: "dead", blockReason: null };
  state.trace = { registered: true, trace: { runId: "run-one", present: true, manifest: { status: "in_progress", manifestVersion: 1, baselineHash: null, sha256: "4b10c02d" }, execution: ex, dispatch: { dispatchedAt: "2026-11-19T03:02:11Z", sessionId: "session-a", host: "work-1", ownerPid: 18344 }, startedAt: "2026-11-19T03:02:40Z", stalled: true, stalledReason: "锁在而持锁进程已退出", staleAfterMs: 1800000 } };
  await mount(h(QaTaskDetail));
  await run(async () => {});
  const card = document.querySelector("details.qtr") as HTMLDetailsElement | null;
  expect(card).not.toBeNull();
  // 默认展开（alertive），红条与证据可见。
  expect(card?.open).toBe(true);
  expect(card?.querySelector(".qtr-alert-red")).not.toBeNull();
  expect(card?.textContent).toContain("执行锁未释放且持锁进程已退出");
  expect(card?.textContent).toContain("不要自动续跑");
  expect(card?.textContent).toContain("没有正常收尾");
  expect(card?.textContent).toContain("stalled = true");
  expect(card?.textContent).toContain("已退出");
  expect(card?.textContent).toContain("dispatch.json");
  // 本卡只读：没有"重新发起 / 标记已处置"这类假按钮。
  expect(card?.textContent).not.toContain("重新发起");
  expect(card?.textContent).not.toContain("标记已人工处置");
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
