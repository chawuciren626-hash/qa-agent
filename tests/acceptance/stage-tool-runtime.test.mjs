import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runStageTool, stageToolCatalog, stageToolReceipts, validateToolPayload } from '../../scripts/stage-tool-runtime.mjs';

const root = resolve(import.meta.dirname, '../..');

test('stage catalog exposes only callable implementations', () => {
  assert.ok(stageToolCatalog('analysis').some(item => item.id === 'requirement.testability'));
  assert.ok(!stageToolCatalog('report').some(item => item.id === 'requirement.testability'));
  assert.throws(() => validateToolPayload('requirement.testability', {requirement:{expected:[]}}), /requirement.expected must be string/);
  assert.throws(() => validateToolPayload('defect.evidence', {exec_ir:{},keep_request_payload:true}), /unsupported keep_request_payload/);
});

test('completed Node checks reach downstream dispatch only while source files still match', () => {
  const runId = `run-stage-check-${randomUUID()}`;
  const dir = resolve(root, 'output/runs', runId);
  mkdirSync(resolve(dir, 'design'), { recursive: true });
  const bytes = JSON.stringify([{ case_id: 'TC-1' }]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(resolve(dir, 'design/test_cases.json'), bytes);
  const contract = { status: 'passed', run_id: runId, stage: 'test_cases',
    files: [{ path: 'design/test_cases.json', sha256 }],
    tool_checks: [{ tool_id: 'expected.provenance', status: 'passed', implementation_sha256: sha256,
      input: { path: 'design/test_cases.json', sha256 } }] };
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify({ run_id: runId,
    stages: { test_cases: { status: 'completed' } }, orchestration: { events: [
      { type: 'completed', stage: 'test_cases', evidence: { artifact_contract: contract } },
    ] } }));
  try {
    assert.equal(stageToolReceipts(root, runId)[0].source, 'stage_completion_contract');
    assert.deepEqual(stageToolReceipts(root, runId, { beforeStage: 'test_cases' }), []);
    writeFileSync(resolve(dir, 'design/test_cases.json'), 'changed');
    assert.deepEqual(stageToolReceipts(root, runId), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real stage tool invocation writes a versioned receipt', { skip: !process.env.QA_PYTHON }, () => {
  const runId = `run-stage-tool-${randomUUID()}`;
  const dir = resolve(root, 'output/runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify({ run_id: runId, stages: { analysis: { status: 'in_progress' } } }));
  try {
    mkdirSync(resolve(dir, 'inputs'));
    const sourcePath = 'inputs/requirement-ir.json';
    writeFileSync(resolve(dir, sourcePath), JSON.stringify({ requirement: { id: 'REQ-1', title: '创建用户', description: '创建用户', expected: '显示成功', preconditions: '管理员已登录' } }));
    const sourced = runStageTool(root, { runId, stage: 'analysis', toolId: 'requirement.testability', sourcePath });
    assert.equal(sourced.input_source.path, sourcePath);
    assert.match(sourced.input_source.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(readFileSync(resolve(dir, sourced.tool_receipt), 'utf8')).input_source, sourced.input_source);
    assert.throws(() => runStageTool(root, { runId, stage: 'analysis', toolId: 'requirement.testability', sourcePath: '../manifest.json' }), /source_path/);
    const call = runStageTool(root, { runId, stage: 'analysis', toolId: 'requirement.testability',
      payload: { requirement: { id: 'REQ-1', title: '创建用户', description: '创建用户', expected: '显示成功', preconditions: '管理员已登录' } } });
    assert.equal(call.status, 'completed');
    assert.ok(call.result.some(item => item.rule === 'T2'));
    const receipt = JSON.parse(readFileSync(resolve(dir, call.tool_receipt), 'utf8'));
    assert.equal(receipt.tool_id, 'requirement.testability');
    assert.equal(receipt.status, 'completed');
    assert.match(receipt.implementation_sha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.input_sha256.length, 64);
    assert.deepEqual(stageToolReceipts(root, runId), []);
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify({ run_id: runId, stages: { analysis: { status: 'completed' } } }));
    assert.ok(stageToolReceipts(root, runId).some(item => item.receipt_path === call.tool_receipt));
    assert.ok(stageToolReceipts(root, runId).some(item => item.receipt_path === sourced.tool_receipt && item.input_source.sha256 === sourced.input_source.sha256));
    assert.throws(() => runStageTool(root, { runId, stage: 'report', toolId: 'requirement.testability', payload: {} }), /not callable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all exposed stage tools call their Python implementation', { skip: !process.env.QA_PYTHON }, () => {
  const runId = `run-stage-tools-${randomUUID()}`;
  const dir = resolve(root, 'output/runs', runId);
  const stages = Object.fromEntries(['analysis', 'test_points', 'test_cases', 'execution', 'defects', 'report'].map(stage => [stage, { status: 'in_progress' }]));
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify({ run_id: runId, stages }));
  const calls = [
    ['analysis', 'requirement.acceptance', { requirement: { acceptance: [{ observable: '显示创建成功' }] } }],
    ['test_points', 'testpoint.coverage', { requirements: [], test_points: [], cases: [] }],
    ['test_cases', 'plan.gates', { plan: { steps: [] }, case: { assertions: [] } }],
    ['analysis', 'irval.check', { document: {} }],
    ['report', 'report.reviewer', { execs: [] }],
    ['defects', 'defect.evidence', { exec_ir: { id: 'EXEC-1', steps: [] } }],
    ['defects', 'defect.tools', { evidence_packs: [], history: [] }],
    ['execution', 'regression.impact', { cases: [], changed_modules: [] }],
    ['execution', 'regression.select', { cases: [], tier: 'smoke' }],
  ];
  try {
    for (const [stage, toolId, payload] of calls) {
      const call = runStageTool(root, { runId, stage, toolId, payload });
      assert.equal(call.status, 'completed', toolId);
      assert.equal(JSON.parse(readFileSync(resolve(dir, call.tool_receipt), 'utf8')).tool_id, toolId);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
