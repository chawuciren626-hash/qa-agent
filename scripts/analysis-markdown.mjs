// Escape untrusted text so quotes cannot inject headings, links or raw HTML.
const literal = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/\r\n|\r|\n/g, '<br>');

export function renderAnalysis(ledger) {
  const lines = ['# 需求分析', '', `运行：${literal(ledger.run_id)}`, '',
    '本文件由规则台账生成；结构一致不代表来源真实、语义充分或阶段已批准。', '', '## 规则台账', ''];
  for (const rule of ledger.rules) {
    lines.push(`### ${literal(rule.id)}`, '', `- 类型：${literal(rule.kind)}`,
      `- 范围：${literal(rule.scope)}`, `- 状态：${literal(rule.status)}`,
      `- 模块：${literal(rule.module ?? '未分类')}`, `- 分类：${literal(rule.category ?? '未分类')}`,
      `- 声明：${literal(rule.statement)}`, `- 原因：${literal(rule.reason ?? '无')}`, '- 原文引用：');
    for (const citation of rule.citations) lines.push(`  - ${literal(citation.source_id)}：${literal(citation.quote)}`);
    lines.push('');
  }
  lines.push('## 来源', '');
  for (const source of ledger.sources) lines.push(`### ${literal(source.id)}`, '',
    `- 类型：${literal(source.kind)}`, `- 快照：${literal(source.path)}`,
    `- 原始来源：${literal(source.origin)}`, `- 定位：${literal(source.locator)}`, '');
  return lines.join('\n');
}

export function assertAnalysisMarkdown(ledger, data) {
  const actual = data.toString('utf8').replace(/\r\n/g, '\n');
  if (actual !== renderAnalysis(ledger)) throw new Error('Analysis Markdown differs from ledger rendering; regenerate from the structured source, do not edit prose independently');
}
