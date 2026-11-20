// @vitest-environment jsdom
/**
 * 平台任务列表页（/qa/project/platform-tasks）的页面行为。
 *
 * 三件必须成立的事：
 * - 来源双轨渲染：平台/本地徽章区分（T5），TLQ-1 下 pending_analysis 的开始测试禁用；
 * - 新建本地任务：弹窗三字段，保存后列表出现新条目；
 * - 详情抽屉三段式：平台资料/AI 分析结论（标 AI 建议）/测试进展。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { click, mount, settle, type, unmountAll, waitFor } from "./helpers/dom";
import { PlatformTasksPage } from "../src/features/qa/platform-tasks/platform-tasks-page";
import type { TaskDetail, TaskListItem } from "../src/features/qa/platform-tasks/api";

const fixture = vi.hoisted(() => {
  const platformReady: TaskListItem = {
    id: "ptl-1", source: "platform", taskNo: "FB202611090001", title: "gov 用户端登录优化",
    priority: "high", packageVersion: 3, roundNo: 3,
    productLines: [{ name: "gov 用户端", isPrimary: true }],
    suggestedPriority: "high", analysisSource: "demo", status: "ready", edited: false,
    mainSessionId: null, sourceUrl: "https://platform.example.com/tasks/active?taskId=FB202611090001",
    updatedAt: "2026-11-20T07:00:00.000Z",
  };
  const platformPending: TaskListItem = {
    ...platformReady, id: "ptl-2", taskNo: "FB202611020002", title: "淘宝渠道 API Key 管理页",
    priority: "medium", packageVersion: 1, roundNo: 1, suggestedPriority: null,
    analysisSource: null, status: "pending_analysis", updatedAt: "2026-11-20T06:00:00.000Z",
  };
  const localTask: TaskListItem = {
    ...platformReady, id: "qlt-1", source: "local", taskNo: "qlt-1", title: "登录页错误提示文案核对",
    priority: "low", packageVersion: null, roundNo: null, productLines: [],
    suggestedPriority: null, analysisSource: null, status: "ready", edited: false, sourceUrl: "",
    updatedAt: "2026-11-20T05:00:00.000Z",
  };
  const state = {
    items: [platformPending, platformReady, localTask] as TaskListItem[],
    counts: { pending_analysis: 1, ready: 2 } as Record<string, number>,
    demoSeeded: true,
    created: [] as Array<Record<string, unknown>>,
    detailCalls: [] as string[],
  };
  const detail: TaskDetail = {
    task: { ...platformReady, feedbackType: "requirement", estimatedHours: 24, description: null,
      localTitleNote: "", localTestFocusNote: "", localEditedAt: null, createdBy: null },
    summary: {
      requirement_points: ["统一登录入口的会话保持策略"],
      suggested_test_scope: ["登录页主流程回归"],
      suggested_priority: "high",
      priority_reason: "平台优先级=高（演示产出）",
      risks: [], open_questions: [],
      analyzed_at: "2026-11-20T07:00:00.000Z", source: "demo",
    },
    progress: { mainSessionId: null, runs: [] },
  };
  return { state, detail, platformReady, platformPending, localTask };
});

vi.mock("../src/features/qa/platform-tasks/api", () => ({
  listTasks: async () => ({
    items: fixture.state.items,
    counts: fixture.state.counts,
    demoSeeded: fixture.state.demoSeeded,
  }),
  getTaskDetail: async (_projectId: string, taskId: string) => {
    fixture.state.detailCalls.push(taskId);
    return fixture.detail;
  },
  createLocalTask: async (_p: string, input: Record<string, unknown>) => {
    fixture.state.created.push(input);
    const task = { ...fixture.localTask, id: "qlt-new", title: String(input.title), priority: input.priority };
    fixture.state.items = [task as TaskListItem, ...fixture.state.items];
    return { task };
  },
  editTask: async () => ({ updated: fixture.platformReady, analysisStale: false }),
  analyzeTask: async () => ({ updated: fixture.platformReady, summary: fixture.detail.summary }),
  startTask: async () => ({ task: fixture.platformReady, sessionId: "session-new-1", previousStatus: "ready" }),
  terminateTask: async () => ({ updated: fixture.platformReady }),
}));

vi.mock("../src/state/project", () => ({
  useProject: () => ({
    currentProject: { projectId: "proj-1", name: "会员中心改版回归" },
    setCurrentProjectId: () => undefined,
    projects: [],
    reloadProjects: async () => undefined,
  }),
  projectDisplayName: (p: { name?: string; projectId: string }) => p.name ?? p.projectId,
}));

afterEach(async () => {
  await unmountAll();
  fixture.state.items = [fixture.platformPending, fixture.platformReady, fixture.localTask];
  fixture.state.counts = { pending_analysis: 1, ready: 2 };
  fixture.state.created = [];
  fixture.state.detailCalls = [];
});

async function renderPage() {
  const mounted = await mount(
    h(MemoryRouter, { initialEntries: ["/qa/project/platform-tasks"] },
      h(Routes, null,
        h(Route, { path: "/qa/project/platform-tasks", element: h(PlatformTasksPage) }),
      ),
    ),
  );
  await settle();
  await waitFor(() => mounted.container.querySelector(".qpt-table") !== null);
  return mounted.container;
}

describe("platform tasks page", () => {
  it("来源双轨渲染：平台/本地徽章、TLQ-1 禁用未分析的开始测试、演示数据标注", async () => {
    const root = await renderPage();
    const text = root.textContent ?? "";
    expect(text).toContain("演示数据");
    expect(text).toContain("gov 用户端登录优化");
    expect(text).toContain("FB202611090001");
    // 状态分段计数条
    expect(text).toContain("待分析1");
    // 状态 pill
    expect(root.querySelector(".qpt-st-pending_analysis")?.textContent).toBe("待分析");
    // pending_analysis 行的开始测试禁用（TLQ-1）
    const pendingRow = root.querySelectorAll("tbody tr")[0];
    expect(pendingRow?.textContent).toContain("淘宝渠道");
    const disabled = Array.from(pendingRow?.querySelectorAll("button[disabled]") ?? []);
    expect(disabled.some((b) => b.textContent === "开始测试")).toBe(true);
    // ready 平台行有可用的开始测试
    const readyRow = root.querySelectorAll("tbody tr")[1];
    expect(readyRow?.textContent).toContain("gov 用户端登录优化");
    const readyButtons = Array.from(readyRow?.querySelectorAll("button") ?? []);
    expect(readyButtons.some((b) => b.textContent === "开始测试" && !b.disabled)).toBe(true);
    // 本地任务徽章
    const localRow = root.querySelectorAll("tbody tr")[2];
    expect(localRow?.querySelector(".qpt-src-local")?.textContent).toBe("本地");
  });

  it("新建本地任务：弹窗三字段，保存后列表出现新条目", async () => {
    const root = await renderPage();
    const create = Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.includes("新建任务"));
    expect(create).toBeTruthy();
    await click(create!);
    await waitFor(() => root.querySelector(".qpt-modal") !== null);
    const modal = root.querySelector(".qpt-modal")!;
    expect(modal.textContent).toContain("新建本地任务");
    const title = modal.querySelector("input[type=text]")!;
    await type(title, "导入模板边界值回归");
    const save = Array.from(modal.querySelectorAll("button")).find((b) => b.textContent === "保存")!;
    await click(save);
    await waitFor(() => fixture.state.created.length === 1);
    expect(fixture.state.created[0]).toMatchObject({ title: "导入模板边界值回归", priority: "medium" });
  });

  it("详情抽屉三段式：查看后渲染 AI 分析结论段并标注 AI 建议", async () => {
    const root = await renderPage();
    const readyRow = root.querySelectorAll("tbody tr")[1]!;
    const view = Array.from(readyRow.querySelectorAll("button")).find((b) => b.textContent === "查看")!;
    await click(view);
    await waitFor(() => root.querySelector(".qpt-drawer") !== null);
    await waitFor(() => fixture.state.detailCalls.length === 1);
    const drawer = root.querySelector(".qpt-drawer")!;
    const text = drawer.textContent ?? "";
    expect(text).toContain("平台资料");
    expect(text).toContain("AI 分析结论");
    expect(text).toContain("AI 建议");
    expect(text).toContain("统一登录入口的会话保持策略");
    expect(text).toContain("建议测试范围");
    expect(text).toContain("测试进展");
    // 平台深链（TLQ-5）
    expect(drawer.querySelector(".qpt-deeplink a")?.getAttribute("href")).toContain("FB202611090001");
  });
});
