import { dataPath } from './directory-context.mjs';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLatestExecution } from './execution-attempts.mjs';
const root = resolve(import.meta.dirname, '..');
const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9);
if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '')) throw new Error('Valid --run-id required');
const dir = dataPath(root, 'output/runs', runId);
const read = file => JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
const fixture = read('inputs/acceptance.json');
const oracle = JSON.parse(readFileSync(resolve(root, 'acceptance/oracle.json'), 'utf8')).scenarios[fixture.scenario];
const result = loadLatestExecution(root, runId).results;
const failed = result.cases.filter(item => item.status === 'failed').map(item => item.case_id).sort();
const ids = result.cases.map(item => item.case_id).sort();
const expectedIds = Array.from({length:6}, (_, i) => `TC-BASE-0${i+1}`);
const checks = {
  run_identity: result.run_id === runId,
  exact_case_set: JSON.stringify(ids) === JSON.stringify(expectedIds),
  summary: result.summary.total === oracle.total && result.summary.passed === oracle.passed,
  expected_failures: JSON.stringify(failed) === JSON.stringify([...oracle.failed_ids].sort()),
  failure_evidence: result.cases.filter(item => item.status === 'failed').every(item => item.evidence_paths.length > 0 && item.evidence_paths.every(path => existsSync(resolve(dir, path))))
};
const verification = { run_id: runId, scenario: fixture.scenario, checked_at: new Date().toISOString(), scope: 'reference execution only, not full agent orchestration', checks, passed: Object.values(checks).every(Boolean) };
writeFileSync(resolve(dir, 'acceptance-verification.json'), JSON.stringify(verification, null, 2) + '\n');
console.log(JSON.stringify(verification, null, 2));
process.exitCode = verification.passed ? 0 : 1;
