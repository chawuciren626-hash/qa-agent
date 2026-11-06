/** List summaries for imported built-in roles whose description is still an import label. */
const builtinDescriptions: Record<string, string> = {
  requirement_analysis_agent: "分析需求中的功能、业务规则与风险，梳理测试范围和待澄清问题。",
  default_agent: "提供通用问答与任务入口，引导专业测试需求进入软件测试总控智能体。",
  test_agent: "统筹测试任务，协调需求分析、测试设计、自动化执行、缺陷分析与报告交付。",
  test_point_agent: "根据需求设计正常、异常和边界测试点，检查规则覆盖并整理测试范围。",
  test_case_agent: "将需求与测试点转化为可执行用例，明确前置条件、测试数据、操作步骤和预期结果。",
  automation_execution_agent: "执行 Web 页面自动化测试，核对实际结果并保存截图、日志和可追溯证据。",
  api_automation_agent: "依据接口契约执行接口测试，校验响应、业务规则和异常场景并记录结果。",
  android_test_agent: "执行 Android App 自动化测试，验证页面交互与业务流程并保存测试证据。",
  miniprogram_test_agent: "通过小程序开发者工具执行自动化测试，验证页面、交互和业务结果。",
  defect_analysis_agent: "结合失败用例、日志和截图分析问题，判定缺陷严重程度并生成可追溯的缺陷记录。",
  test_report_agent: "汇总测试设计、执行结果和缺陷证据，形成包含覆盖情况、未测范围与风险的测试报告。",
};

export function agentDescription(card: { description: string; payload: Record<string, unknown> }): string {
  const description = card.description.trim();
  const placeholder = description.match(/^(?:上游)?(?:内置|中央)智能体模板\s*[·•]\s*([a-z][a-z0-9_]*)\s*$/);
  // Preserve descriptions edited by administrators; historical cards may lack payload.agentId.
  if (description && !placeholder) return card.description;
  const agentId = placeholder?.[1] ?? (typeof card.payload.agentId === "string" ? card.payload.agentId : "");
  return builtinDescriptions[agentId] ?? "暂无智能体简介。";
}
