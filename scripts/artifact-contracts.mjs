import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resourcePath } from './directory-context.mjs';
import { assertExecutionTargets, executionScriptFiles } from './execution-targets.mjs';
import { isDeepStrictEqual } from 'node:util';
import { schemaCache } from './versioned-schema-cache.mjs';
import xlsx from './spreadsheet-runtime.mjs';
import { inspectDesign, readRunFile, runDirectory, validatePlanDesign } from './design-quality.mjs';
import { validateExecutionPlan } from './execution-plan.mjs';
import { loadLatestExecution, verifyCurrentAttempt } from './execution-attempts.mjs';
import { governedDefects, lifecycleReferences } from './defect-lifecycle.mjs';
import { defectGateReasons, qualityGateStatus } from './quality-gate.mjs';
import { inspectRequirementLedger } from './requirement-provenance.mjs';
import { assertAnalysisMarkdown } from './analysis-markdown.mjs';
import { sealedExecutionOutcome } from './execution-outcome.mjs';
import { diagnoseTestPoints } from './test-point-diagnosis.mjs';
import { isIndependent, usesTaskArtifacts, taskRequiredArtifacts, inspectIndependentArtifacts } from './independent-task.mjs';
import { usesBrowserArtifacts } from './browser-lifecycle.mjs';

import { lifecycleArtifacts } from './stage-registry.mjs';
export const requiredArtifacts = lifecycleArtifacts;
export function stageRequiredArtifacts(root, runId, stage, mode = 'execute') {
  if (usesTaskArtifacts(root,runId,stage)) return [...taskRequiredArtifacts(stage),...(stage==='execution' && usesBrowserArtifacts(root,runId,stage)?['execution/browser-coverage.json']:[])];
  if (mode === 'prepare') return ['execution/execution-plan.json'];
  if (stage === 'execution') {
    try {
      const state = JSON.parse(readRunFile(runDirectory(root,runId),'execution/execution-state.json').data);
      if (state.version === 2 && state.status === 'blocked') return ['execution/execution-blocked.json'];
    } catch { /* Full contract validation still rejects missing or invalid state. */ }
  }
  return requiredArtifacts[stage];
}
const compiledSchema = schemaCache();
const text = value => typeof value === 'string' && value.trim().length > 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sameSet = (a, b) => isDeepStrictEqual([...a].sort(), [...b].sort());

export function validateSchema(name, value, label = name) {
  assert(/^[a-z][a-z0-9_-]*$/.test(name),'Invalid schema name');
  const compiled=compiledSchema(new URL(`../schemas/${name}.schema.json`,import.meta.url));
  assert(compiled.validate(value), `${label}: ${compiled.errors()}`);
}

// This checks package structure, not desktop rendering or the truth of document prose.
function zipEntry(data, name) {
  assert(data.subarray(0, 2).toString() === 'PK', `Expected ZIP package for ${name}`);
  const archive = xlsx.CFB.read(data, { type: 'buffer' });
  const entry = archive.FileIndex[archive.FullPaths.indexOf(`Root Entry/${name}`)];
  assert(entry?.content?.length, `Missing package entry: ${name}`);
  return Buffer.from(entry.content).toString('utf8');
}

export function inspectStageArtifacts(root, runId, stage, { mode = 'execute', artifacts = [] } = {}) {
  if (usesTaskArtifacts(root,runId,stage)) return inspectIndependentArtifacts(root,runId,stage,{artifacts});
  const files = new Map();
  const errors = [];
  let executionOutcome;
  const dir = runDirectory(root, runId);
  const capture = path => {
    const value = readRunFile(dir, path);
    files.set(value.path, { path: value.path, sha256: value.sha256 });
    return value.data;
  };
  const json = path => {
    const value = JSON.parse(capture(path).toString('utf8'));
    if (!Array.isArray(value) && value?.run_id !== undefined) assert(value.run_id === runId, `${path}: run_id mismatch`);
    return value;
  };
  const records = (path, keys, schema, idKey, allowEmpty = false) => {
    const value = json(path);
    const matching = keys.filter(key => Array.isArray(value?.[key]));
    assert(Array.isArray(value) || matching.length === 1, `${path}: expected one supported collection`);
    const rows = Array.isArray(value) ? value : value[matching[0]];
    assert(allowEmpty || rows.length > 0, `${path}: empty collection`);
    const ids = new Set();
    for (const [i, row] of rows.entries()) {
      validateSchema(schema, row, `${path}[${i}]`);
      assert(text(row[idKey]) && !ids.has(row[idKey]), `${path}: missing or duplicate ${idKey}`);
      ids.add(row[idKey]);
    }
    return rows;
  };
  const feedbackIncluded=ledger=>{
    if(!existsSync(resolve(dir,'manifest.json'))) return;
    const manifest=JSON.parse(readRunFile(dir,'manifest.json').data);
    for(const event of manifest.orchestration?.events ?? []) {
      if(event.stage==='analysis' && event.archive && ['confirmation_resolved','stage_recovered'].includes(event.type)) {
        for(const file of event.files ?? []) {
          const archived=readRunFile(dir,`${event.archive}/${file.path}`);
          assert(archived.sha256===file.sha256,`Analysis revision archive changed: ${archived.path}`);
        }
      }
      const input=event.feedback_input;if(!input) continue;
      const file=readRunFile(dir,input.path);
      assert(file.sha256===input.sha256,'Archived user feedback changed');capture(input.path);
      const source=ledger.sources.find(s=>s.path===input.path && s.kind==='user_confirmation');
      assert(source && ledger.rules.some(r=>r.citations.some(c=>c.source_id===source.id)),'User feedback must be registered and cited in the revised analysis, not only in approval notes');
    }
  };
  const points = () => {
    const { rows, ledger, errors: pointErrors } = diagnoseTestPoints(runId, capture);
    assert(!pointErrors.length, pointErrors.join('; '));
    feedbackIncluded(ledger);
    assertAnalysisMarkdown(ledger, capture('analysis/requirement_analysis.md'));
    return rows;
  };
  const cases = () => {
    const rows = records('design/test_cases.json', ['cases', 'test_cases'], 'test_case', 'case_id');
    const pointRows = points();
    const pointIds = new Set(pointRows.map(row => row.id));
    for (const row of rows) {
      assert(text(row.type), `${row.case_id}: empty type`);
      assert(pointIds.has(row.related_test_point), `${row.case_id}: unknown related_test_point`);
      const point = pointRows.find(point => point.id === row.related_test_point);
      assert(row.design_contract.basis.every(basis => point.rule_ids.includes(basis.rule_id)), `${row.case_id}: basis rule not covered by related test point`);
    }
    const design = inspectDesign({ root, runId, source: resolve(dir, 'design/test_cases.json'), execution: false });
    for (const point of pointRows) assert(rows.some(row => row.related_test_point === point.id), `${point.id}: missing test case coverage`);
    assert(!design.errors.length, design.errors.join('; '));
    design.files.forEach(file => capture(file.path));
    return rows;
  };
  const plan = () => {
    const value = json('execution/execution-plan.json');
    validateSchema('execution_plan', value);
    const problems = [...validateExecutionPlan(value), ...validatePlanDesign(root, runId, value)];
    assert(!problems.length, problems.join('; '));
    value.design_gate.files.forEach(file => capture(file.path));
    return value;
  };
  const results = () => {
    const value = json('execution/test_results.json');
    validateSchema('test_result', value);
    assert(value.run_id === runId, 'Results run_id mismatch');
    const executionPlan = plan();
    const ids = value.cases.map(row => row.case_id);
    assert(sameSet(ids, executionPlan.cases.map(row => row.case_id)), 'Result IDs must exactly match planned IDs, without duplicates or omissions');
    assert(ids.length > 0, 'No executed cases');
    for (const status of ['passed', 'failed', 'skipped', 'blocked']) assert(value.summary[status] === value.cases.filter(row => row.status === status).length, `Results summary.${status} mismatch`);
    assert(value.summary.total === ids.length, 'Results summary.total mismatch');
    assert(value.summary.passed + value.summary.failed > 0, 'No executed cases: all planned cases were skipped or blocked');
    assert(Number.isFinite(Date.parse(value.started_at)) && Date.parse(value.finished_at) >= Date.parse(value.started_at), 'Invalid execution timestamps');
    if (value.status === 'completed') assert(value.summary.failed === 0 && value.summary.blocked === 0, 'Completed results contain failures or blocks');
    if (value.status === 'failed') assert(value.summary.failed > 0, 'Failed results contain no failed cases');
    const state = json('execution/execution-state.json');
    assert(state.run_id === runId && text(value.invocation_id) && state.invocation_id === value.invocation_id && state.status === value.status && ['completed', 'failed'].includes(state.status), 'Results do not belong to the latest finished invocation');
    const archived = verifyCurrentAttempt(root, runId, state, value);
    if (archived) {
      capture(`execution/attempts/${state.invocation_id}/attempt.json`);
      for (const file of archived.files.filter(file => file.size > 0)) capture(`execution/attempts/${state.invocation_id}/${file.path}`);
    }
    for (const row of value.cases) for (const ref of row.evidence_paths) capture(ref);
    return value;
  };
  const terminalResults = () => {
    const state = json('execution/execution-state.json');
    if (state.version !== 2) return results();
    if (state.status !== 'blocked') {
      const value = results();
      sealedExecutionOutcome(root, runId);
      executionOutcome = { status: state.status, invocation_id: state.invocation_id, disposition: 'analyze_results', reason: null };
      return value;
    }
    const { results: value, attempt } = sealedExecutionOutcome(root,runId);
    const blocked = json('execution/execution-blocked.json');
    assert(isDeepStrictEqual(blocked,value), 'Blocked view differs from sealed latest attempt');
    validateSchema('test_result',value);
    assert(value.status === 'blocked' && value.cases.length === 0 && ['total','passed','failed','skipped','blocked'].every(key=>value.summary[key]===0), 'Blocked execution must not claim executed cases');
    capture(`execution/attempts/${state.invocation_id}/attempt.json`);
    for (const file of attempt.files.filter(file=>file.size>0)) capture(`execution/attempts/${state.invocation_id}/${file.path}`);
    executionOutcome={status:'blocked',invocation_id:state.invocation_id,disposition:'report_only',reason:state.block_reason};
    return value;
  };
  const assessmentFor = result => {
    const value = json('quality/evidence-assessment.json');
    if (json('execution/execution-state.json').version === 2) assert(value.invocation_id === result.invocation_id, 'Stale evidence assessment invocation');
    const failed = result.cases.filter(row => row.status === 'failed');
    assert(value.run_id === runId && Array.isArray(value.assessments) && sameSet(value.assessments.map(row => row.case_id), failed.map(row => row.case_id)), 'Incomplete evidence assessment');
    const levels = ['low', 'medium', 'strong'];
    const policy = JSON.parse(readFileSync(resolve(root, 'config/quality-governance.json'), 'utf8'));
    for (const row of value.assessments) {
      assert(levels.includes(row.evidence_confidence) && row.triage_ready === (row.evidence_confidence !== 'low'), 'Invalid assessment confidence');
      const execution = failed.find(item => item.case_id === row.case_id);
      const refs = [...new Set(execution.evidence_paths.map(ref => readRunFile(dir, ref).path))];
      const confidence = text(execution.error_message) && refs.length >= (policy.confidence?.strong?.minimum_evidence_refs ?? 3) ? 'strong' : text(execution.error_message) && refs.length >= (policy.confidence?.medium?.minimum_evidence_refs ?? 2) ? 'medium' : 'low';
      assert(row.evidence_confidence === confidence, 'Assessment confidence differs from actual failure evidence');
      for (const ref of row.existing_evidence_refs ?? []) capture(ref);
    }
    const expected = { failed_cases: failed.length, triage_ready: value.assessments.filter(row => row.triage_ready).length, insufficient: value.assessments.filter(row => !row.triage_ready).length, confidence: Object.fromEntries(levels.map(level => [level, value.assessments.filter(row => row.evidence_confidence === level).length])) };
    assert(isDeepStrictEqual(value.summary, expected), 'Evidence assessment summary mismatch');
    return value;
  };
  const reportResults = () => {
    const value = json('report/reportable-results.json');
    if (value.status !== 'blocked') return results();
    const state = json('execution/execution-state.json');
    assert(state.run_id === runId && ['blocked', 'running'].includes(state.status) && text(state.invocation_id) && state.invocation_id === value.invocation_id, 'Blocked report does not match latest blocked/running invocation');
    assert(value.run_id === runId && Array.isArray(value.cases) && value.cases.length === 0 && ['total', 'passed', 'failed', 'skipped', 'blocked'].every(key => value.summary?.[key] === 0), 'Blocked report must not reuse historical case statistics');
    if (state.version === 2) {
      assert(loadLatestExecution(root, runId).results.status === 'blocked', 'Latest sealed attempt is not blocked');
      capture(`execution/attempts/${state.invocation_id}/attempt.json`);
    }
    return value;
  };
  const defects = result => {
    const data = json('defects/defect-records.json');
    if (json('execution/execution-state.json').version === 2) assert(data.invocation_id === result.invocation_id, 'Stale defect analysis invocation');
    assert(data.run_id === runId && Array.isArray(data.records), 'Defect envelope requires run_id and records');
    const rows = records('defects/defect-records.json', ['records'], 'defect_record', 'defect_id', true);
    const failedIds = new Set(result.cases.filter(row => row.status === 'failed').map(row => row.case_id));
    const seen = new Map();
    for (const row of rows) {
      assert(text(row.title) && text(row.fingerprint) && row.related_cases.length > 0 && new Set(row.related_cases).size === row.related_cases.length, `${row.defect_id}: title, fingerprint and unique related_cases required`);
      assert(row.related_cases.every(id => failedIds.has(id)), `${row.defect_id}: unknown or nonfailed related case`);
      row.evidence_refs.forEach(capture);
      if (row.duplicate_of != null) assert(seen.has(row.duplicate_of) && seen.get(row.duplicate_of).fingerprint === row.fingerprint, `${row.defect_id}: invalid duplicate_of`);
      seen.set(row.defect_id, row);
    }
    for (const id of failedIds) assert(rows.some(row => row.related_cases.includes(id)), `${id}: missing failure classification`);
    for (const category of ['product_defect', 'script_issue', 'environment_issue', 'test_data_issue', 'needs_review']) assert(data.summary?.[category] === rows.filter(row => row.category === category).length, `Defect summary.${category} mismatch`);
    return governedDefects(root, runId, data).current;
  };
  try {
    assert(Object.hasOwn(requiredArtifacts, stage), 'Unknown artifact stage');
    assert(mode === 'execute' || (mode === 'prepare' && stage === 'execution'), 'Invalid artifact mode');
    const required = stageRequiredArtifacts(root,runId,stage,mode);
    [...new Set([...required, ...artifacts])].forEach(capture);
    if (stage === 'analysis') {
      assert(text(capture(required[0]).toString('utf8')), 'Empty analysis text');
      const { ledger } = inspectRequirementLedger(runId, capture);
      feedbackIncluded(ledger);
      assertAnalysisMarkdown(ledger, capture(required[0]));
    }
    if (stage === 'test_points') {
      const rows = points();
      const sheets = JSON.parse(zipEntry(capture('design/test_points.xmind'), 'content.json'));
      const paths = [];
      assert(Array.isArray(sheets) && sheets.length === 1 && sheets[0].rootTopic, 'XMind requires one root sheet');
      const walk = (topic, path = []) => {
        assert(text(topic.title), 'Empty XMind topic');
        const children = topic.children?.attached ?? [];
        if (!children.length) paths.push([...path, topic.title]);
        else children.forEach(child => walk(child, [...path, topic.title]));
      };
      walk(sheets[0].rootTopic);
      const actual = paths.map(path => JSON.stringify(path.slice(1)));
      const expected = rows.map(row => JSON.stringify([row.module, row.feature, row.description.replace(/^TP-[\w-]+\s*[:：、.\-]?\s*/, '')]));
      assert(sameSet(actual, expected), 'XMind module/scenario/description differs from test_points.json');
    }
    if (stage === 'test_cases') {
      const rows = cases();
      const data = capture('design/test_cases.xlsx');
      zipEntry(data, 'xl/workbook.xml');
      const book = xlsx.read(data, { type: 'buffer' });
      assert(book.Sheets['测试用例'], 'Missing test case worksheet');
      const modern = book.Sheets['测试用例'].A5?.v === '编号';
      const table = xlsx.utils.sheet_to_json(book.Sheets['测试用例'], { header: 1, defval: '', ...(modern ? { range: 4 } : {}) });
      const plain = value => value == null ? '' : Array.isArray(value) ? value.map(plain).join('\n') : typeof value === 'object' ? Object.entries(value).map(([k,v]) => `${k}: ${plain(v)}`).join('\n') : String(value);
      const expected = modern ? rows.map(row => [row.case_id, row.execution_metadata?.module ?? row.module ?? '未分组', row.priority, row.title, row.preconditions.join('\n'), row.steps.map((step,i)=>`${i+1}. ${step}`).join('\n') + (plain(row.test_data) ? `\n测试数据:\n${plain(row.test_data)}` : ''), row.expected, '尚未执行。', '未执行', '', '']) : rows.map(row => [row.case_id, row.title, row.priority, row.type, row.preconditions.join('\n'), JSON.stringify(row.test_data ?? {}), row.steps.map((step, i) => `${i + 1}. ${step}`).join('\n'), row.expected, row.automation_feasible ? '是' : '否', row.related_test_point]);
      const headers = modern ? JSON.parse(readFileSync(resolve(root, 'config/test-delivery-template.json'), 'utf8')).case_headers : ['用例 ID', '用例标题', '优先级', '类型', '前置条件', '测试数据', '测试步骤', '预期结果', '可自动化', '关联测试点'];
      assert(isDeepStrictEqual(table[0], headers), 'Unexpected Excel headers');
      if (modern) assert(book.Sheets['问题清单'], 'Missing issue worksheet');
      assert(isDeepStrictEqual(table.slice(1), expected), 'Excel rows differ from test_cases.json');
    }
    if (stage === 'execution') {
      if (mode === 'prepare') {
        const prepared = plan();
        assert(resolve(resourcePath(root,prepared.execution_policy.test_dir)) === resolve(dir,'execution/scripts'), 'Preparation plan must use this run execution/scripts directory');
        assert(artifacts.some(path => /\.(spec|test)\.[cm]?[jt]sx?$/.test(path)), 'Preparation requires generated test scripts');
        assertExecutionTargets(root, prepared, executionScriptFiles(resourcePath(root,prepared.execution_policy.test_dir)));
      } else terminalResults();
    }
    if (stage === 'defects' || stage === 'report') {
      const result = stage === 'report' ? reportResults() : terminalResults();
      const rows = defects(result);
      const assessment = assessmentFor(result);
      const levels = ['low', 'medium', 'strong'];
      for (const row of rows) assert(row.related_cases.every(id => levels.indexOf(row.confidence) <= levels.indexOf(assessment.assessments.find(item => item.case_id === id).evidence_confidence)), `${row.defect_id}: confidence exceeds evidence assessment`);
      if (stage === 'report') {
        const metrics = json('report/quality-metrics.json');
        const lifecycle = governedDefects(root, runId, json('defects/defect-records.json'));
        assert(isDeepStrictEqual(metrics.governance, { ...lifecycle, integrity_error: null }), 'Report lifecycle data is stale');
        lifecycleReferences(root, runId).forEach(capture);
        validateSchema('quality_metrics', metrics);
        const reportable = json('report/reportable-results.json');
        assert(isDeepStrictEqual(reportable, result), 'Reportable results differ from latest execution');
        for (const key of ['total', 'passed', 'failed', 'skipped', 'blocked']) assert(metrics.execution[key] === result.summary[key], `Report metric execution.${key} mismatch`);
        assert(metrics.execution.status === result.status && metrics.defects.total === rows.length, 'Report status/defect count mismatch');
        const failedCases = result.cases.filter(row => row.status === 'failed');
        const categories = Object.fromEntries([...new Set(failedCases.map(row => row.failure_category ?? 'needs_review'))].map(value => [value, failedCases.filter(row => (row.failure_category ?? 'needs_review') === value).length]));
        assert(isDeepStrictEqual(metrics.execution.failure_categories, categories), 'Report execution failure categories mismatch');
        if (result.status !== 'blocked') {
          const designed = cases();
          const expectedDesign = { total_cases: designed.length, traceable_cases: designed.filter(row => Boolean(row.related_test_point)).length, automation_feasible_cases: designed.filter(row => row.automation_feasible).length, asset_referenced_cases: designed.filter(row => row.asset_refs?.length > 0).length };
          assert(isDeepStrictEqual(metrics.design, expectedDesign), 'Report design counts mismatch');
          assert(metrics.execution.plan_case_count === plan().cases.length, 'Report plan_case_count mismatch');
        }
        const rate = result.summary.total ? Number((result.summary.passed / result.summary.total * 100).toFixed(2)) : null;
        assert(metrics.execution.pass_rate === rate, 'Report pass_rate mismatch');
        assert(metrics.run_id === runId && ['blocked', 'review_required', 'risk_present', 'informational'].includes(metrics.quality_gate.status), 'Invalid quality gate');
        assert(isDeepStrictEqual(metrics.trust.evidence, assessment.summary), 'Report evidence summary mismatch');
        assert(isDeepStrictEqual(metrics.trust.execution_state, json('execution/execution-state.json')), 'Report execution state is stale');
        for (const [field, key] of [['categories', 'category'], ['lifecycle', 'lifecycle_status'], ['confidence', 'confidence'], ['severity', 'severity']]) {
          const counts = Object.fromEntries([...new Set(rows.map(row => row[key]))].map(value => [value, rows.filter(row => row[key] === value).length]));
          assert(isDeepStrictEqual(metrics.defects[field], counts), `Report defects.${field} mismatch`);
        }
        const governance = JSON.parse(readFileSync(resolve(root, 'config/quality-governance.json'), 'utf8'));
        const reasons = [];
        if (result.status === 'blocked') reasons.push('latest_execution_not_reportable', 'no_executed_cases');
        if (result.status === 'blocked' || result.summary.blocked > 0) reasons.push('blocked_execution');
        if (assessment.summary.insufficient > 0) reasons.push('insufficient_failed_evidence');
        reasons.push(...defectGateReasons(rows, lifecycle.history));
        if ([...rows, ...lifecycle.history].some(row => !['closed', 'rejected'].includes(row.lifecycle_status) && governance.quality_gate.risk_on_severity.includes(row.severity))) reasons.push('high_severity_defect');
        const gate = qualityGateStatus(governance.quality_gate, reasons);
        assert(metrics.quality_gate.status === gate && sameSet(metrics.quality_gate.reasons, reasons), 'Report quality gate differs from current evidence/defects');
        const markdown = capture('report/test_report.md').toString('utf8');
        assert(markdown.includes(runId) && markdown.includes(metrics.quality_gate.status), 'Report must state run_id and quality gate');
        assert(zipEntry(capture('report/test_report.docx'), 'word/document.xml').includes('w:document'), 'Invalid Word document');
        zipEntry(capture('report/test_report.docx'), '[Content_Types].xml');
        const pdf = capture('report/test_report.pdf');
        assert(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.subarray(-1024).toString().includes('%%EOF'), 'Invalid PDF header/end marker');
        // Older sealed runs did not export these formats. Capture new deliveries when present.
        if (existsSync(resolve(dir, 'report/test_report.html'))) capture('report/test_report.html');
        if (existsSync(resolve(dir, 'report/test_cases.xlsx'))) {
          const book = xlsx.read(capture('report/test_cases.xlsx'), { type: 'buffer' });
          assert(book.Sheets['测试用例'] && book.Sheets['问题清单'], 'Missing report workbook sheets');
          const table = xlsx.utils.sheet_to_json(book.Sheets['测试用例'], { header: 1, range: 5, defval: '' });
          const statuses = { passed: '通过', failed: '失败', skipped: '未执行', blocked: '受阻' };
          for (const row of result.cases) assert(table.some(c => c[0] === row.case_id && c[8] === statuses[row.status]), `Report workbook result mismatch: ${row.case_id}`);
        }
      }
    }
  } catch (error) { errors.push(error.message); }
  return { version: 1, run_id: runId, stage, mode, status: errors.length ? 'blocked' : 'passed', files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), ...(executionOutcome?{execution_outcome:executionOutcome}:{}), errors };
}

export function assertArtifactContract(root, runId, stage, options) {
  const result = inspectStageArtifacts(root, runId, stage, options);
  assert(result.status === 'passed', `Artifact contract blocked (${stage}): ${result.errors.join('; ')}`);
  const { errors, ...receipt } = result;
  return receipt;
}

export function assertCompletedArtifacts(root, runId, manifest, stage) {
  const event = (manifest.orchestration?.events ?? []).filter(e => e.stage === stage && e.type === 'completed').at(-1);
  const receipt = event?.evidence?.artifact_contract;
  assert(receipt?.version === 1 && receipt.run_id === runId && receipt.stage === stage && receipt.status === 'passed' && receipt.files?.length, `${stage}: missing artifact contract receipt; revalidate through a new completion, do not fabricate history`);
  for (const file of receipt.files) assert(readRunFile(runDirectory(root, runId), file.path).sha256 === file.sha256, `${stage}: artifact changed after completion: ${file.path}`);
  return receipt;
}

export function assertDependencyArtifacts(root, runId, manifest, stage) {
  const visited = new Set();
  const visit = current => {
    if (visited.has(current)) return;
    visited.add(current);
    const planned = manifest.orchestration?.plan?.stages?.find(s => s.id === current);
    for (const dependency of planned?.depends_on ?? []) {
      if (manifest.stages?.[dependency]?.status === 'skipped') continue;
      assertCompletedArtifacts(root, runId, manifest, dependency);
      visit(dependency);
    }
  };
  visit(stage);
}
