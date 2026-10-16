const text = value => typeof value === 'string' && value.trim().length > 0;
const layers = ['original', 'adjacent', 'valid_path', 'impact'];

// Explicit mappings compare observations only; they never mutate defect governance.
export function buildRegressionDelivery(parsed, files, draft) {
  const sources = new Map(parsed.map(item => [item.path, item.value]));
  const indexed = new Map(files.map(item => [item.path, item]));
  const plans = parsed.filter(item => item.path.startsWith('inputs/') && item.value?.kind === 'regression_comparison');
  // A report task may bind explicit record pairs without rewriting immutable inputs.
  // Only indexed paths can supply hashes; supplied mismatching hashes stay mismatched.
  if (draft !== undefined) {
    const bind = ref => ref && typeof ref === 'object' ? {
      ...ref, source_sha256: ref.source_sha256 ?? indexed.get(ref.source_path)?.sha256
    } : ref;
    plans.splice(0, plans.length, { path: 'report/report-task.json#regression_comparison', value: {
      version: draft?.version,
      comparisons: Array.isArray(draft?.comparisons) ? draft.comparisons.map(item => item && typeof item === 'object'
        ? { ...item, baseline: bind(item.baseline), current: bind(item.current) } : item) : null
    } });
  }
  if (!plans.length) return null;
  const rows = [], warnings = [];
  const resolveRecord = ref => {
    if (!ref || !text(ref.case_id) || !text(ref.source_sha256)) return null;
    const file = indexed.get(ref.source_path), result = sources.get(ref.source_path);
    if (!file || file.sha256 !== ref.source_sha256 || !Array.isArray(result?.cases)) return null;
    const matches = result.cases.filter(row => row?.case_id === ref.case_id);
    if (matches.length !== 1) return null;
    return { row: matches[0], result, path: ref.source_path, kind: file.kind };
  };
  for (const plan of plans) {
    if (plan.value.version !== 1 || !Array.isArray(plan.value.comparisons) || plan.value.comparisons.length > 1000) {
      warnings.push({ source_path: plan.path, reason: 'invalid_comparison_document' });
      continue;
    }
    const ids = new Set();
    for (const item of plan.value.comparisons) {
      if (!item || !text(item.id) || ids.has(item.id)) {
        warnings.push({ source_path: plan.path, reason: 'invalid_or_duplicate_mapping' });
        continue;
      }
      ids.add(item.id);
      const scopeKnown=layers.includes(item.layer);
      if(!scopeKnown) warnings.push({source_path:plan.path,id:item.id,reason:'unclassified_scope'});
      const before = resolveRecord(item.baseline), after = resolveRecord(item.current);
      const output = { id: item.id, layer: scopeKnown?item.layer:'unclassified', mapping_source: plan.path,
        baseline: before ? { source_path: before.path, source_sha256: indexed.get(before.path).sha256, case_id: before.row.case_id, status: before.row.status } : null,
        current: after ? { source_path: after.path, source_sha256: indexed.get(after.path).sha256, case_id: after.row.case_id, status: after.row.status } : null,
        outcome: 'not_verified', reason: 'missing_or_ambiguous_record', provenance: 'imported_or_mixed' };
      rows.push(output);
      if (!before || !after) continue;
      output.provenance = [before,after].some(source => source.kind === 'supplied_input' || source.path.startsWith('inputs/')) ? 'imported_or_mixed' : 'completed_artifacts';
      if(!scopeKnown) {output.reason='unclassified_scope';continue;}
      const a = before.result, b = after.result;
      const independent = text(a.run_id) && text(b.run_id) && text(a.invocation_id) && text(b.invocation_id)
        && (a.run_id !== b.run_id || a.invocation_id !== b.invocation_id);
      const startA = Date.parse(a.started_at), endA = Date.parse(a.finished_at);
      const startB = Date.parse(b.started_at), endB = Date.parse(b.finished_at);
      if (!independent || ![startA,endA,startB,endB].every(Number.isFinite) || startA > endA || startB <= endA || endB < startB) {
        output.reason = 'independent_later_execution_not_established'; continue;
      }
      const x = before.row, y = after.row;
      if (x.evidence_mode !== 'real' || y.evidence_mode !== 'real') {
        output.reason = 'real_evidence_mode_not_established'; continue;
      }
      if (!text(x.expected) || x.expected !== y.expected || !text(x.check_fingerprint) || x.check_fingerprint !== y.check_fingerprint
        || !['ui','api_contract'].includes(x.verification_scope?.layer) || x.verification_scope.layer !== y.verification_scope?.layer) {
        output.reason = 'comparable_check_not_established'; continue;
      }
      const hasEvidence = row => Array.isArray(row.evidence_paths) && row.evidence_paths.length > 0 && row.evidence_paths.every(path => indexed.has(path));
      if (!hasEvidence(x) || !hasEvidence(y)) { output.reason = 'evidence_not_indexed'; continue; }
      if (!['passed','failed'].includes(x.status) || !['passed','failed'].includes(y.status)) {
        output.reason = 'execution_not_conclusive'; continue;
      }
      output.outcome = x.status === 'failed' ? (y.status === 'passed' ? 'now_passing' : 'still_failing')
        : (y.status === 'failed' ? 'new_failure' : 'still_passing');
      output.reason = 'comparable_observations_only';
    }
  }
  return { version: 1, rows, warnings,
    counts: Object.fromEntries(['now_passing','still_failing','new_failure','still_passing','not_verified'].map(value => [value, rows.filter(row => row.outcome === value).length])),
    layers: Object.fromEntries([...layers,...(rows.some(row=>row.layer==='unclassified')?['unclassified']:[])].map(layer => [layer, { mapped: rows.filter(row => row.layer === layer).length,
      compared: rows.filter(row => row.layer === layer && row.outcome !== 'not_verified').length }])),
    interpretation: 'Explicit observation comparisons, not defect closure or complete regression coverage. Imported results are not independently executed. Matching checks do not establish matching environment, business prerequisites, fix version, or absence of other failures.' };
}

export function regressionMarkdown(regression) {
  if (!regression) return '';
  const cell = value => String(value ?? '未关联').replace(/[|\r\n<>]/g, ' ');
  const outcomes = {now_passing:'本次观察通过（原失败保留）',still_failing:'仍观察到失败',new_failure:'新增失败观察',still_passing:'两轮观察通过',not_verified:'无法形成有效对照'};
  const labels = {original:'原始复现',adjacent:'邻近输入',valid_path:'合法路径',impact:'关联影响面',unclassified:'范围未确认'};
  const reasons = {unclassified_scope:'范围分类未确认，不猜测归类',missing_or_ambiguous_record:'记录缺失、哈希不符或编号不唯一',independent_later_execution_not_established:'未确认是独立后续执行',real_evidence_mode_not_established:'非真实模式或模式未记录',comparable_check_not_established:'预期或检查条件不可比',evidence_not_indexed:'证据不完整',execution_not_conclusive:'执行尚无明确结论',comparable_observations_only:'仅限已关联观察'};
  const lines = ['## 回归对照（工具提取）', '',
    '以下仅比较明确关联的观察，不自动关闭缺陷，不证明环境、业务前提或修复版本一致。导入材料不等于本智能体独立实测；局部回归不等于完整重测，未列出的范围未评估。', '',
    '| 对照项 | 范围 | 初测记录 | 本轮记录 | 对照结果 | 来源性质 / 限制 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const row of regression.rows) lines.push(`| ${cell(row.id)} | ${labels[row.layer]} | ${cell(row.baseline ? `${row.baseline.source_path}#${row.baseline.case_id} (${row.baseline.status})` : null)} | ${cell(row.current ? `${row.current.source_path}#${row.current.case_id} (${row.current.status})` : null)} | ${outcomes[row.outcome]} | ${row.provenance === 'imported_or_mixed' ? '含导入材料' : '已完成产物'} / ${reasons[row.reason]} |`);
  lines.push('', '范围记录数（不是用例覆盖率）：');
  for (const [layer, count] of Object.entries(regression.layers)) lines.push(`- ${labels[layer]}：关联 ${count.mapped} 项，有效观察对照 ${count.compared} 项${count.mapped ? '' : '，未评估'}。`);
  if (regression.warnings.length) lines.push(`\n另有 ${regression.warnings.length} 项关联材料格式问题，保留部分交付；不要求用户技术解锁。`);
  return lines.join('\n');
}
