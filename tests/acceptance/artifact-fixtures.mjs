import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import xlsx from '../../scripts/spreadsheet-runtime.mjs';
import { writeJsonFile, executionInputs } from './safety-fixtures.mjs';

export function zipFixture(path, entries) {
  const archive = xlsx.CFB.utils.cfb_new();
  for (const [name, content] of Object.entries(entries)) xlsx.CFB.utils.cfb_add(archive, name, Buffer.from(content));
  writeFileSync(path, xlsx.CFB.write(archive, { type: 'buffer', fileType: 'zip' }));
}

export function designArtifacts(root, id) {
  const dir = resolve(root, 'output/runs', id);
  const { plan } = executionInputs(root, id);
  const points = [{ id: 'TP-SYNTHETIC', module: 'Synthetic', feature: 'Read', description: 'Synthetic expected', risk: '低', coverage_type: ['normal'], source: 'analysis/requirement_analysis.md' }];
  points[0].rule_ids = ['RULE-SYNTHETIC'];
  writeJsonFile(resolve(dir, 'design/test_points.json'), { run_id: id, points });
  zipFixture(resolve(dir, 'design/test_points.xmind'), { 'content.json': JSON.stringify([{ rootTopic: { title: 'Synthetic', children: { attached: [{ title: 'Synthetic', children: { attached: [{ title: 'Read', children: { attached: [{ title: 'Synthetic expected' }] } }] } }] } } }]) });
  const cases = JSON.parse(readFileSync(resolve(dir, 'design/test_cases.json'), 'utf8'));
  const exported = spawnSync(process.execPath, ['scripts/generate-test-cases-xlsx.mjs', resolve(dir, 'design/test_cases.json'), resolve(dir, 'design/test_cases.xlsx')], { cwd: root, encoding: 'utf8' });
  if (exported.status !== 0) throw new Error(exported.stderr);
  return { dir, plan, points, cases };
}

export function resultArtifacts(root, id, failed = false) {
  const fixture = designArtifacts(root, id);
  const { dir } = fixture;
  const result = { run_id: id, invocation_id: 'synthetic-invocation', status: failed ? 'failed' : 'completed', started_at: '2026-10-09T00:00:00Z', finished_at: '2026-10-09T00:00:01Z', summary: { total: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0, skipped: 0, blocked: 0 }, cases: [{ case_id: 'TC-SYNTHETIC', status: failed ? 'failed' : 'passed', evidence_paths: [] }] };
  writeJsonFile(resolve(dir, 'execution/test_results.json'), result);
  writeJsonFile(resolve(dir, 'execution/execution-state.json'), { run_id: id, invocation_id: result.invocation_id, status: result.status });
  const records = failed ? [{ defect_id: 'DEF-SYNTHETIC', fingerprint: 'synthetic', category: 'needs_review', lifecycle_status: 'needs_review', confidence: 'low', related_cases: ['TC-SYNTHETIC'], evidence_refs: [], title: 'Synthetic unclassified failure' }] : [];
  const defects = { run_id: id, records, summary: { product_defect: 0, script_issue: 0, environment_issue: 0, test_data_issue: 0, needs_review: records.length } };
  writeJsonFile(resolve(dir, 'defects/defect-records.json'), defects);
  const assessment = { run_id: id, assessments: failed ? [{ case_id: 'TC-SYNTHETIC', evidence_confidence: 'low', triage_ready: false }] : [], summary: { failed_cases: records.length, triage_ready: 0, insufficient: records.length, confidence: { low: records.length, medium: 0, strong: 0 } } };
  writeJsonFile(resolve(dir, 'quality/evidence-assessment.json'), assessment);
  const built = spawnSync(process.execPath, ['scripts/build-quality-metrics.mjs', `--run-id=${id}`], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(built.stderr);
  const metrics = JSON.parse(readFileSync(resolve(dir, 'report/quality-metrics.json'), 'utf8'));
  writeFileSync(resolve(dir, 'report/test_report.md'), `Synthetic report ${id} ${metrics.quality_gate.status}`);
  zipFixture(resolve(dir, 'report/test_report.docx'), { 'word/document.xml': '<w:document/>', '[Content_Types].xml': '<Types/>' });
  writeFileSync(resolve(dir, 'report/test_report.html'), '<!doctype html><html><body>Synthetic report fixture</body></html>');
  // Only a file-signature fixture, not a renderable report or real evidence.
  writeFileSync(resolve(dir, 'report/test_report.pdf'), '%PDF-1.7\nsynthetic structural fixture\n%%EOF');
  return { ...fixture, result, defects, metrics, assessment };
}
