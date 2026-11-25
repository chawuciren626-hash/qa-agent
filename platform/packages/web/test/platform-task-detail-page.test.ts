// @vitest-environment jsdom
/**
 * 平台任务详情全页（/qa/project/platform-tasks/:taskId）的页面行为。
 *
 * 2026-11-24 平台资料四 tab 结构（对齐任务平台任务详情页资料分区）：
 * - "平台资料"标题下恒四个 tab（原始反馈/内容整理/研发初判/研发自测），空 tab 标"无"；
 * - 每个 tab 字段级展示：原始反馈=正文+补充意见+反馈人上传的附件（node=submitted）；
 *   内容整理=业务字段表+最终内容/验收口径（2026-11-25 起不再回显字段抽取明细与
 *   enhanced_content/confidence/provider 等任务平台 AI 流水字段）；研发初判=三份文档+
 *   节点变更（sections 字段级）+变更材料+回归上下文；研发自测=13 个标准字段+测试用例卡；
 * - 附件按交接包 node_code 归阶段：submitted→原始反馈、processing/developing→研发初判、
 *   self_testing/pm_testing→研发自测；
 * - 富文本残留清理（<ul><li> → 纯文本换行）；
 * - 老库回填前 packageDetail 为 null → 各 tab 用 digest 字段兜底（标"摘要回退"）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { click, mount, settle, unmountAll, waitFor } from "./helpers/dom";
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
  /** packageDetail：交接包结构化资料全集（对齐任务平台真实包 v2 实测结构）。 */
  const packageDetail = {
    package_version: 2,
    event_type: "material_changed",
    generated_at: "2026-11-23T18:30:00+08:00",
    ai_content: "任务平台侧 AI 整理正文",
    ai_structured_result: {
      title: "后台新增用户失败的修复回归",
      feedback_type: "bug",
      module_name: "登录",
      product_line_name: "gov用户端",
      priority: "high",
      tags: ["gov用户端", "登录", "身份管理"],
      summary: "任务平台侧 AI 摘要",
      extracted_fields: {
        "接口地址": "http://localhost:5173/api/v1/identity/users",
        "请求方法": "POST",
        "响应状态": "500 Internal Server Error",
        "高风险实现点": "session.flush() 未局部捕获 IntegrityError",
        "关键业务约束": ["同一租户内用户名唯一", "新用户 tenant_id 取自当前登录用户"],
      },
      enhanced_content: "增强内容正文",
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
        { key: "access_url", label: "测试地址/访问地址", value: "https://local.console.gov-bid.com/bbiao-admin/register/user/index" },
        { key: "self_test_result", label: "自测结果", value: "测试通过" },
        { key: "affected_modules", label: "影响模块", value: "用户管理模块" },
        { key: "known_risks", label: "已知风险", value: "无" },
        { key: "version_info", label: "版本信息", value: "https://local.console.gov-bid.com/v2" },
        { key: "test_account", label: "测试账号", value: "yanfa" },
        { key: "delivery_channels", label: "交付形态", value: "链接" },
        { key: "product_validation_points", label: "验收重点验证点", value: "用户创建" },
        {
          key: "requirement_test_cases", label: "需求反馈测试用例", section_type: "test_cases",
          value: "1. 测试用例：用户创建成功",
          items: [{
            id: "mat-1", case_no: "TC-001", title: "测试用例",
            test_scene: "用户创建", steps: "1.打开后台 2.填写信息 3.提交",
            expected_result: "创建成功且列表可见", actual_result: "用户创建成功",
            screenshot_attachment_ids: ["shot-1"], source: "manual_test_case", locked: false,
          }],
        },
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
          { key: "validation_result", label: "本次自测/修复验证", value: "已完成自测回归" },
        ],
        changed_at: "2026-11-20T01:37:00+08:00",
        operator: "研发",
      },
    ],
    attachments: [
      { attachment_id: "att-1", file_name: "研发处理判断.md", file_category: "development_judgment", node_code: "developing", file_size: 4096, content_type: "text/markdown", download_url: null },
      { attachment_id: "att-2", file_name: "变更截图.png", file_category: "node_change_attachment", node_code: "developing", file_size: 20480, content_type: "image/png", download_url: null },
      // 反馈人原始反馈里上传的截图（node submitted）：必须归 原始反馈 tab，不能落到研发初判
      { attachment_id: "att-4", file_name: "粘贴截图_1.png", file_category: "image", node_code: "submitted", file_size: 42206, content_type: "image/png", download_url: null },
      { attachment_id: "att-5", file_name: "粘贴截图_2.png", file_category: "image", node_code: "submitted", file_size: 64666, content_type: "image/png", download_url: null },
    ],
    schedule_design_documents: [
      { document_key: "technical_solution", file_name: "解决问题的技术方案说明.md", attachment_id: "att-3" },
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
  /** 老库回填前：packageDetail 为 null，各 tab 用 digest 兜底。 */
  const detailDigestOnly: TaskDetail = {
    task: {
      ...baseTask,
      packageDetail: null,
      requirementBaseline: {
        final_content: "旧任务的基准正文",
        original_content: "旧任务的原始反馈正文",
        acceptance_criteria: ["旧验收口径"],
        confirmed: true,
      },
      selfTestDigest: { reviewed_at: "2026-11-20T06:04:00Z", test_address: "https://old-env", self_test_result: "测试通过", test_focus: "用户创建" },
      changesDigest: [{ node: "正式开发", batch: 1, content: "旧任务的变更正文", changed_at: "2026-11-20T01:37:00Z", operator: "研发" }],
    },
    summary: null,
    progress: { mainSessionId: null, runs: [] },
  };
  return { state, detailWithPackage, detailDigestOnly };
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

/** 点击平台资料的某个 tab（四 tab：原始反馈/内容整理/研发初判/研发自测）。 */
async function openTab(root: HTMLElement, label: string) {
  const tab = Array.from(root.querySelectorAll<HTMLButtonElement>(".qpt-tab")).find((b) => b.textContent?.includes(label))!;
  await click(tab);
  await settle();
}

describe("platform task detail page", () => {
  it("平台资料四 tab：原始反馈/内容整理（字段级+抽取表）/研发初判（文档+变更 sections）/研发自测（用例卡）", async () => {
    const root = await renderDetail();
    const text = root.textContent ?? "";

    // 头部：标题 + 编号 + 版本/轮次 + 事件
    expect(root.querySelector(".qpt-dtl-head")?.textContent).toContain("gov 用户端登录优化");
    expect(text).toContain("FB202611090001");
    expect(text).toContain("包版本 v2");
    expect(text).toContain("第 1 轮");
    expect(text).toContain("资料变更"); // event_type=material_changed 中文标签
    expect(text).toContain("需求优化");
    expect(text).toContain("产品 张瑛 / 研发 王智");
    const deeplink = root.querySelector<HTMLAnchorElement>(".qpt-deeplink a");
    expect(deeplink?.getAttribute("href")).toContain("FB202611090001");

    // 四 tab 恒在（任务平台同款结构）
    const tabLabels = Array.from(root.querySelectorAll(".qpt-tab")).map((b) => b.textContent ?? "");
    expect(tabLabels.some((t) => t.includes("原始反馈"))).toBe(true);
    expect(tabLabels.some((t) => t.includes("内容整理"))).toBe(true);
    expect(tabLabels.some((t) => t.includes("研发初判"))).toBe(true);
    expect(tabLabels.some((t) => t.includes("研发自测"))).toBe(true);

    // ① 原始反馈（默认 tab）：正文 + 补充意见 + 反馈人上传的附件
    expect(text).toContain("反馈正文");
    expect(text).toContain("后台新增用户失败，无法完成用户创建");
    expect(text).toContain("补充意见（1 条）");
    expect(text).toContain("仅生产环境复现");
    expect(text).toContain("附件资料（2 件）");
    expect(text).toContain("粘贴截图_1.png");
    expect(text).toContain("粘贴截图_2.png");
    expect(text).not.toContain("变更与审核材料");

    // ② 内容整理 tab：只保留业务字段 + 最终内容/验收口径；不显示字段抽取明细/AI 流水字段
    await openTab(root, "内容整理");
    const organized = root.textContent ?? "";
    expect(organized).toContain("AI 结构化字段");
    expect(organized).toContain("任务概括");
    expect(organized).toContain("后台新增用户失败的修复回归");
    expect(organized).toContain("标签");
    expect(organized).toContain("反馈类型");
    expect(organized).not.toContain("字段抽取明细");
    expect(organized).not.toContain("enhanced_content");
    expect(organized).not.toContain("confidence");
    expect(organized).not.toContain("接口地址");
    expect(organized).not.toContain("500 Internal Server Error");
    expect(organized).toContain("最终内容（研发处理判断确认版）");
    expect(organized).toContain("具备 identity:manage 权限的管理员");
    expect(organized).toContain("验收口径");
    expect(organized).toContain("创建成功、数据准确落库并在用户列表可见");
    expect(organized).toContain("需补充资料");
    expect(organized).toContain("影响范围未标注");

    // ③ 研发初判 tab：文档 + 节点变更记录（含字段级 sections）+ 变更材料 + 回归
    await openTab(root, "研发初判");
    const judgment = root.textContent ?? "";
    expect(judgment).toContain("研发处理判断资料 · 节点原提交文档（1 份）");
    expect(judgment).toContain("解决问题的技术方案说明.md");
    expect(judgment).toContain("节点变更记录（1 条）");
    expect(judgment).toContain("第1批");
    expect(judgment).toContain("变更原因"); // sections 字段中文标签
    expect(judgment).toContain("修复后端创建用户接口的角色校验缺陷");
    expect(judgment).toContain("影响范围");
    // 富文本残留清理：<li> 转换行、无裸标签
    expect(judgment).toContain("修复用户创建时角色校验缺失");
    expect(judgment).not.toContain("<ul><li>");
    // 变更材料只含研发阶段附件；反馈人的截图不在此 tab
    expect(judgment).toContain("变更与审核材料（2 件）");
    expect(judgment).toContain("研发处理判断.md");
    expect(judgment).not.toContain("粘贴截图_1.png");
    expect(judgment).toContain("上轮抽测退回问题");
    expect(judgment).toContain("补充唯一性校验");

    // ④ 研发自测 tab：字段级 sections（任务平台 13 个标准字段的非空项）+ 测试用例卡
    await openTab(root, "研发自测");
    const selftest = root.textContent ?? "";
    expect(selftest).toContain("提交审核材料（研发自测 · 审核通过）");
    expect(selftest).toContain("自测说明：已完成主流程回归");
    expect(selftest).toContain("测试地址/访问地址");
    expect(selftest).toContain("https://local.console.gov-bid.com/bbiao-admin/register/user/index");
    expect(selftest).toContain("自测结果");
    expect(selftest).toContain("测试通过");
    expect(selftest).toContain("影响模块");
    expect(selftest).toContain("用户管理模块");
    expect(selftest).toContain("交付形态");
    expect(selftest).toContain("验收重点验证点");
    expect(selftest).toContain("需求反馈测试用例");
    expect(selftest).toContain("TC-001"); // 结构化用例编号
    expect(selftest).toContain("测试场景");
    expect(selftest).toContain("用户创建");
    expect(selftest).toContain("预期结果");
    expect(selftest).toContain("创建成功且列表可见");
    expect(selftest).toContain("截图凭证 1 张");

    // ⑥ AI 分析结论 + ⑦ 测试进展
    expect(text).toContain("AI 分析结论");
    expect(text).toContain("AI 建议");
    expect(text).toContain("测试进展");
    expect(text).toContain("run-1");
  });

  it("老库回退：packageDetail 为 null 时四 tab 按 digest 兜底（摘要回退标注）", async () => {
    const root = await renderDetail(fixture.detailDigestOnly);
    // 默认原始反馈 tab：digest baseline 里的 original_content 兜底
    await openTab(root, "原始反馈");
    expect((root.textContent ?? "")).toContain("反馈正文（摘要回退）");
    expect((root.textContent ?? "")).toContain("旧任务的原始反馈正文");

    await openTab(root, "内容整理");
    const organized = root.textContent ?? "";
    expect(organized).toContain("研发处理判断确认基准（摘要回退）");
    expect(organized).toContain("旧任务的基准正文");
    expect(organized).toContain("旧验收口径");

    await openTab(root, "研发初判");
    const judgment = root.textContent ?? "";
    expect(judgment).toContain("旧任务的变更正文");
    // 老库回退不出现结构化专属块（真实包才有）
    expect(judgment).not.toContain("字段抽取明细");
    expect(judgment).not.toContain("上轮抽测退回问题");

    await openTab(root, "研发自测");
    const selftest = root.textContent ?? "";
    expect(selftest).toContain("自测结果：测试通过");
    expect(selftest).toContain("验证重点：用户创建");
    expect(selftest).toContain("测试地址：https://old-env");
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

  it("进行中任务不提供「打开会话」（避免重复 /start 建会话）", async () => {
    const inProgress = JSON.parse(JSON.stringify(fixture.detailWithPackage)) as TaskDetail;
    inProgress.task.status = "in_progress";
    inProgress.task.mainSessionId = "session-main-1";
    const root = await renderDetail(inProgress);
    const text = root.textContent ?? "";
    expect(text).not.toContain("打开会话");
    expect(text).toContain("从列表进入任务详情");
    // 不再渲染可重复触发 start 的按钮
    expect(Array.from(root.querySelectorAll("button")).some((b) => b.textContent === "打开会话")).toBe(false);
  });
});
