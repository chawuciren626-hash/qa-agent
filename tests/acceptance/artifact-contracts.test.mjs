import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectStageArtifacts, assertArtifactContract, assertCompletedArtifacts, assertDependencyArtifacts } from '../../scripts/artifact-contracts.mjs';
import { designArtifacts, resultArtifacts, zipFixture } from './artifact-fixtures.mjs';
import { writeJsonFile } from './safety-fixtures.mjs';
import { diagnoseTestPoints } from '../../scripts/test-point-diagnosis.mjs';
import { readRunFile } from '../../scripts/design-quality.mjs';
import { renderAnalysis } from '../../scripts/analysis-markdown.mjs';

const root = resolve(import.meta.dirname, '../..');
function fixture(full = false, failed = false) {
  const id = `run-contract-${randomUUID()}`;
  const dir = resolve(root, 'output/runs', id);
  for (const folder of ['analysis', 'design', 'execution', 'defects', 'report']) mkdirSync(resolve(dir, folder), { recursive: true });
  return { id, ...(full ? resultArtifacts(root, id, failed) : designArtifacts(root, id)) };
}
const inspect = (f, stage, options) => inspectStageArtifacts(root, f.id, stage, options);
const passed = (f, stage, options) => assert.equal(inspect(f, stage, options).status, 'passed', JSON.stringify(inspect(f, stage, options).errors));
const denied = (f, stage, pattern) => {
  const result = inspect(f, stage);
  assert.equal(result.status, 'blocked');
  assert.match(result.errors.join(';'), pattern);
};
const save = (f, path, value) => writeJsonFile(resolve(f.dir, path), value);

test('test point draft aggregates independent errors and all missing coverage without exports', () => {
  const f = fixture();
  const ledger = JSON.parse(readFileSync(resolve(f.dir,'analysis/requirement-ledger.json')));
  const original = ledger.rules[0];
  ledger.rules.push({...original,id:'RULE-SECOND'}, {...original,id:'RULE-OBS',kind:'observation',status:'observed',reason:'Synthetic observation'});
  save(f,'analysis/requirement-ledger.json',ledger);
  save(f,'design/test_points.json',[
    {...f.points[0],id:'TP-A',module:'',rule_ids:['RULE-OBS','RULE-UNKNOWN']},
    {...f.points[0],id:'TP-B',coverage_type:[],source:'../outside.md'},
    {...f.points[0],id:'TP-B',risk:'invalid'}
  ]);
  const read = p => readRunFile(f.dir,p).data;
  const before = read('design/test_points.json');
  const result = diagnoseTestPoints(f.id,read);
  assert.equal(result.status,'needs_correction');
  for (const message of ['empty module','RULE-OBS','RULE-UNKNOWN','coverage_type','current run','duplicate','allowed values']) assert.ok(result.errors.some(e=>e.includes(message)),message);
  assert.deepEqual(result.coverage.missing,[original.id,'RULE-SECOND']);
  assert.equal(result.error_count,result.errors.length);
  assert.equal(result.coverage_counts.missing,2);
  assert.equal(result.exports_checked,false);
  assert.deepEqual(read('design/test_points.json'),before);
  const formal = inspect(f,'test_points');
  for (const error of result.errors) assert.ok(formal.errors.join('; ').includes(error));
});

test('explicit supporting categories do not demand artificial points; behavior and confirmed answers still do', () => {
  const f = fixture();
  const ledger = JSON.parse(readFileSync(resolve(f.dir,'analysis/requirement-ledger.json')));
  const original = ledger.rules[0];
  ledger.rules.push({...original,id:'RULE-CONTEXT',category:'context'}, {...original,id:'RULE-ENV',category:'environment'});
  save(f,'analysis/requirement-ledger.json',ledger);
  writeFileSync(resolve(f.dir,'analysis/requirement_analysis.md'),renderAnalysis(ledger));
  const read = p => readRunFile(f.dir,p).data;
  const diagnosis = diagnoseTestPoints(f.id,read);
  assert.equal(diagnosis.status,'passed',diagnosis.errors.join('; '));
  assert.deepEqual(diagnosis.coverage.supporting,['RULE-CONTEXT','RULE-ENV']);
  assert.deepEqual(diagnosis.coverage_counts,{required:1,supporting:2,optional:0,excluded:0,missing:0});
  passed(f,'test_points');
  save(f,'design/test_points.json',[...f.points,{...f.points[0],id:'TP-CONTEXT',rule_ids:['RULE-CONTEXT']}]);
  assert.match(diagnoseTestPoints(f.id,read).errors.join('; '),/supporting information/);
  save(f,'design/test_points.json',f.points);
  const source = ledger.sources[0];
  ledger.sources.push({...source,id:'USER-ANSWER',kind:'user_confirmation'});
  ledger.rules.push({...original,id:'RULE-NF',category:'constraint'}, {...original,id:'RULE-LEGACY'},
    {...original,id:'RULE-ANSWER',kind:'assumption',status:'confirmed',citations:[{...original.citations[0],source_id:'USER-ANSWER'}]},
    {...original,id:'RULE-PENDING',kind:'assumption',status:'pending',reason:'Unanswered'},
    {...original,id:'RULE-EXCLUDED',scope:'out_of_scope',reason:'Explicit synthetic exclusion'});
  save(f,'analysis/requirement-ledger.json',ledger);
  const missing = diagnoseTestPoints(f.id,read);
  assert.deepEqual(missing.coverage.missing,['RULE-NF','RULE-LEGACY','RULE-ANSWER']);
  assert.deepEqual(missing.coverage.optional,['RULE-PENDING']);
  assert.deepEqual(missing.coverage.excluded,['RULE-EXCLUDED']);
});

test('draft diagnostics tolerate malformed collections and report unavailable ledger coverage honestly', () => {
  const f = fixture();
  const read = p => readRunFile(f.dir,p).data;
  for (const value of [null,{}, {points:[],test_points:[]},[null,42,{}]]) {
    save(f,'design/test_points.json',value);
    assert.equal(diagnoseTestPoints(f.id,read).status,'needs_correction');
  }
  writeFileSync(resolve(f.dir,'analysis/requirement-ledger.json'),'{');
  save(f,'design/test_points.json',{run_id:'run-other',points:f.points});
  const result = diagnoseTestPoints(f.id,read);
  assert.equal(result.coverage_evaluated,false);
  assert.match(result.errors.join('; '),/run_id mismatch/);
  assert.deepEqual(result.coverage.missing,[]);
});

test('all stage contracts accept explicit synthetic valid fixtures, including empty defect collection', () => {
  for (const failed of [false, true]) {
    const f = fixture(true, failed);
    for (const stage of ['analysis', 'test_points', 'test_cases', 'execution', 'defects', 'report']) passed(f, stage);
    const plan = JSON.parse(readFileSync(resolve(f.dir,'execution/execution-plan.json')));
    plan.execution_policy.test_dir = resolve(f.dir,'execution/scripts');
    save(f,'execution/execution-plan.json',plan);
    passed(f, 'execution', { mode: 'prepare', artifacts: ['execution/scripts/synthetic.spec.ts'] });
  }
});

test('design contracts reject malformed JSON, schema errors, duplicate IDs and foreign sources', () => {
  const f = fixture();
  save(f, 'design/test_points.json', { points: [...f.points, ...f.points] });
  denied(f, 'test_points', /duplicate/);
  save(f, 'design/test_points.json', { run_id: 'run-other', points: f.points });
  denied(f, 'test_points', /run_id/);
  save(f, 'design/test_points.json', [{ ...f.points[0], risk: 'invalid' }]);
  denied(f, 'test_points', /allowed values/);
  save(f, 'design/test_points.json', [{ ...f.points[0], source: '../outside.md' }]);
  denied(f, 'test_points', /current run/);
  writeFileSync(resolve(f.dir, 'design/test_points.json'), '{');
  denied(f, 'test_points', /JSON|property/i);
});

test('design references and exported XMind/Excel must agree with structured source', () => {
  const f = fixture();
  save(f, 'design/test_cases.json', [{ ...f.cases[0], related_test_point: 'TP-UNKNOWN' }]);
  denied(f, 'test_cases', /related_test_point/);
  save(f, 'design/test_cases.json', [{ ...f.cases[0], title: 'Changed without re-export' }]);
  denied(f, 'test_cases', /Excel rows/);
  save(f, 'design/test_cases.json', f.cases);
  zipFixture(resolve(f.dir, 'design/test_points.xmind'), { 'content.json': JSON.stringify([{ rootTopic: { title: 'Incorrect' } }]) });
  denied(f, 'test_points', /differs/);
  writeFileSync(resolve(f.dir, 'design/test_cases.xlsx'), 'not an Excel file');
  denied(f, 'test_cases', /ZIP/);
});

test('result contracts reject omissions, duplicates, invented IDs, summary mismatch and stale invocation', () => {
  const f = fixture(true);
  for (const cases of [[], [f.result.cases[0], f.result.cases[0]], [{ ...f.result.cases[0], case_id: 'TC-UNKNOWN' }]]) {
    save(f, 'execution/test_results.json', { ...f.result, cases });
    denied(f, 'execution', /exactly match/);
  }
  save(f, 'execution/test_results.json', { ...f.result, summary: { ...f.result.summary, passed: 9 } });
  denied(f, 'execution', /summary.passed/);
  save(f, 'execution/test_results.json', { ...f.result, summary: { total: 1, passed: 0, failed: 0, skipped: 1, blocked: 0 }, cases: [{ ...f.result.cases[0], status: 'skipped' }] });
  denied(f, 'execution', /No executed cases/);
  save(f, 'execution/test_results.json', { ...f.result, invocation_id: 'old-invocation' });
  denied(f, 'execution', /latest finished invocation/);
  save(f, 'execution/test_results.json', { ...f.result, cases: [{ ...f.result.cases[0], evidence_paths: ['../foreign.txt'] }] });
  denied(f, 'execution', /current run/);
});

test('defect contracts reject unknown cases, missing triage, duplicate IDs and incorrect summaries', () => {
  const f = fixture(true, true);
  save(f, 'defects/defect-records.json', { ...f.defects, records: [] });
  denied(f, 'defects', /missing failure classification/);
  save(f, 'defects/defect-records.json', { ...f.defects, records: [{ ...f.defects.records[0], related_cases: ['TC-UNKNOWN'] }] });
  denied(f, 'defects', /unknown/);
  save(f, 'defects/defect-records.json', { ...f.defects, records: [...f.defects.records, ...f.defects.records] });
  denied(f, 'defects', /duplicate/);
  save(f, 'defects/defect-records.json', { ...f.defects, summary: {} });
  denied(f, 'defects', /summary/);
});

test('report contracts reject stale results, inconsistent counts and invalid exported packages', () => {
  const f = fixture(true);
  save(f, 'report/reportable-results.json', { ...f.result, invocation_id: 'old' });
  denied(f, 'report', /Reportable results/);
  save(f, 'report/reportable-results.json', f.result);
  save(f, 'report/quality-metrics.json', { ...f.metrics, execution: { ...f.metrics.execution, total: 9 } });
  denied(f, 'report', /execution.total/);
  save(f, 'report/quality-metrics.json', f.metrics);
  writeFileSync(resolve(f.dir, 'report/test_report.pdf'), 'fake PDF');
  denied(f, 'report', /PDF/);
  writeFileSync(resolve(f.dir, 'report/test_report.docx'), 'fake Word');
  denied(f, 'report', /ZIP/);
});

test('report contracts preserve truthful blocked reporting without reusing old success', () => {
  const f = fixture(true);
  save(f, 'execution/execution-state.json', { run_id: f.id, invocation_id: 'new-block', status: 'blocked' });
  const built = spawnSync(process.execPath, ['scripts/build-quality-metrics.mjs', `--run-id=${f.id}`], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  writeFileSync(resolve(f.dir, 'report/test_report.md'), `Synthetic ${f.id} blocked`);
  passed(f, 'report');
  denied(f, 'execution', /latest finished invocation/);
  save(f, 'report/reportable-results.json', { ...f.result, status: 'blocked', invocation_id: 'new-block' });
  denied(f, 'report', /historical case statistics/);
});

test('JSON XMind exporter feeds the contract without Markdown re-entry', () => {
  const f = fixture();
  const result = spawnSync(process.execPath, ['scripts/generate-test-points-xmind.mjs', resolve(f.dir, 'design/test_points.json'), resolve(f.dir, 'design/test_points.xmind')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  passed(f, 'test_points');
});

test('receipts bind all captured files and downstream dependencies; historical receipts are not fabricated', () => {
  const f = fixture();
  const receipt = assertArtifactContract(root, f.id, 'test_points');
  const manifest = { stages: { test_points: { status: 'completed' } }, orchestration: { events: [{ type: 'completed', stage: 'test_points', evidence: { artifact_contract: receipt } }], plan: { stages: [{ id: 'test_cases', depends_on: ['test_points'] }] } } };
  assertDependencyArtifacts(root, f.id, manifest, 'test_cases');
  writeFileSync(resolve(f.dir, 'analysis/requirement_analysis.md'), 'Changed source');
  assert.throws(() => assertCompletedArtifacts(root, f.id, manifest, 'test_points'), /changed after completion/);
  assert.throws(() => assertDependencyArtifacts(root, f.id, manifest, 'test_cases'), /changed after completion/);
  assert.throws(() => assertCompletedArtifacts(root, f.id, {}, 'analysis'), /missing artifact contract/);
});

test('CLI preflight is read-only and returns structured errors and failure exit code', () => {
  const f = fixture();
  const path = resolve(f.dir, 'design/test_points.json');
  save(f, 'design/test_points.json', []);
  const before = readFileSync(path, 'utf8');
  const result = spawnSync(process.execPath, ['scripts/validate-artifacts.mjs', f.id, 'test_points'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'blocked');
  assert.equal(readFileSync(path, 'utf8'), before);
});
