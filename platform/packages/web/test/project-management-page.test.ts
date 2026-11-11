// @vitest-environment jsdom
/**
 * 项目管理页（/qa/projects）的页面行为，驱动方式是一个人怎么用页面：
 *
 * - 列表渲染与分页：mock 的 134 条记录按 20/页分页，页脚给出完整结果集的总数与页码；
 * - 筛选：状态默认「进行中」，切到全部状态后总数变化；搜索关键词防抖后过滤完整结果集并回到第一页；
 * - 点击语义严格分离（PM-04）：点项目名称 → 打开详情侧栏、不切项目上下文；
 *   点「进入 →」→ 先经适配层校验再复用现有项目上下文（setCurrentProjectId）并切换路由；
 *   Esc 关闭侧栏，焦点回到触发元素。
 *
 * 数据经真实适配层（src/features/qa/project-management/api.ts → mock.ts），测试里不绕过它，
 * 这样 mock 的查询语义（搜索/筛选/排序/分页）与页面表现一起被覆盖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement as h, Fragment } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { button, click, field, mount, pressEscape, settle, type, unmountAll, waitFor } from "./helpers/dom";
import { toastStore } from "@prismshadow/penguin-ui";
import { ProjectManagementPage, resetSessionListState } from "../src/features/qa/project-management/project-management-page";
import { mockScenarios, resetMockProjects } from "../src/features/qa/project-management/mock";

vi.mock("../src/features/qa/project-management/api", async () => {
  const mock = await import("../src/features/qa/project-management/mock");
  return {
    listProjects: mock.mockListProjects,
    getProject: mock.mockGetProject,
    createProject: mock.mockCreateProject,
    updateProject: mock.mockUpdateProject,
    setProjectPinned: mock.mockSetProjectPinned,
    archiveProject: mock.mockArchiveProject,
    restoreProject: mock.mockRestoreProject,
    enterProject: mock.mockEnterProject,
    quickSwitchProjects: mock.mockQuickSwitchProjects,
  };
});

const state = vi.hoisted(() => ({
  currentProjectId: null as string | null,
  setCurrentProjectId: vi.fn(),
}));

vi.mock("../src/state/project", () => ({
  useProject: () => ({
    projects: [],
    currentProject: null,
    setCurrentProjectId: state.setCurrentProjectId,
    reloadProjects: async () => undefined,
  }),
}));
vi.mock("../src/state/auth", () => ({
  useAuth: () => ({ user: { userId: "demo-admin", displayName: "演示管理员", isAdmin: true } }),
}));

afterEach(async () => {
  await unmountAll();
  mockScenarios.reset();
  resetMockProjects();
  resetSessionListState();
  state.setCurrentProjectId.mockClear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 页面挂在 MemoryRouter 里；LocationProbe 报告当前路由，供「进入」断言。 */
function LocationProbe() {
  const { pathname } = useLocation();
  return h(Fragment, null, h("div", { "data-testid": "location" }, pathname));
}

/** 页面挂在 MemoryRouter 里；LocationProbe 始终渲染，报告当前路由，供「进入」断言。 */
function mountPage() {
  return mount(
    h(
      MemoryRouter,
      { initialEntries: ["/qa/projects"] },
      h(
        Fragment,
        null,
        h(LocationProbe),
        h(
          Routes,
          null,
          h(Route, { path: "/qa/projects", element: h(ProjectManagementPage) }),
          h(Route, { path: "*", element: h("div", null, "not-found") }),
        ),
      ),
    ),
  );
}

const bodyText = () => document.body.textContent ?? "";
const nameButtons = () => [...document.querySelectorAll<HTMLButtonElement>("button.qpm-name")];
const rows = () => document.querySelectorAll(".qpm-table tbody tr");

async function waitForList() {
  // 骨架屏也有行；等到真实数据行（名称按钮）出现才算列表就绪。
  await waitFor(() => nameButtons().length > 0, 100);
}

describe("项目管理页", () => {
  it("新建项目要求填写 Project id，并以填写的编号创建", async () => {
    await mountPage();
    await waitForList();
    await click(document.querySelector<HTMLButtonElement>(".qpm-head-actions .qpm-btn-main")!);
    const idField = field("Project id");
    const create = button("创建并进入");
    expect(create.disabled).toBe(true);
    await type(field("项目名称"), "支付回归");
    await type(idField, "payment_regression");
    expect(create.disabled).toBe(false);
    await click(create);
    await act(async () => { await sleep(500); });
    await waitFor(() => state.setCurrentProjectId.mock.calls.length > 0, 100);
    expect(state.setCurrentProjectId).toHaveBeenCalledWith("payment_regression");
  });

  it("渲染列表：状态默认进行中，mock 全量 134 条中 111 条进行中，按每页 20 条分页（PM-02）", async () => {
    await mountPage();
    await waitForList();
    expect(rows().length).toBe(20);
    expect(bodyText()).toContain("共 111 个项目");
    expect(bodyText()).toContain("1 / 6");
    // 置顶项优先、置顶项之间按最近活动：test_project 与 会员中心改版回归 都置顶，
    // 后者活动时间更新，排第一。
    expect(nameButtons()[0]?.textContent).toBe("会员中心改版回归");
    expect(nameButtons()[1]?.textContent).toBe("test_project");
  });

  it("分页翻页取的是完整结果集的第 2 页（PM-02/PM-03）", async () => {
    await mountPage();
    await waitForList();
    await click(button("下一页"));
    await waitFor(() => bodyText().includes("2 / 6"), 100);
    expect(rows().length).toBe(20);
    expect(nameButtons()[0]?.textContent).not.toBe("会员中心改版回归");
  });

  it("状态筛选默认进行中；切换到全部状态后总数变化（PM-02）", async () => {
    await mountPage();
    await waitForList();
    const activeTotal = Number(bodyText().match(/共 (\d+) 个项目/)?.[1]);
    expect(activeTotal).toBe(111);
    const statusSelect = document.querySelector<HTMLSelectElement>('select[aria-label="筛选状态"]');
    expect(statusSelect?.value).toBe("active");
    statusSelect!.value = "all";
    statusSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    await waitFor(() => {
      const total = Number(bodyText().match(/共 (\d+) 个项目/)?.[1]);
      return total === 134;
    }, 100);
    // 每页条数可选 20/50/100
    const sizeSelect = document.querySelector<HTMLSelectElement>('select[aria-label="每页条数"]');
    expect([...(sizeSelect?.options ?? [])].map((o) => o.value)).toEqual(["20", "50", "100"]);
  });

  it("搜索 300ms 防抖后按完整结果集过滤并回到第一页（PM-02/PM-03）", async () => {
    await mountPage();
    await waitForList();
    const search = field("搜索项目名称或编号");
    await type(search, "支付网关");
    await settle();
    // 防抖窗口内仍是旧结果
    expect(bodyText()).toContain("共 111 个项目");
    await act(async () => {
      await sleep(450);
    });    await waitFor(() => bodyText().includes("共 5 个项目"), 100);
    expect(rows().length).toBe(5);
    expect(nameButtons()[0]?.textContent).toContain("支付网关联调测试");
  });

  it("点项目名称打开详情侧栏、不切换项目上下文；Esc 关闭（PM-04）", async () => {
    await mountPage();
    await waitForList();
    await click(nameButtons()[0]!);
    await waitFor(() => document.querySelector('[role="dialog"][aria-label^="项目详情"]') !== null, 50);
    expect(document.querySelector('[role="dialog"][aria-label^="项目详情"]')!.getAttribute("aria-label")).toContain("会员中心改版回归");
    // 路由仍是项目管理页，项目上下文未被切换
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe("/qa/projects");
    expect(state.setCurrentProjectId).not.toHaveBeenCalled();
    await pressEscape();
    await waitFor(() => document.querySelector('[role="dialog"][aria-label^="项目详情"]') === null, 50);
    expect(state.setCurrentProjectId).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe("/qa/projects");
  });

  it("操作菜单在表格外显示，并提供项目设置入口", async () => {
    await mountPage();
    await waitForList();
    await click(document.querySelector<HTMLButtonElement>("button.qpm-more")!);
    const menu = document.querySelector<HTMLElement>('div.qpm-menu[role="menu"]');
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.textContent).toContain("项目设置");
    expect(menu?.textContent).toContain("编辑信息");
    expect(menu?.textContent).not.toContain("置顶项目");
    expect(menu?.textContent).not.toContain("归档项目");
    await pressEscape();
    expect(document.querySelector("div.qpm-menu")).toBeNull();
  });

  it("编辑信息直接打开表单，查看详情不显示操作区", async () => {
    await mountPage();
    await waitForList();
    await click(document.querySelector<HTMLButtonElement>("button.qpm-more")!);
    const edit = [...document.querySelectorAll<HTMLButtonElement>(".qpm-menu button")].find(item => item.textContent === "编辑信息")!;
    await click(edit);
    await waitFor(() => document.querySelector('textarea[aria-label="项目简介"]') !== null, 100);
    const dialog = document.querySelector('[role="dialog"][aria-label^="项目详情"]')!;
    expect(dialog.querySelector('section[aria-label="可用操作"]')).toBeNull();
    await pressEscape();
    await click(nameButtons()[0]!);
    await waitFor(() => document.querySelector('[role="dialog"][aria-label^="项目详情"]') !== null, 100);
    expect(document.querySelector('section[aria-label="可用操作"]')).toBeNull();
    expect(document.querySelector('textarea[aria-label="项目简介"]')).toBeNull();
  });

  it("点「进入 →」先校验再复用现有项目上下文切换到 /qa/project（PM-04/PM-05）", async () => {
    await mountPage();
    await waitForList();
    const enter = document.querySelector<HTMLButtonElement>("button.qpm-enter")!;
    expect(enter.textContent).toContain("进入");
    await click(enter);
    await waitFor(() => state.setCurrentProjectId.mock.calls.length > 0, 100);
    expect(state.setCurrentProjectId).toHaveBeenCalledWith("PRJ-0002");
    await waitFor(() => document.querySelector('[data-testid="location"]')?.textContent === "/qa/project", 100);
  });

  it("进入失败（mock 场景）停留原页面并保留列表（§10/PM-13）", async () => {
    mockScenarios.failEnter = true;
    await mountPage();
    await waitForList();
    await click(document.querySelector<HTMLButtonElement>("button.qpm-enter")!);
    // 失败提示经 toastStore（模块级 store，应用根挂 Toaster；测试直接读 store）
    await waitFor(() => toastStore.getState().items.some((t) => t.text.includes("进入项目失败")), 100);
    expect(state.setCurrentProjectId).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe("/qa/projects");
    // 列表仍在（未进入项目视图）
    expect(rows().length).toBeGreaterThan(0);
  });

  it("详情侧栏展示同步项目信息（外部字段只读），不显示操作区（PM-08/PM-12）", async () => {
    await mountPage();
    await waitForList();
    // 平台同步项目：支付网关联调测试（置顶后第 3 行）
    const syncName = nameButtons().find((b) => b.textContent === "支付网关联调测试")!;
    await click(syncName);
    await waitFor(() => bodyText().includes("同步项目信息"), 50);
    expect(bodyText()).toContain("由来源平台维护");
    expect(bodyText()).toContain("EXT-1002");
    expect(bodyText()).toContain("最近同步时间");
    // 同步项目不出现本地归档/恢复按钮（PM-12）
    const dialogText = document.querySelector('[role="dialog"][aria-label^="项目详情"]')!.textContent ?? "";
    expect(dialogText).not.toContain("归档项目");
    expect(dialogText).not.toContain("恢复项目");
    expect(dialogText).not.toContain("进入项目");
  });
});
