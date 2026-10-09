import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectDesign, designReceipt } from '../../scripts/design-quality.mjs';
import { createExecutionCases } from '../../scripts/execution-plan.mjs';
import { provenanceFixture } from './provenance-fixtures.mjs';

export function writeJsonFile(path, data) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

export function executionInputs(root, id) {
  const dir = resolve(root, 'output/runs', id);
  mkdirSync(resolve(dir, 'inputs'), { recursive: true });
  writeFileSync(resolve(dir, 'inputs/requirements.md'), 'Synthetic safety test requirement. Not actual authorization.');
  const cases = [{ case_id: 'TC-SYNTHETIC', title: 'Synthetic', priority: 'P2', type: 'functional', preconditions: [], related_test_point: 'TP-SYNTHETIC', automation_feasible: true, steps: ['Synthetic'], expected: 'Synthetic', design_contract: { basis: [{ source: 'inputs/requirements.md', rule: 'Synthetic', status: 'confirmed' }], assumptions: [], data_checks: [] } }];
  const source = resolve(dir, 'design/test_cases.json');
  provenanceFixture(dir, id);
  cases[0].design_contract.basis[0].rule_id = 'RULE-SYNTHETIC';
  writeJsonFile(source, cases);
  const registry = resolve(dir, 'environment/registry.json');
  writeJsonFile(registry, { environments: { synthetic: { base_url: 'http://127.0.0.1:4317/healthy', authorized_for_execution: true, execution_enabled: true } } });
  const config = resolve(dir, 'environment/runtime.json');
  writeJsonFile(config, { environment: 'synthetic', environment_registry: registry, base_url: 'http://127.0.0.1:4317/healthy', execution: { enabled: true, max_workers: 1 } });
  const testDir = resolve(dir, 'execution/scripts');
  mkdirSync(testDir, { recursive: true });
  writeFileSync(resolve(testDir, 'synthetic.spec.ts'), '// Fixture is never executed by a browser.\n');
  const checked = inspectDesign({ root, runId: id, source });
  const plan = { run_id: id, source, environment_config: config, cases: createExecutionCases(cases), design_gate: designReceipt(checked), execution_policy: { workers: 1, test_dir: testDir } };
  writeJsonFile(resolve(dir, 'execution/execution-plan.json'), plan);
  return { dir, plan, source, config, testDir, registry };
}
