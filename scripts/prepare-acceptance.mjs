import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s)));
const runId = args['run-id'];
const scenario = args.scenario ?? 'healthy';
const port = Number(args.port ?? 4317);
if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '') || !['healthy', 'defect', 'unavailable'].includes(scenario)) throw new Error('Use --run-id=run-... --scenario=healthy|defect|unavailable [--port=4317]');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const relative = `output/runs/${runId}`;
const runDir = resolve(root, relative);
if (existsSync(runDir)) throw new Error('Run already exists; choose a new run ID.');
const execute = (script, parameters) => {
  const result = spawnSync(process.execPath, [resolve(root, script), ...parameters], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${script} failed`);
};
execute('scripts/create-run.mjs', [`--run-id=${runId}`]);
const write = (path, data) => {
  const target = resolve(runDir, path);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
};
const baseUrl = `http://127.0.0.1:${port}/${scenario}`;
write('environment/registry.json', { version: 1, default_environment: 'acceptance', environments: { acceptance: {
  name: 'Local synthetic acceptance', base_url: baseUrl, authorized_for_execution: true, execution_enabled: true, browser: 'chrome'
} } });
write('environment/runtime.json', { environment: 'acceptance', base_url: baseUrl,
  environment_registry: `${relative}/environment/registry.json`, accounts: {}, execution: { enabled: true, timeout_ms: 10000, max_workers: 1 }
});
const titles = ['Seed list', 'Create draft', 'Empty title', 'Long title', 'Negative budget', 'Delete draft'];
const expected = ['Sample document / 120 / draft', 'Created and row exists', 'Title must contain 1-40 characters', 'Title must contain 1-40 characters', 'Budget must be a non-negative integer', 'Deleted and row absent'];
const cases = titles.map((title, i) => ({ case_id: `TC-BASE-0${i+1}`, title, priority: 'P0', type: 'UI',
  preconditions: ['Reset independent fixture scope'], steps: [`Execute baseline.spec.ts scenario ${i+1}`], expected: expected[i],
  automation_feasible: true, related_test_point: `TP-BASE-0${i+1}`,
  design_contract: { basis: [{ source: 'inputs/requirements.md', rule: `TC-BASE-0${i+1} reference checkpoint`, status: 'confirmed' }], assumptions: [], data_checks: [] },
  execution_contract: { data_isolation: 'shared', setup: ['Reset scope'], assertion_mode: ['dynamic_ui', 'dom_state'], cleanup_required: true },
  execution_metadata: { modules: ['acceptance'], estimated_duration_ms: 10000, data_impact: 'shared' }
}));
write('design/test_cases.json', cases);
write('inputs/acceptance.json', { fixture_version: 1, scenario, base_url: baseUrl, origin: 'reference-fixture-not-agent-generated', oracle: 'acceptance/oracle.json' });
writeFileSync(resolve(runDir, 'inputs/requirements.md'), readFileSync(resolve(root, 'acceptance/requirements.md')));
// This is reference-fixture provenance, never a record of a real user approval.
const requirementText = readFileSync(resolve(runDir, 'inputs/requirements.md'), 'utf8');
const rules = cases.map((item, index) => {
  item.design_contract.basis[0].rule_id = `RULE-BASE-${index + 1}`;
  return { id: `RULE-BASE-${index + 1}`, kind: 'requirement', scope: 'in_scope', status: 'confirmed', statement: item.design_contract.basis[0].rule, citations: [{ source_id: 'SRC-BASE', quote: requirementText }] };
});
write('analysis/requirement-ledger.json', { version: 1, run_id: runId, sources: [{ id: 'SRC-BASE', kind: 'specification', path: 'inputs/requirements.md', origin: 'acceptance/requirements.md; reference fixture only, not Agent-generated approval', locator: 'whole reference specification' }], rules });
write('design/test_cases.json', cases);
execute('scripts/select-test-cases.mjs', [`--run-id=${runId}`, `--cases=${relative}/design/test_cases.json`, '--profile=full']);
execute('scripts/create-execution-plan.mjs', [`--run-id=${runId}`, `--cases=${relative}/design/test_cases.json`, `--selection=${relative}/selection/test-selection.json`, `--environment-config=${relative}/environment/runtime.json`, '--test-dir=tests/acceptance/ui']);
console.log(JSON.stringify({ run_id: runId, base_url: baseUrl, provenance: 'fixture_only', execution: `npm run test:ui -- --run-id=${runId}` }, null, 2));
