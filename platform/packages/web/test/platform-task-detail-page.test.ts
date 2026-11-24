// @vitest-environment jsdom
/**
 * 平台任务详情全页（/qa/project/platform-tasks/:taskId）的页面行为。
 *
 * 替代 2026-11-24 被移除的抽屉 2 测（f9dcc4f 详情从侧边抽屉改全页路由）：
 * - 结构化重排：基本信息/内容整理/原始反馈/研发判断（正式开发提交字段级 + 变更含
 *   sections）/AI 分析结论/测试进展，按 packageDetail（交接包资料全集）渲染；
 * - 老库回填前 packageDetail 为 null → 回退 digest 字段展示（研发判断内容不丢）；
 * - 富文本残留清理（变更内容里的 <ul><li> 片段转纯文本换行）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { mount, unmountAll, waitFor } from "./helpers/dom";
import { PlatformTaskDetailPage } from "../src/features/qa/platform-tasks/platform-task-detail-page";
import type { TaskDetail } from "../src/features/qa/platform-tasks/api";

const fixture = vi.hoisted(() => {
  const baseTask = {
    id: "ptl-1", projectId: "proj-1", source: "platform" as const, taskNo: "FB202611090001",
    title: "gov 用户端登录优化", priority: "high" as const, packageVersion: 2, roundNo: 1,
    productLines: [{ name: "gov 用户端", isPrimary: true }],
    ends: [], changeSource: null, suggestedPriority: "high", analysisSource: "demo",
    status: "ready", edited: false, mainSessionId: "session-main-1",
    sourceUrl: "https://platform.example.com/tasks/active?taskId=FB202611090001",
    updatedAt: "2026-11-20T07:00:00.000Z",
    feedbackType: "requirement", feedbackTypeLabel: "需求优化", estimatedHours: 24,
    submitter: "产品 张瑛", assignee: "研发 王智", complexityLevel: "中", estimatedDays: 3,
    description: null, localTitleNote: "", localTestFocusNote: "", localEditedAt: null,
    createdBy: null, envName: null, envBaseUrl: null, account: null,
  };
  const state = {
    analyzeCalls: 0,
    startCalls: 0,
    terminateCalls: 0,
    /** getTaskDetail 当前返回值（renderDetail 可切换为 digest-only 形态）。 */
    detail: null as TaskDetail | null,
  };
  /** packageDetail：交接包结构化资料全集（服务端激活/回填落库后的形态）。 */
  const packageDetail = {
    package_version: 2,
    event_type: "material_changed",
    generated_at: "2026-11-23T18:30:00+08:00",
    ai_content: "任务平台侧 AI 整理正文",
    ai_structured_result: {
      summary: "后台新增用户失败的修复回归",
      acceptance_criteria: ["新增用户后列表可见", "重复提交返回明确错误"],
    },
    final_content: "研发处理判断最终内容",
    original_content: "后台新增用户失败，无法完成用户创建",
    original_rich_content: "",
    supplements: [
      { content: "补充：仅生产环境复现，测试环境正常", operator: "张瑛", created_at: "2026-11-21T09:00:00+08:00" },
    ],
    confirmed_baseline: {
      final_content: "具备 identity:manage 权限的管理员在后台按标准流程新增用户，填写完整有效信息后提交",
      acceptance_criteria: ["创建成功、数据准确落库并在用户列表可见", "重复用户名返回明确业务错误提示"],
      missing_fields: ["影响范围未标注"],
      confirmed: true,
      confirmed_at: "2026-11-22T10:00:00+08:00",
      confirmed_by: "王智",
    },
    self_test: {
      submitted_at: "2026-11-20T01:00:00+08:00",
      review_mode: "manual",
      approval_status: "approved",
      reviewed_at: "2026-11-20T06:04:00+08:00",
      request_reason: "自测说明：已完成主流程回归",
      sections: [
        { key: "test_address", label: "测试地址", value: "https://local.console.gov-bid.com/bbiao-admin/register/user/index" },
        { key: "self_test_result", label: "自测结果", value: "测试通过" },
        { key: "test_focus", label: "验证重点", value: "用户创建" },
        { key: "known_risks", label: "已知风险", value: "无" },
      ],
      related_links: ["http://task-platform:8000/self-test"],
    },
    changes: [
      {
        node: "正式开发", node_code: "developing", batch: 1, sequence: 1,
        content: "<ul><li><span>修复用户创建时角色校验缺失</span></li><li><span>补充错误提示文案</span></li></ul>",
        sections: [
          { key: "change_reason", label: "变更原因", value: "修复后端创建用户接口的角色校验缺陷" },
          { key: "affected_scope", label: "影响范围", value: "后台用户管理新增功能" },
          { key: "validation_result", label: "验证结果", value: "已完成自测回归" },
        ],
        changed_at: "2026-11-20T01:37:00+08:00",
        operator: "研发",
      },
    ],
    attachments: [
      { attachment_id: "att-1", file_name: "研发处理判断.md", file_category: "development_judgment", node_code: "developing", file_size: 4096, content_type: "text/markdown", download_url: null },
      { attachment_id: "att-2", file_name: "排期设计文档.md", file_category: "schedule_design_document", node_code: "developing", file_size: 2048, content_type: "text/markdown", download_url: null },
    ],
    schedule_design_documents: [
      { document_key: "doc-key-1", file_name: "排期设计文档.md", attachment_id: "att-2" },
    ],
    handoff_document: { title: "交接文档", content: "# 交接文档全文" },
    regression_context: {
      previous_failed_issues: [
        { issue_no: "ISS-1", title: "上轮发现：重复提交无提示", problem_description: "重复提交返回 500 而非业务错误", severity: "high" },
      ],
      rectifications: [
        { solution: "补充唯一性校验", changed_content: "后端重复提交校验", test_method: "接口回归" },
      ],
    },
  };
  const detailWithPackage: TaskDetail = {
    task: { ...baseTask, packageDetail },
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
    progress: {
      mainSessionId: "session-main-1",
      runs: [
        { runId: "run-1", status: "completed", counts: { cases: 4 }, startedAt: null, finishedAt: null, env: "test", kind: "run" },
      ],
    },
  };
  /** 老库回填前：packageDetail 为 null，回退 digest 展示。 */
  const detailDigestOnly: TaskDetail = {
    task: {
      ...baseTask,
      packageDetail: null,
      requirementBaseline: { final_content: "旧任务的基准正文", acceptance_criteria: ["旧验收口径"], confirmed: true },
      selfTestDigest: { reviewed_at: "2026-11-20T06:04:00Z", test_address: "https://old-env", self_test_result: "测试通过", test_focus: "用户创建" },
      changesDigest: [{ node: "正式开发", batch: 1, content: "旧任务的变更正文", changed_at: "2026-11-20T01:37:00Z", operator: "研发" }],
    },
    summary: null,
    progress: { mainSessionId: null, runs: [] },
  };
  return { state, detailWithPackage, detailDigestOnly, withPackageBase: JSON.parse(JSON.stringify(detailWithPackage)) };
});

vi.mock("../src/features/qa/platform-tasks/api", () => ({
  getTaskDetail: async () => fixture.state.detail ?? fixture.detailWithPackage,
  analyzeTask: async () => {
    fixture.state.analyzeCalls += 1;
    return { updated: null, summary: fixture.detailWithPackage.summary };
  },
  startTask: async () => {
    fixture.state.startCalls += 1;
    return { task: null, sessionId: "session-new-1", previousStatus: "ready" };
  },
  terminateTask: async () => {
    fixture.state.terminateCalls += 1;
    return { updated: null };
  },
  listTaskAttachments: async () => ({ attachments: [] }),
  uploadTaskAttachment: async () => ({ attachment: {}, attachments: [] }),
  deleteTaskAttachment: async () => ({ removed: true }),
  editTask: async () => ({ updated: null, analysisStale: false }),
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
  fixture.state.analyzeCalls = 0;
  fixture.state.startCalls = 0;
  fixture.state.terminateCalls = 0;
  fixture.state.detail = null;
});

async function renderDetail(detail?: TaskDetail) {
  if (detail) fixture.state.detail = detail;
  const mounted = await mount(
    h(MemoryRouter, { initialEntries: ["/qa/project/platform-tasks/ptl-1"] },
      h(Routes, null,
        h(Route, { path: "/qa/project/platform-tasks/:taskId", element: h(PlatformTaskDetailPage) }),
        h(Route, { path: "/qa/project/platform-tasks", element: h("div", { "data-testid": "list" }) }),
      ),
    ),
  );
  await waitFor(() => mounted.container.querySelector(".qpt-dtl-head") !== null);
  return mounted.container;
}

describe("platform task detail page", () => {
  it("交接包结构化重排：基本信息/内容整理/原始反馈/研发判断（提交字段级+变更 sections）/回归上下文", async () => {
    const root = await renderDetail();
    const text = root.textContent ?? "";

    // 头部：标题 + 编号 + 版本/轮次 + 事件
    expect(root.querySelector(".qpt-dtl-head")?.textContent).toContain("gov 用户端登录优化");
    expect(text).toContain("FB202611090001");
    expect(text).toContain("包版本 v2");
    expect(text).toContain("第 1 轮");
    expect(text).toContain("资料变更"); // event_type=material_changed 中文标签

    // ② 基本信息（含平台任务链接）
    expect(text).toContain("需求优化");
    expect(text).toContain("产品 张瑛 / 研发 王智");
    const deeplink = root.querySelector<HTMLAnchorElement>(".qpt-deeplink a");
    expect(deeplink?.getAttribute("href")).toContain("FB202611090001");

    // ③ 内容整理：ai_structured_result 字段级 + 确认基准 + 验收口径 + 遗漏字段
    expect(text).toContain("任务平台结构化整理");
    expect(text).toContain("后台新增用户失败的修复回归");
    expect(text).toContain("具备 identity:manage 权限的管理员");
    expect(text).toContain("创建成功、数据准确落库并在用户列表可见");
    expect(text).toContain("待澄清/遗漏字段");
    expect(text).toContain("影响范围未标注");

    // ④ 原始反馈：正文 + 补充意见
    expect(text).toContain("后台新增用户失败，无法完成用户创建");
    expect(text).toContain("补充意见（1 条）");
    expect(text).toContain("仅生产环境复现");

    // ⑤ 研发判断：正式开发提交记录（字段级 sections）+ 变更记录（含结构化字段）+ 材料清单 + 回归
    expect(text).toContain("正式开发提交记录");
    expect(text).toContain("自测说明：已完成主流程回归");
    expect(text).toContain("https://local.console.gov-bid.com/bbiao-admin/register/user/index");
    expect(text).toContain("验证重点");
    expect(text).toContain("节点变更记录（1 条）");
    expect(text).toContain("变更原因"); // sections 结构化字段中文标签
    expect(text).toContain("修复后端创建用户接口的角色校验缺陷");
    // 富文本残留清理：<li> 转换行点、无裸标签
    expect(text).toContain("修复用户创建时角色校验缺失");
    expect(text).not.toContain("<ul><li>");
    expect(text).toContain("研发判断材料（3 件）"); // 排期设计文档同时在 designDocs 引用与 attachments 清单里，共 2+1
    expect(text).toContain("研发处理判断.md");
    expect(text).toContain("排期设计文档.md");
    expect(text).toContain("上轮抽测退回问题");
    expect(text).toContain("补充唯一性校验");

    // ⑥ AI 分析结论（标 AI 建议）+ ⑦ 测试进展
    expect(text).toContain("AI 分析结论");
    expect(text).toContain("AI 建议");
    expect(text).toContain("测试进展");
    expect(text).toContain("run-1");
  });

  it("老库回退：packageDetail 为 null 时按 digest 字段展示研发判断，不空板块", async () => {
    const root = await renderDetail(fixture.detailDigestOnly);
    const text = root.textContent ?? "";
    expect(text).toContain("正式开发提交记录");
    expect(text).toContain("旧任务的基准正文");
    expect(text).toContain("测试通过");
    expect(text).toContain("旧任务的变更正文");
    // 无 packageDetail 时不应出现结构化专属板块标题
    expect(text).not.toContain("任务平台结构化整理");
    expect(text).not.toContain("上轮抽测退回问题");
  });

  it("页面操作：AI 分析/开始测试可发起，终止需要确认", async () => {
    const root = await renderDetail();
    const analyze = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "重新分析")!;
    analyze.click();
    await waitFor(() => fixture.state.analyzeCalls === 1);
    const start = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "开始测试")!;
    expect(start).toBeTruthy();
    start.click();
    await waitFor(() => fixture.state.startCalls === 1);
    // window.prompt 取消（返回 null）→ 不发终止请求
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    const terminate = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "终止")!;
    terminate.click();
    await waitFor(() => fixture.state.terminateCalls === 0);
    promptSpy.mockReturnValue("人工终止");
    terminate.click();
    await waitFor(() => fixture.state.terminateCalls === 1);
    promptSpy.mockRestore();
  });
});
