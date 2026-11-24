// @vitest-environment jsdom
/**
 * 平台任务列表页（/qa/project/platform-tasks）的页面行为。
 *
 * 三件必须成立的事：
 * - 来源双轨渲染：平台/本地徽章区分（T5），TLQ-1 下 pending_analysis 的开始测试禁用；
 * - 新建本地任务：整页表单（/qa/project/platform-tasks/new），测试重点并入描述，保存即创建+发起分析；
 * - 详情抽屉三段式：平台资料/AI 分析结论（标 AI 建议）/测试进展。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { click, mount, settle, type, unmountAll, waitFor } from "./helpers/dom";
import { PlatformTasksPage } from "../src/features/qa/platform-tasks/platform-tasks-page";
import { PlatformTaskCreatePage } from "../src/features/qa/platform-tasks/platform-task-create-page";
import type { TaskDetail, TaskListItem } from "../src/features/qa/platform-tasks/api";

const fixture = vi.hoisted(() => {
  const platformReady: TaskListItem = {
    id: "ptl-1", projectId: "proj-1", source: "platform", taskNo: "FB202611090001", title: "gov 用户端登录优化",
    priority: "high", packageVersion: 3, roundNo: 3,
    productLines: [{ name: "gov 用户端", isPrimary: true }],
    ends: [],
    changeSource: null,
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
    created: [] as Array<Record<string, unknown>>,
    detailCalls: [] as string[],
    analyzeCalls: 0,
  };
  const detail: TaskDetail = {
    task: { ...platformReady, feedbackType: "requirement", estimatedHours: 24, description: null,
      localTitleNote: "", localTestFocusNote: "", localEditedAt: null, createdBy: null,
      envName: null, envBaseUrl: null, account: null },
    summary: {
      requirement_summary: "整理登录页会话保持策略并回归主流程。",
      requirement_points: ["统一登录入口的会话保持策略"],
      suggested_test_scope: ["登录页主流程回归"],
      test_environment: "http://demo.example.com",
      test_account: "qa_tester",
      test_password: "secret-pwd-1",
      suggested_priority: "high",
      priority_reason: "平台优先级=高（演示产出）",
      risks: [], open_questions: [],
      analyzed_at: "2026-11-20T07:00:00.000Z", source: "demo",
    },
    progress: { mainSessionId: null, runs: [] },
  };
  return { state, detail, detailBase: JSON.parse(JSON.stringify(detail)), platformReady, platformPending, localTask };
});

vi.mock("../src/features/qa/platform-tasks/api", () => ({
  // 列表页 2026-11-24 起走跨项目接口（全部项目的任务），不再按当前项目过滤。
  listAllTasks: async () => ({
    items: fixture.state.items,
    counts: fixture.state.counts,
    projectIds: ["proj-1"],
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
  analyzeTask: async () => {
    fixture.state.analyzeCalls += 1;
    return { updated: fixture.platformReady, summary: fixture.detail.summary };
  },
  startTask: async () => ({ task: fixture.platformReady, sessionId: "session-new-1", previousStatus: "ready" }),
  terminateTask: async () => ({ updated: fixture.platformReady }),
  listTaskAttachments: async () => ({ attachments: [] }),
  uploadTaskAttachment: async (_p: string, _t: string, input: Record<string, unknown>) => ({
    attachment: { attachmentId: "att-new", filename: String(input.filename), mime: "text/plain", sizeBytes: 0, createdAt: "" },
    attachments: [],
  }),
  deleteTaskAttachment: async () => ({ removed: true }),
}));

vi.mock("../src/features/qa/project-management/api", () => ({
  listEnvironments: async () => ({
    environments: [{ env: "test", baseUrl: "http://demo.example.com", isDefault: true }],
    defaultEnv: "test",
  }),
}));

vi.mock("../src/state/project", () => ({
  useProject: () => ({
    currentProject: { projectId: "proj-1", name: "会员中心改版回归" },
    setCurrentProjectId: () => undefined,
    projects: [{ projectId: "proj-1", name: "会员中心改版回归", role: "owner", ownerUserId: "u1", createdAt: "" }],
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
  fixture.state.analyzeCalls = 0;
  fixture.detail = JSON.parse(JSON.stringify(fixture.detailBase));
});

async function renderPage() {
  const mounted = await mount(
    h(MemoryRouter, { initialEntries: ["/qa/project/platform-tasks"] },
      h(Routes, null,
        h(Route, { path: "/qa/project/platform-tasks", element: h(PlatformTasksPage) }),
        h(Route, { path: "/qa/project/platform-tasks/new", element: h(PlatformTaskCreatePage) }),
      ),
    ),
  );
  await settle();
  await waitFor(() => mounted.container.querySelector(".qpt-table") !== null);
  return mounted.container;
}

describe("platform tasks page", () => {
  it("空任务列表保持空态，不生成或展示初始化任务", async () => {
    fixture.state.items = [];
    fixture.state.counts = {};
    const mounted = await mount(h(MemoryRouter, {initialEntries:["/qa/project/platform-tasks"]},
      h(Routes,null,h(Route,{path:"/qa/project/platform-tasks",element:h(PlatformTasksPage)}))));
    await waitFor(()=>mounted.container.textContent?.includes("还没有测试任务")===true);
    expect(mounted.container.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(mounted.container.textContent).not.toContain("演示数据");
    expect(fixture.state.created).toEqual([]);
  });
  it("来源双轨渲染：平台/本地徽章、TLQ-1 禁用未分析的开始测试", async () => {
    const root = await renderPage();
    const text = root.textContent ?? "";
    expect(text).not.toContain("演示数据");
    expect(text).toContain("gov 用户端登录优化");
    expect(text).toContain("FB202611090001");
    // 状态筛选改成下拉（原分段计数条取消）：选项里带各状态与计数
    const statusOptions = Array.from(root.querySelectorAll('select[aria-label="按状态筛选"] option')).map((o) => o.textContent ?? "");
    expect(statusOptions.some((t) => t.startsWith("待分析"))).toBe(true);
    // 所属项目列（跨项目列表）
    expect(text).toContain("会员中心改版回归");
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

  it("新建本地任务：整页表单——预填默认环境URL，测试重点并入描述，保存即创建+发起分析", async () => {
    const root = await renderPage();
    const create = Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.includes("新建任务"));
    expect(create).toBeTruthy();
    await click(create!);
    await waitFor(() => root.querySelector('[aria-label="新建测试任务"]') !== null);
    const form = root.querySelector(".qpt-create-form")!;
    // 表单里唯一的 select = 所属项目（优先级不收集，以 AI 建议为准）
    const selects = Array.from(form.querySelectorAll("select"));
    expect(selects).toHaveLength(1);
    expect(selects[0]!.getAttribute("aria-label") ?? "").toBe("");
    expect(Array.from(selects[0]!.querySelectorAll("option")).map((o) => o.textContent)).toContain("会员中心改版回归");
    const textInputs = Array.from(form.querySelectorAll("input[type=text]"));
    const title = textInputs[0]!;
    const envInput = textInputs[1]!;
    // 默认环境地址自动预填（选填可改）
    await waitFor(() => (envInput as HTMLInputElement).value === "http://demo.example.com");
    await type(title, "导入模板边界值回归");
    const areas = Array.from(form.querySelectorAll("textarea"));
    await type(areas[0]!, "批量导入模板的表头校验与边界值回归");
    await type(areas[1]!, "优先验证导入失败的回滚完整性");
    const save = Array.from(form.querySelectorAll("button")).find((b) => b.textContent === "保存并发起 AI 分析")!;
    await click(save);
    await waitFor(() => fixture.state.created.length === 1);
    expect(fixture.state.created[0]).toMatchObject({
      title: "导入模板边界值回归",
      envBaseUrl: "http://demo.example.com",
      account: "",
    });
    expect(String(fixture.state.created[0]?.description ?? "")).toContain("【测试重点】");
    expect(String(fixture.state.created[0]?.description ?? "")).toContain("优先验证导入失败的回滚完整性");
  });

  it("新建校验：需求描述必填（AI 分析主输入）", async () => {
    const root = await renderPage();
    await click(Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.includes("新建任务"))!);
    await waitFor(() => root.querySelector('[aria-label="新建测试任务"]') !== null);
    const form = root.querySelector(".qpt-create-form")!;
    await type(form.querySelectorAll("input[type=text]")[0]!, "只有标题");
    await click(Array.from(form.querySelectorAll("button")).find((b) => b.textContent === "保存并发起 AI 分析")!);
    await settle();
    // 描述为空被拦截：不发起创建，仍留在表单页
    expect(fixture.state.created).toHaveLength(0);
    expect(root.querySelector('[aria-label="新建测试任务"]')).toBeTruthy();
  });

  it("同步 AI 分析：点击即完成并回填结构化结论（无会话、无流程）", async () => {
    const root = await renderPage();
    const pendingRow = root.querySelectorAll("tbody tr")[0]!;
    const analyzeBtn = Array.from(pendingRow.querySelectorAll("button")).find((b) => b.textContent === "重试分析");
    expect(analyzeBtn).toBeTruthy();
    await click(analyzeBtn!);
    await waitFor(() => fixture.state.analyzeCalls === 1, 100);
    // 分析是同步的：不创建会话、不出现「查看会话」入口
    expect(root.textContent).not.toContain("查看会话");
    await settle();
  });

  it("编辑弹窗回显：打开即按任务 id 取回字段（不再出现空白表单）", async () => {
    // 平台任务的补充性字段：详情里有值，弹窗打开时就该看到
    fixture.detail = {
      ...fixture.detail,
      task: { ...fixture.detail.task, localTitleNote: "本地备注：只看登录链路", localTestFocusNote: "重点看会话保持" },
    };
    const root = await renderPage();
    const readyRow = root.querySelectorAll("tbody tr")[1]!;
    await click(Array.from(readyRow.querySelectorAll("button")).find((b) => b.textContent === "编辑")!);
    await waitFor(() => fixture.state.detailCalls.length === 1);
    await waitFor(() => document.body.querySelector(".qpt-modal") !== null);
    const modal = document.body.querySelector(".qpt-modal") as HTMLElement;
    const areas = Array.from(modal!.querySelectorAll("textarea")) as HTMLTextAreaElement[];
    await waitFor(() => areas[0]?.value === "本地备注：只看登录链路");
    expect(areas[0]?.value).toBe("本地备注：只看登录链路");
    expect(areas[1]?.value).toBe("重点看会话保持");
    expect(modal!.textContent).toContain("平台原文（只读）：gov 用户端登录优化");
  });

  it("优先级合并：本地任务用 AI 建议值并标注来源，不再单列 AI 建议", async () => {
    fixture.state.items = [{ ...fixture.localTask, suggestedPriority: "medium" }];
    const root = await renderPage();
    const row = root.querySelectorAll("tbody tr")[0]!;
    expect(row.textContent).not.toContain("AI 建议");
    expect(row.querySelector(".qpt-pri-from")?.textContent).toBe("AI");
    expect(row.querySelector(".qpt-pri")?.textContent).toContain("中");
  });
});
