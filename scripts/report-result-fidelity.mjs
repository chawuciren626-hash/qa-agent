import { isDeepStrictEqual } from 'node:util';

const fields = ['title','expected','actual_result','error_message','reason','evidence_mode','verification_scope','timing','check_fingerprint','case_ref','recheck_of','expected_basis','observations'];
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
      for (const row of source.cases ?? []) candidates.push({ row, entry, fixture: source.fixture === true || row?.fixture === true });
    } catch { /* Optional source failures remain unknown, not a new approval gate. */ }
  }
  for (const row of output.cases) {
    const matches = candidates.filter(item => item.row?.case_id === row.case_id && item.row.status === row.status
      && evidence(row).length > 0 && isDeepStrictEqual(evidence(item.row), evidence(row)));
    if (matches.length !== 1) {
      row.report_source = {kind:'unresolved',reason:matches.length ? 'ambiguous_source' : 'source_not_identified'};
      changes.push({case_id:row.case_id,status:row.report_source.reason});
      continue;
    }
    const source = matches[0], restored = [], retained = [];
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
    '| 记录 | 来源与模式 | 预期 | 实际说明（转写另标） |','| --- | --- | --- | --- |'];
  for (const row of results.cases) {
    const source=row.report_source ?? {};
    const kind={imported:'导入记录',completed_artifact:'已完成产物',unresolved:'来源未唯一确认'}[source.kind] ?? '来源未记录';
    const mode={real:'真实模式标记（非真实性证明）',simulated:'模拟场景',simulation_affected:'受模拟影响'}[row.evidence_mode] ?? '模式未记录';
    lines.push(`| ${cell(row.case_id)} | ${kind}${source.fixture?'；合成样例':''}；${mode}${source.retained_text_fields?.length?'；部分文字经转写，非原文':''} | ${cell(row.expected)} | ${cell(row.actual_result ?? row.error_message ?? row.reason)} |`);
  }
  return lines.join('\n');
}
