const text = value => typeof value === 'string' && value.trim().length > 0;
export const basisKinds = ['requirement', 'contract', 'ui_explicit'];
export const observationKinds = ['engineering_assumption', 'needs_confirmation'];
export const basisHeaders = ['用例编号', '用途', '预期或观察', '依据类型', '来源文件', '原文摘录', '说明'];
const labels = {requirement:'需求',contract:'接口/业务约定',ui_explicit:'界面明确约束',engineering_assumption:'工程假设',needs_confirmation:'待确认'};

// Checks provenance and clause coverage, not whether a quote logically entails a claim.
export function inspectExpectationBasis(row, sources) {
  const errors = [], warnings = [], clauses = [];
  const entries = row.expected_basis;
  if (entries === undefined) warnings.push('Expected-result basis is not recorded; do not treat legacy text as source-verified.');
  else if (!Array.isArray(entries) || !entries.length) errors.push('expected_basis must be a nonempty array');
  else {
    const covered = new Set();
    for (const [index, entry] of entries.entries()) {
      const prefix = `expected_basis[${index}]`;
      if (!entry || !text(entry.expected) || !basisKinds.includes(entry.kind) || !text(entry.source_path) || !text(entry.quote)) {
        errors.push(`${prefix}: expected, kind, source_path and quote required; assumptions belong in observations, not acceptance assertions`);
        continue;
      }
      if (!sources.has(entry.source_path)) errors.push(`${prefix}: source_path must name an already verified task source`);
      else {
        const source = sources.get(entry.source_path);
        if (source.includes('\0') || !source.includes(entry.quote)) errors.push(`${prefix}: quote must be a verbatim excerpt from the supplied text, not an inferred rule`);
      }
      const start = typeof row.expected === 'string' ? row.expected.indexOf(entry.expected) : -1;
      if (start < 0) errors.push(`${prefix}: expected must be an exact clause in the case expected text`);
      else for (let offset=start; offset<start+entry.expected.length; offset++) covered.add(offset);
      clauses.push({index, kind:entry.kind, source_path:entry.source_path, semantic_verified:false});
    }
    const remaining = typeof row.expected === 'string'
      ? row.expected.split('').filter((_, index)=>!covered.has(index)).join('').replace(/[\s\p{P}]/gu, '') : '';
    if (remaining) errors.push('Every expected clause needs a basis; remove unsupported extras or move optional proposals to observations');
  }
  if (row.observations !== undefined) {
    if (!Array.isArray(row.observations)) errors.push('observations must be an array');
    else for (const entry of row.observations) {
      if (!entry || !text(entry.statement) || !observationKinds.includes(entry.kind) || !text(entry.reason)) errors.push('Each observation needs statement, engineering_assumption/needs_confirmation kind and reason');
    }
  }
  return {case_id:row.case_id, status:errors.length?'needs_correction':entries===undefined?'not_recorded':'source_located',
    errors, warnings, clauses, semantic_verified:false, approval_required:false,
    guidance:'Agent self-check: source matching does not prove semantic support or source authority. Check conditions and each assertion against the quote. A UI observation is not a backend guarantee. Keep optional proposals separate; ask only business ambiguity necessary for the requested scope. Never ask for technical unlocks.'};
}

export function expectationBasisRows(cases) {
  return cases.flatMap(row => [
    ...(Array.isArray(row.expected_basis)?row.expected_basis:[]).map(entry=>[row.case_id,'验收预期',entry.expected,labels[entry.kind] ?? '未知',entry.source_path,entry.quote,'引用可核对，不代表语义已自动验证']),
    ...(Array.isArray(row.observations)?row.observations:[]).map(entry=>[row.case_id,'观察/建议（非验收断言）',entry.statement,labels[entry.kind] ?? '未知','','',entry.reason])
  ]);
}
