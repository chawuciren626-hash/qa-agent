import { isDeepStrictEqual } from 'node:util';

const fields = ['title','expected','actual_result','error_message','reason','verdict_reason','failure_category','evidence_mode','verification_scope','checked_condition','timing','check_fingerprint','case_ref','recheck_of','expected_basis','observations','expectation_provenance','input_provenance','comparison'];
const evidence = row => Array.isArray(row.evidence_paths) ? [...row.evidence_paths].sort() : [];

// Restore only uniquely identified source observations; never select the latest by ID.
export function preserveReportResults(results, index, readSource) {
  const output = structuredClone(results), candidates = [], changes = [];
  for (const fact of index.facts ?? []) {
    const entry = index.files.find(file => file.path === fact.source_path);
    if (!entry) continue;
    try {
      const file = readSource(entry.path);
      if (file.sha256 !== entry.sha256) continue;
      const decoded=typeof file.data==='string'?file.data:new TextDecoder('utf-8',{fatal:true}).decode(file.data);
      const source = JSON.parse(decoded.replace(/^\uFEFF/,''));
      if(entry.path==='execution/test_results.json') {
        if(source.status==='partial') output.status='partial';
        if(source.coverage) output.coverage=structuredClone(source.coverage);
        else delete output.coverage;
      }
      for (const row of source.cases ?? []) candidates.push({ row, entry, fixture: source.fixture === true || row?.fixture === true });
    } catch { /* Optional source failures remain unknown, not a new approval gate. */ }
  }
  for (const row of output.cases) {
    const matches = candidates.filter(item => item.row?.case_id === row.case_id && item.row.status === row.status
      && evidence(row).length > 0 && isDeepStrictEqual(evidence(item.row), evidence(row)));
    if (matches.length !== 1) {
      delete row.checked_condition;
      row.report_source = {kind:'unresolved',reason:matches.length ? 'ambiguous_source' : 'source_not_identified'};
      changes.push({case_id:row.case_id,status:row.report_source.reason});
      continue;
    }
    const source = matches[0], restored = [], retained = [];
    if(!Object.hasOwn(source.row,'checked_condition')) delete row.checked_condition;
    for (const field of fields) if (Object.hasOwn(source.row,field)) {
      // Never undo a model's explicit redaction or rewrite of free text.
      if (['title','expected','actual_result','error_message','reason'].includes(field)
        && Object.hasOwn(row,field) && row[field] !== '' && row[field] !== null && !isDeepStrictEqual(row[field],source.row[field])) {
        retained.push(field); continue;
      }
      if (!isDeepStrictEqual(row[field],source.row[field])) restored.push(field);
      row[field] = structuredClone(source.row[field]);
    }
    row.report_source = {source_path:source.entry.path,source_sha256:source.entry.sha256,
      kind:source.entry.path.startsWith('inputs/')?'imported':'completed_artifact',fixture:source.fixture,retained_text_fields:retained};
    changes.push({case_id:row.case_id,status:'source_matched',restored_fields:restored,retained_text_fields:retained});
  }
  return {results:output,changes};
}

export function resultFidelityMarkdown(results) {
  const cell = value => String(value ?? '未记录').replace(/[|\r\n<>]/g,' ');
  const lines = ['## 结果来源与说明（工具保留）','',
    '状态按记录展示，不等于真实产品验收。导入材料不是本智能体实测；合成样例不证明产品行为，模拟通过不证明真实后端通过。来源未唯一确认时不猜测关联。','',
    '预期是待验证的描述，不是已验证结论。实际检查范围以工具记录的定位目标、条件和比较值为准；仅检查标题不能证明预算、状态等其他字段。未记录检查条件时不推断覆盖范围。', '',
    '| 记录 | 来源与模式 | 预期（非验证结论） | 实际检查条件 | 实际说明（转写另标） |','| --- | --- | --- | --- | --- |'];
  for (const row of results.cases) {
    const source=row.report_source ?? {};
    const kind={imported:'导入记录',completed_artifact:'已完成产物',unresolved:'来源未唯一确认'}[source.kind] ?? '来源未记录';
    const mode={real:'真实模式标记（非真实性证明）',simulated:'模拟场景',simulation_affected:'受模拟影响'}[row.evidence_mode] ?? '模式未记录';
    const basis=row.expectation_provenance?`；预期：${{source_located:'引文已定位，语义未自动确认',needs_correction:'引用未核实',not_recorded:'来源未记录，仅条件观察'}[row.expectation_provenance.status] ?? '未核实'}`:'';
    const comparison={exact_text:'；文本精确比较',normalized_text:'；文本空白归一比较',exact_value:'；输入值精确比较'}[row.comparison] ?? '';
    const checked=row.checked_condition;
    const scope=checked?JSON.stringify(checked):'未记录，不据预期文字推断';
    lines.push(`| ${cell(row.case_id)} | ${kind}${source.fixture?'；合成样例':''}；${mode}${basis}${comparison}${source.retained_text_fields?.length?'；部分文字经转写，非原文':''} | ${cell(row.expected)} | ${cell(scope)} | ${cell(row.actual_result ?? row.error_message ?? row.reason)} |`);
  }
  return lines.join('\n');
}
