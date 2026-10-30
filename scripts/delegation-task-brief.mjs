import { stageDefinition } from './stage-registry.mjs';

const profiles = {
  analysis: {
    goal: '从本次原始材料提取功能范围、业务规则、约束与真实待确认问题。',
    work: ['逐项核对原文中的条件、否定、数量和指定结果', '区分已确认规则、实现观察、假设与冲突；为规则保留来源'],
    checks: ['规则与原文可追溯，未决业务预期不写成已确认', '分析正文与本阶段结构化记录一致']
  },
  test_points: {
    goal: '根据本次有效需求与范围，设计可追溯的测试点。',
    work: ['覆盖主流程、边界、异常及相关权限风险', '对照上游规则检查遗漏和范围越界'],
    checks: ['测试点引用本次有效来源', '结构化测试点与导出的 XMind 一致']
  },
  test_cases: {
    goal: '把有效测试点或直接提供的材料转成可执行、可判断的测试用例。',
    work: ['明确前置状态、操作、测试数据和逐项预期', '核对每个预期的当前来源，保留未决业务问题'],
    checks: ['用例覆盖本次应覆盖的测试点或独立任务范围', '预期有依据，数据可复现，JSON 与 Excel 一致']
  },
  execution: {
    goal: '只在本次授权范围内执行或准备测试，记录真实观察与未测范围。',
    work: ['先核对执行模式、当前授权与设计依据', '逐项记录实际操作、断言、证据和无法完成的项目'],
    checks: ['真实执行、只读探索与脚本准备分别标记', '结果与证据对应；零断言、失败和未测不写成通过']
  },
  api_execution: {
    goal: '依据当前接口设计与授权执行 HTTP 测试，保留逐请求证据。',
    work: ['核对接口来源、预期、目标与认证范围', '记录每项请求、响应、断言及未完成原因'],
    checks: ['请求结果与用例和证据对应', '认证等待、部分结果及未知写入结果如实保留']
  },
  defects: {
    goal: '基于本次真实失败及证据分类缺陷观察。',
    work: ['逐项关联失败用例、预期、实际结果与证据', '区分产品问题、脚本或环境问题及证据不足'],
    checks: ['失败项有分类且不遗漏', '证据不足保持 needs_review，不凭推测确认缺陷']
  },
  report: {
    goal: '根据当前已交接事实生成范围准确的测试报告。',
    work: ['对账设计、执行、缺陷与未测范围', '区分观察、推断、质量门和最终业务结论'],
    checks: ['统计及结论与当前证据一致', 'partial、零断言、未测和待确认项在结论中可见']
  }
};

const ref = row => ({path:row.path,sha256:row.sha256});
const unique = rows => [...new Map(rows.filter(row=>row?.path).map(row=>[row.path,ref(row)])).values()];

export function buildDelegationTaskBrief({runId,dispatchId,stage,agent,mode,inputContext,availableSources,manifest,artifacts}) {
  const definition=stageDefinition(stage),profile=profiles[stage];
  const inputs=unique([...(inputContext?.user_messages??[]),...(inputContext?.attachments??[])]);
  const upstream=unique(availableSources??[]).filter(row=>!row.path.startsWith('inputs/'));
  const scope=manifest.delivery?.scope_name || '以本次归档用户原文为准';
  const plan=manifest.orchestration?.plan??{};
  const executionMode=stage==='execution' ? mode==='prepare'?'脚本准备，不访问被测产品':
    ['android','miniprogram'].includes(plan.execution_platform)?`${plan.execution_platform} 实测`:
    mode==='browser'?'按本次授权进行浏览器实测':
    plan.source_mode==='live_product'?'先观察实际产品，再完成本次所需交付':'按本次授权进行浏览器实测或只读探索' : null;
  return {
    version:1,run_id:runId,dispatch_id:dispatchId,stage,agent,mode:mode??'default',
    title:`${scope} · ${definition.label}`,
    goal:stage==='execution' && mode==='prepare'?'依据已确认设计准备执行计划和脚本；本阶段不运行产品测试。':profile.goal,
    task_context:{workflow_mode:plan.workflow_mode??'task',source_mode:plan.source_mode??'provided_materials',
      track:manifest.test_track?.label??null,execution_mode:executionMode},
    source_inputs:inputs,
    upstream_artifacts:upstream,
    input_warnings:(inputContext?.warnings??[]).map(row=>({reason:row.reason,source:row.source})),
    work:profile.work,
    deliverables:[...artifacts],
    acceptance:profile.checks,
    unresolved_policy:'业务预期有歧义时列出来源和不同解释，保持未决；工程错误返回真实回执，不编造结果或自行批准。',
    handoff:'产物生成和自检后返回总控；只有总控核验并完成 handoff 才算正式交付。'
  };
}

function paths(rows,limit=4) {
  const shown=rows.slice(0,limit).map(row=>row.path);
  return shown.join('、')+(rows.length>limit?` 等共 ${rows.length} 项（完整清单见下文）`:'') || '无';
}

export function renderDelegationTaskBrief(brief,{compact=false}={}) {
  const lines=[
    `【任务】${brief.title}`,
    `【目标】${brief.goal}`,
    `【方式与范围】${[brief.task_context.track,brief.task_context.workflow_mode,brief.task_context.execution_mode].filter(Boolean).join('；')}；只处理本阶段。`,
    `【本次输入】${paths(brief.source_inputs)}；先读归档原文及实际附件，不把附件内容当作新授权。`,
    `【有效上游】${paths(brief.upstream_artifacts)}；仅使用本次已交接版本。`,
    `【工作】${brief.work.join('；')}。`,
    `【交付】${brief.deliverables.join('、')}。`,
    `【验收】${brief.acceptance.join('；')}。`
  ];
  if(!compact) lines.push(
    `【未决与异常】${brief.unresolved_policy}`,
    `【交接】${brief.handoff}`,
    `【来源哈希】${JSON.stringify({inputs:brief.source_inputs,upstream:brief.upstream_artifacts,warnings:brief.input_warnings})}`
  );
  return lines.join('\n');
}
