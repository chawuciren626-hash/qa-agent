import { SEVERITY_LEVELS } from './defect-severity.mjs';

// The delivered report body is assembled from checked artifacts. Agent prose is
// retained as a draft in the generation archive, but cannot override these facts.
export function reportFactBody({ runId, results, issues, metrics = null, evidence = '', fidelity = '', coverage = '' }) {
  const summary = results.summary ?? {};
  const count = key => Number.isInteger(summary[key]) ? summary[key] : 0;
  const rows = Array.isArray(issues) ? issues : issues?.records ?? [];
  const severity = Object.fromEntries(SEVERITY_LEVELS.map(level => [level, 0]));
  let missingSeverity = 0;
  for (const row of rows) {
    if (SEVERITY_LEVELS.includes(row?.severity)) severity[row.severity] += 1;
    else if (row?.severity == null) missingSeverity += 1;
    else severity.unknown += 1;
  }
  const severityLine = `已知严重程度分布：Blocker ${severity.Blocker}、Critical ${severity.Critical}、Major ${severity.Major}、Minor ${severity.Minor}、Trivial ${severity.Trivial}；未评估 ${severity.unknown}；未记录 ${missingSeverity}。未评估/未记录不代表低风险。`;
  const gate = metrics?.quality_gate;
  const status = {
    completed: '已完成', failed: '存在失败', blocked: '受阻', partial: '部分完成'
  }[results.status] ?? '状态未核定';
  const lines = [
    '# 测试报告', '', `运行编号：${runId}`, '',
    '## 关键结论', '',
    `执行状态：${status}。记录总数 ${count('total')}；通过 ${count('passed')}，失败 ${count('failed')}，受阻 ${count('blocked')}，跳过 ${count('skipped')}。`,
    `缺陷或问题记录 ${rows.length} 条。失败记录不自动等同于已确认产品缺陷。`,
    severityLine,
    gate ? `质量门：${gate.status}；原因：${gate.reasons?.length ? gate.reasons.join('、') : '无已登记原因'}。` : '未提供质量门指标，本报告不作质量门通过判断。',
    '', '## 未测与风险', '',
    count('skipped') || count('blocked') ? `跳过 ${count('skipped')} 条、受阻 ${count('blocked')} 条，均不计为通过。` : '结构化结果中未登记跳过或受阻记录；未据此推断业务范围完整覆盖。',
    count('failed') ? `存在 ${count('failed')} 条失败记录，需结合对应证据与问题记录复核。` : '结构化结果中未登记失败记录；未据此推断零风险。',
    results.status === 'partial' || results.status === 'blocked' ? '本次结果不完整，未测范围不能视为已验证。' : '业务范围覆盖以设计与执行关联证据为准，结果记录总数不等于设计用例总数。',
  ];
  for (const item of results.coverage?.untested ?? results.design_coverage?.untested ?? []) {
    if (typeof item === 'string') lines.push(`- 未测：${item.replace(/[\r\n]/g, ' ')}`);
  }
  for (const section of [evidence, fidelity, coverage]) if (section.trim()) lines.push('', section.trim());
  return lines.join('\n') + '\n';
}
