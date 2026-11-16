import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOOL_SCENARIOS, stageScenarioPrompt } from '../../scripts/stage-tool-scenarios.mjs';
import { STAGE_TOOLS } from '../../scripts/stage-tool-runtime.mjs';

test('every central tool has a concrete scenario and input/outcome contract', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../platform/packages/server/src/http/central-tools.ts'), 'utf8');
  const registered = [...source.matchAll(/name: "([a-z0-9_.]+)", displayName:/g)].map(match => match[1]);
  const mapped = new Set(TOOL_SCENARIOS.flatMap(row => row.tools));
  assert.deepEqual([...mapped].sort(), registered.sort());
  for (const row of TOOL_SCENARIOS) {
    assert.ok(row.scene && row.input && row.outcome && row.state);
    assert.ok(['analysis','test_points','test_cases','execution','api_execution','defects','report','cross'].includes(row.stage));
  }
  assert.match(stageScenarioPrompt('analysis'), /口述需求已归档/);
  assert.doesNotMatch(stageScenarioPrompt('analysis'), /接口执行/);
  for (const [id, spec] of Object.entries(STAGE_TOOLS)) {
    for (const stage of Array.isArray(spec.stage) ? spec.stage : [spec.stage]) {
      assert.ok(TOOL_SCENARIOS.some(row => row.stage === stage && row.tools.includes(id)), `${stage}: ${id} has no trigger scenario`);
    }
  }
});
