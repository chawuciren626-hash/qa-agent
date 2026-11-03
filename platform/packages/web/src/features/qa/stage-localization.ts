const values: Record<string, string> = {
  requirement: "需求", assumption: "假设", constraint: "约束", functional: "功能", non_functional: "非功能", clarification: "待澄清",
  in_scope: "范围内", out_of_scope: "范围外", confirmed: "已确认", pending: "待确认", rejected: "已拒绝", planned: "待开始",
  passed: "通过", failed: "未通过", blocked: "受阻", skipped: "未执行", partial: "部分完成", completed: "已完成", unknown: "未知",
  product: "产品问题", engineering: "工程问题", environment: "环境问题", needs_review: "待核查", open: "待处理", fixed: "已修复", closed: "已关闭",
  product_defect: "产品缺陷", script_issue: "脚本问题", environment_issue: "环境问题", test_data_issue: "测试数据问题",
  draft: "草稿", Blocker: "阻断", Critical: "严重", Major: "较严重", Minor: "轻微", Trivial: "提示",
  confirmation_requested: "已发起确认", confirmation_resolved: "已完成确认", dispatched: "已派发", revision_requested: "已请求修订", plan_created: "已创建计划", quality_revision_required: "需修订质量结论",
  awaiting_confirmation: "待审核", pending_confirmation: "待审核", in_progress: "进行中", created: "已创建", ready: "就绪", cancelled: "已取消", none: "无",
};
const reasons: Record<string, string> = {
  "User supplied requirement clarification or scope changes; revise before approval": "用户补充了需求说明或调整了范围，需修订后再确认。",
  "Upstream analysis changed; not a user approval": "上游需求分析已变化，此记录不是用户确认。",
  "Upstream analysis revision": "上游需求分析已修订。",
  "Added to the existing run plan": "已加入本次运行计划。",
};
export const localizedValue = (value: string) => values[value] ?? value;
export const localizedAgent = (value: string) => ({ requirement_analysis_agent:"需求分析智能体", test_point_agent:"测试点智能体", test_case_agent:"用例设计智能体", automation_execution_agent:"自动化执行智能体", defect_analysis_agent:"缺陷分析智能体", test_report_agent:"测试报告智能体", test_agent:"测试协调智能体" } as Record<string,string>)[value] ?? value;
export const localizedReason = (value: string) => reasons[value] ?? value.replace(/^Upstream (analysis|test_points|test_cases|execution|api_execution|defects|report) revision$/, (_, stage: string) => `上游${({analysis:"需求分析",test_points:"场景与测试点",test_cases:"用例设计",execution:"测试执行",api_execution:"接口执行",defects:"缺陷分析",report:"测试报告"} as Record<string,string>)[stage]}已修订。`);

/** Translate only structured codes in generated documents; keep source quotations intact. */
export function localizeGeneratedMarkdown(markdown: string): string {
  return markdown.replace(/^([ \t]*[-*]?[ \t]*(?:类型|范围|状态|分类|优先级|风险|结果|执行状态|类别)[：:]\s*)([a-z][a-z_\\]*)(\s*)$/gm,
    (whole, prefix: string, value: string, suffix: string) => values[value.replaceAll("\\", "")] ? `${prefix}${values[value.replaceAll("\\", "")]}${suffix}` : whole);
}
