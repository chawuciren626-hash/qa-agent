// This is the dispatch-facing scenario map. A registered tool is never evidence
// of execution; only a receipt from its concrete implementation is evidence.
export const TOOL_SCENARIOS = Object.freeze([
  {stage:'analysis', scene:'口述需求已归档', tools:['requirement.parse','knowledge.incremental'], input:'inputs/口述快照', outcome:'纯文本快照自动解析位置与条款；增量知识仍待接线', state:'text_parser_active_incremental_pending'},
  {stage:'analysis', scene:'上传文档或需求链接已归档', tools:['requirement.parse','knowledge.incremental'], input:'inputs/原始文件或链接快照', outcome:'纯文本及 DOCX 提取已有实际回执；链接抓取和知识增量仍待接线', state:'text_docx_parser_active_link_pending'},
  {stage:'analysis', scene:'需求条款已抽取', tools:['requirement.testability','requirement.acceptance'], input:'带 expected、preconditions、acceptance 的需求 IR', outcome:'T1–T4 / E1–W1 问题；error 阻止发布', state:'ir_adapter_pending'},
  {stage:'analysis', scene:'需求草稿复核', tools:['requirement.completeness','irval.check'], input:'analysis/requirement-ledger.json 及原文快照；正式 IR', outcome:'引用/完备性诊断；不通过阻止交接', state:'node_active_ir_pending'},
  {stage:'test_points', scene:'已确认需求进入设计', tools:['testpoint.matrix'], input:'已确认需求 IR 和维度配置', outcome:'枚举矩阵骨架', state:'ir_adapter_pending'},
  {stage:'test_points', scene:'测试点导出前', tools:['testpoint.coverage','irval.check'], input:'当前需求台账与测试点 JSON；v3 IR 另需完整契约', outcome:'Node 规则覆盖缺口阻止交接；v3 IR 校验待适配', state:'node_active_ir_pending'},
  {stage:'test_cases', scene:'测试用例编制与导出', tools:['expected.provenance','plan.gates','irval.check'], input:'已确认规则、测试点、计划 IR、用例 IR', outcome:'来源链和五闸；不通过阻止交接', state:'node_active_ir_pending'},
  {stage:'execution', scene:'仅地址探索或 Web 执行', tools:['dom.snapshot','login.captcha_chain'], input:'真实浏览器页面、登录授权、DOM/截图', outcome:'真实 snapshot 与 login.captcha_chain 均必须留下执行回执；图形验证码自动识别、填写、提交、成功校验并复用会话，短信/扫码/滑块/点选才转人工', state:'dom_snapshot_and_login_chain_active'},
  {stage:'execution', scene:'首次执行或回归计划', tools:['regression.select','regression.impact','plan.gates','exec.pools','execution.stub'], input:'已批准用例、计划 IR、版本差异、预算、桩策略', outcome:'冻结执行选集与资源调度；五闸失败不执行', state:'node_active_ir_pending'},
  {stage:'execution', scene:'执行结果封存', tools:['irval.check'], input:'真实浏览器 exec IR', outcome:'结构和来源检查；失败不标通过', state:'ir_adapter_pending'},
  {stage:'api_execution', scene:'接口执行或回归', tools:['exec.api_engine','exec.pools','execution.stub','regression.select','regression.impact','plan.gates'], input:'已批准场景、接口环境、凭据引用、计划 IR 和预算', outcome:'真实接口执行核验结果与请求回执；其余 IR/调度工具待接线', state:'api_engine_active_other_pending'},
  {stage:'api_execution', scene:'接口结果封存', tools:['irval.check'], input:'真实接口 exec IR', outcome:'结构和来源检查；失败不标通过', state:'ir_adapter_pending'},
  {stage:'defects', scene:'执行有失败', tools:['defect.evidence','defect.tools','defects.cluster','irval.check'], input:'失败 exec IR、步骤、截图/日志及历史缺陷', outcome:'Node 展示聚类已接；完整取证包与 v3 IR 待适配，无失败不触发', state:'node_cluster_active_evidence_pending'},
  {stage:'report', scene:'执行结果形成报告', tools:['report.reviewer','coverage.split','m1.consistency','irval.check'], input:'封存结果、设计用例、报告指标；v3 exec IR 另需完整契约', outcome:'Node 事实正文、覆盖拆分与一致性检查自动执行；v3 IR 校验待适配', state:'node_facts_active_ir_pending'},
  {stage:'report', scene:'回归或发版', tools:['regression.select','regression.impact','release.probe'], input:'变更范围、批准用例、构建标识', outcome:'回归选集及探针结果；非发版不调用', state:'ir_adapter_pending'},
  {stage:'cross', scene:'建档、派发、交接和人确认', tools:['onboard.bootstrap','plan.phases','agent.contract','confirm.gate','data.lifecycle'], input:'项目配置、run manifest、派发和确认记录', outcome:'状态推进与审计；缺确认阻止执行', state:'node_active'},
  {stage:'cross', scene:'设计资产或预期变更', tools:['assets.library','expectation.audit'], input:'已批准资产和历史预期', outcome:'版本化资产及变更审计', state:'node_active_review_pending'},
  {stage:'cross', scene:'排错或回归验证', tools:['trace.view','golden.run'], input:'run trace 或固定 golden 样本', outcome:'可追踪诊断；不代替真实任务验收', state:'node_active'},
]);

export const STAGE_TOOL_PROTOCOLS = Object.freeze({
  analysis: {
    required: ['requirement.testability', 'requirement.acceptance', 'irval.check'],
    actions: ['diagnose_analysis', 'generate_analysis', 'validate_analysis'],
    rule: '先用确定性工具解析可测性、验收条件和 IR 结构；工具回执齐全且通过后才生成分析正文。',
  },
  test_points: {
    required: ['testpoint.coverage', 'irval.check'],
    actions: ['diagnose_test_points', 'export_test_points', 'validate_artifacts'],
    rule: '先检查需求覆盖和 IR，再导出测试点；覆盖缺口或校验失败不得交接。',
  },
  test_cases: {
    required: ['plan.gates', 'irval.check'],
    actions: ['diagnose_test_cases', 'export_test_cases', 'validate_artifacts'],
    rule: '先检查计划闸门、预期来源和 IR，再导出用例；未取得回执不得声称用例完成。',
  },
  execution: {
    required: ['dom.snapshot', 'login.captcha_chain'],
    actions: ['browser_task', 'validate_artifacts'],
    rule: 'Web 执行必须留下 DOM 快照和登录策略链真实回执；图形验证码自动闭环，人工只处理短信/扫码/滑块/点选。',
  },
  api_execution: {
    required: ['exec.api_engine'],
    actions: ['api_task', 'validate_artifacts'],
    rule: '接口执行必须由 API worker 产生逐请求回执；不得由 Agent 手写请求结果。',
  },
  defects: {
    required: ['defect.evidence', 'defect.tools', 'irval.check'],
    actions: ['diagnose_task', 'validate_artifacts'],
    rule: '缺陷只能依据真实执行回执和取证包生成；无失败不虚构缺陷，有失败不跳过取证工具。',
  },
  report: {
    required: ['report.reviewer', 'irval.check'],
    actions: ['diagnose_task', 'export_report', 'validate_artifacts'],
    rule: '报告事实、覆盖率和一致性必须由工具回执支撑；未测范围和 partial 必须保留。',
  },
});

export function stageToolProtocol(stage) {
  const protocol = STAGE_TOOL_PROTOCOLS[stage];
  if (!protocol) return `本阶段没有已登记的确定性工具协议；仍须使用可用结构化动作并保留真实回执。`;
  return [
    `阶段工具硬协议：必须调用 ${protocol.required.join('、')}；阶段动作使用 ${protocol.actions.join('、')}。`,
    protocol.rule,
    '每次调用后读取返回的 receipt/tool_checks，回复中写明工具、输入摘要、结果摘要和回执路径。工具未调用、回执缺失、状态 failed 或 disabled 时，不得生成“已完成”结论，只能返回 blocked/partial 及原因。',
  ].join('\n');
}

export function stageScenarioPrompt(stage) {
  return `${stageToolProtocol(stage)}\n${TOOL_SCENARIOS.filter(row => row.stage === stage).map(row =>
    `${row.scene}：${row.tools.join('、')}；输入=${row.input}；结果=${row.outcome}；接线状态=${row.state}`).join('\n')}`;
}
