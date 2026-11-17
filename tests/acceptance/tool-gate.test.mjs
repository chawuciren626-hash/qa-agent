import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TOOL_BINDINGS, STATE_PATH, USAGE_PATH,
  gateAction, readRuntimeState, recordToolUsage, recordToolCheck, readToolUsage, bindingSummary,
} from '../../scripts/tool-gate.mjs';
import { inspectExpectedProvenance } from '../../scripts/artifact-contracts.mjs';

const root = resolve(import.meta.dirname, '../..');

/**
 * 每个用例自己写状态文件、自己清理。
 * 闸门读的是 engine root 下的固定路径，没有注入点——这不是偷懒：
 * 生产里就是这一个文件，测试也必须走同一条路，否则测的是另一套代码。
 */
function withState(disabled, run) {
  const path = resolve(root, STATE_PATH);
  const prior = existsSync(path) ? readFileSync(path) : null;
  try {
    if (disabled === null) rmSync(path, { force: true });
    else { mkdirSync(resolve(root, 'config'), { recursive: true }); writeFileSync(path, JSON.stringify({ version: 1, updated_at: new Date().toISOString(), disabled })); }
    return run();
  } finally {
    if (prior === null) rmSync(path, { force: true });
    else writeFileSync(path, prior);
  }
}

test('状态文件不存在时全部放行：工具是纪律增强，不是安全边界', () => {
  withState(null, () => {
    const gate = gateAction(root, 'browser_task', {});
    assert.equal(gate.blocked, null);
    assert.deepEqual(gate.degraded, []);
    assert.deepEqual(gate.tools, ['dom.snapshot']);
  });
});

test('状态文件坏掉/不可读也放行，不让一次写盘决定流水线生死', () => {
  const path = resolve(root, STATE_PATH);
  const prior = existsSync(path) ? readFileSync(path) : null;
  mkdirSync(resolve(root, 'config'), { recursive: true });
  writeFileSync(path, '{ not json');
  try {
    assert.deepEqual([...readRuntimeState(root).disabled], []);
    assert.equal(gateAction(root, 'dispatch', {}).blocked, null);
  } finally { if (prior === null) rmSync(path, { force: true }); else writeFileSync(path, prior); }
});

test('硬依赖停用 = 拒绝执行，且理由里说清楚该去哪儿恢复', () => {
  withState(['dom.snapshot'], () => {
    const gate = gateAction(root, 'browser_task', {});
    assert.match(gate.blocked, /dom\.snapshot/);
    assert.match(gate.blocked, /管理后台/);
    // 不能建议绕道：绕过去产出的是一份少了快照的「正常」结果。
    assert.match(gate.blocked, /不要绕过/);
  });
});

test('阶段工具调用受对应工具开关约束，不把其他工具一并停掉', () => {
  withState(['plan.gates'], () => {
    assert.match(gateAction(root, 'run_stage_tool', {tool_id:'plan.gates'}).blocked, /plan\.gates/);
    assert.equal(gateAction(root, 'run_stage_tool', {tool_id:'report.reviewer'}).blocked, null);
    assert.deepEqual(bindingSummary()['plan.gates'].hard, ['run_stage_tool']);
  });
});

test('接口引擎停用阻止启动，但保留收集已有结果的入口', () => {
  withState(['exec.api_engine'], () => {
    assert.match(gateAction(root, 'api_task', {operation:{type:'start'}}).blocked, /exec\.api_engine/);
    assert.match(gateAction(root, 'api_task', {operation:{type:'resume'}}).blocked, /exec\.api_engine/);
    assert.equal(gateAction(root, 'api_task', {operation:{type:'collect'}}).blocked, null);
  });
});

test('需求解析停用时禁止 DOCX 解析，原文读取仍可用', () => {
  withState(['requirement.parse'], () => {
    assert.match(gateAction(root, 'extract_word', {}).blocked, /requirement\.parse/);
    assert.equal(gateAction(root, 'read_source', {}).blocked, null);
  });
});

test('软依赖停用 = 放行但标注降级，不许静默', () => {
  withState(['regression.select'], () => {
    const gate = gateAction(root, 'export_report', {});
    assert.equal(gate.blocked, null);
    assert.deepEqual(gate.degraded, ['regression.select']);
  });
});

test('多硬依赖只要停一个就拦，理由只列真正停用的那个', () => {
  withState(['agent.contract'], () => {
    const gate = gateAction(root, 'dispatch', {});
    assert.match(gate.blocked, /agent\.contract/);
    assert.doesNotMatch(gate.blocked, /plan\.phases/);
  });
});

test('条件依赖只在测试用例阶段生效：validate_artifacts 要求预期溯源', () => {
  withState(['expected.provenance'], () => {
    assert.match(gateAction(root, 'validate_artifacts', { stage: 'test_cases' }).blocked, /expected\.provenance/);
    assert.match(gateAction(root, 'export_test_cases', {}).blocked, /expected\.provenance/);
    assert.match(gateAction(root, 'diagnose_test_cases', {}).blocked, /expected\.provenance/);
    assert.match(gateAction(root, 'handoff', { stage: 'test_cases' }).blocked, /expected\.provenance/);
    assert.match(gateAction(root, 'complete', { stage: 'test_cases' }).blocked, /expected\.provenance/);
    assert.match(gateAction(root, 'resolve_confirmation', { stage: 'test_cases', decision: 'approved' }).blocked, /expected\.provenance/);
    // 同一个 action、换个阶段就不该被这条工具拦住——否则一次停用会误伤整条流水线。
    assert.equal(gateAction(root, 'validate_artifacts', { stage: 'test_points' }).blocked, null);
  });
});

test('测试点覆盖在对应阶段停用时阻止验证与完成', () => {
  withState(['testpoint.coverage'], () => {
    for (const action of ['validate_artifacts', 'handoff', 'complete'])
      assert.match(gateAction(root, action, {stage:'test_points'}).blocked, /testpoint\.coverage/);
    assert.equal(gateAction(root, 'validate_artifacts', {stage:'test_cases'}).blocked, null);
  });
});

test('未绑定的 action 永远放行，也不产生计数', () => {
  withState(['irval.check', 'plan.phases', 'agent.contract', 'dom.snapshot'], () => {
    const gate = gateAction(root, 'read_source', {});
    assert.equal(gate.blocked, null);
    assert.deepEqual(gate.tools, []);
  });
});

test('调用流水按 action 与工具聚合，坏行跳过', () => {
  const path = resolve(root, USAGE_PATH);
  const prior = existsSync(path) ? readFileSync(path) : null;
  try {
    rmSync(path, { force: true });
    recordToolUsage(root, 'dispatch', { tools: ['agent.contract', 'plan.phases'], receipt: 'audit/stage-tools/1.json' });
    recordToolUsage(root, 'dispatch', { tools: ['agent.contract', 'plan.phases'], degraded: ['regression.select'], receipt: 'audit/stage-tools/2.json' });
    recordToolUsage(root, 'browser_task', { tools: ['dom.snapshot'], receipt: 'audit/stage-tools/3.json' });
    recordToolUsage(root, 'read_source', { tools: [] });
    recordToolCheck(root, 'validate_artifacts', {tool_id:'testpoint.coverage',status:'failed',
      implementation:'scripts/test-point-diagnosis.mjs',input:{path:'design/test_points.json'},missing_rule_ids:['RULE-2']},
      {receipt:'audit/action.json',runId:'run-1',stage:'test_points'});
    writeFileSync(path, '{"broken\n', { flag: 'a' });
    const usage = readToolUsage(root);
    assert.equal(usage.total, 3);
    assert.equal(usage.per_tool['agent.contract'], 2);
    assert.equal(usage.per_tool['dom.snapshot'], 1);
    assert.equal(usage.per_action.dispatch, 2);
    // 空工具的调用不落盘：记一行「什么都没用到」只是噪音。
    assert.equal(usage.per_action.read_source, undefined);
    assert.equal(usage.per_tool['testpoint.coverage'], undefined, 'failed checks do not inflate successful calls');
    const check=readFileSync(path,'utf8').split('\n').map(line=>{try{return JSON.parse(line)}catch{return null}})
      .find(row=>row?.kind==='check' && row.tool_id==='testpoint.coverage');
    assert.deepEqual(check.summary.missing_rule_ids,['RULE-2']);
  } finally { if (prior === null) rmSync(path, { force: true }); else writeFileSync(path, prior); }
});

test('绑定表覆盖全部关键 action，且没有指向不存在工具的孤条目', () => {
  const known = new Set([
    'irval.check', 'assets.library', 'regression.select', 'plan.phases', 'agent.contract',
    'knowledge.incremental', 'dom.snapshot', 'expected.provenance', 'requirement.completeness',
    'testpoint.coverage', 'm1.consistency', 'requirement.parse', 'exec.api_engine',
  ]);
  for (const [action, binding] of Object.entries(TOOL_BINDINGS)) {
    for (const name of [...(binding.requires ?? []), ...(binding.enhances ?? [])]) {
      assert.ok(known.has(name), `${action} 绑了未知工具 ${name}`);
    }
  }
  const summary = bindingSummary();
  // 阶段状态机是所有流程的骨架，它管着的 action 必须最多。
  assert.ok(summary['plan.phases'].hard.length >= 10, `plan.phases 只绑了 ${summary['plan.phases'].hard.length} 个 action`);
  // 规划中的工具不该绑任何 action：绑了就会让每次调用都背一条无意义的降级。
  assert.equal(summary['knowledge.incremental'], undefined);
  // requirement.completeness 本轮已落地（scripts/requirement-completeness.mjs），
  // 由报告生成时消费，因此只作为 export_report 的软依赖——能力先落地，再接线。
  assert.deepEqual(summary['requirement.completeness'].soft, ['export_report']);
  assert.deepEqual(summary['requirement.completeness'].hard, []);
});

/* —— 预期溯源真的接在 case 阶段校验里，而不是只挂在闸门表上 —— */

const withExpectations = expectations => [{ case_id: 'TC-1', expectations }];
const sourced = { type: 'doc', ref: 'REQ-0007#3', quote: '满 100 减 10' };

test('预期溯源：写了但站不住的预期被拦——model 不能自证 verified', () => {
  const audit = inspectExpectedProvenance(withExpectations([
    { kind: 'decide', text: '满 100 减 10', source: { ...sourced, type: 'model' }, state: 'verified', verified_by: 'human:zhangsan' },
  ]), root);
  assert.equal(audit.skipped, false);
  assert.match(audit.problems.join(';'), /model 不能标记 verified/);
});

test('预期溯源：verified 必须由人签字，agent 不能给自己发证书', () => {
  const audit = inspectExpectedProvenance(withExpectations([
    { kind: 'decide', text: '满 100 减 10', source: sourced, state: 'verified', verified_by: 'agent:test_case_agent' },
  ]), root);
  assert.match(audit.problems.join(';'), /human:/);
});

test('预期溯源：没写来源的用例不被拦，但未记录的数量要如实报出来', () => {
  const audit = inspectExpectedProvenance([{ case_id: 'TC-1', expected: '页面正常展示' }], root);
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.notRecorded, 1);
  assert.equal(audit.located, 0);
});

test('预期溯源：decide 断言没有来源就是不合格——不能决定通过与否', () => {
  const audit = inspectExpectedProvenance(withExpectations([{ kind: 'decide', text: '金额等于 90' }]), root);
  assert.match(audit.problems.join(';'), /必须有 source/);
});

test('停用 expected.provenance 后这条纪律整条不生效，而不是把流程堵死', () => {
  withState(['expected.provenance'], () => {
    const bad = withExpectations([{ kind: 'decide', text: 'x', source: { ...sourced, type: 'model' }, state: 'verified', verified_by: 'human:x' }]);
    assert.equal(inspectExpectedProvenance(bad, root).skipped, true);
    assert.deepEqual(inspectExpectedProvenance(bad, root).problems, []);
  });
});

test('旧用例两个字段都没有也不算错：只记未记录，不阻塞', () => {
  const audit = inspectExpectedProvenance([{ case_id: 'LEGACY' }], root);
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.located + audit.notRecorded, 1);
  assert.equal(audit.notRecorded, 1);
});

/* —— 依据判定与执行期同源：引用不成立就拦，不留两套口径 —— */

test('预期溯源：expected_basis 引用不存在时拦下', () => {
  const dir = resolve(root, 'output/runs', `run-gate-basis-${randomUUID()}`);
  mkdirSync(resolve(dir, 'inputs'), { recursive: true });
  writeFileSync(resolve(dir, 'inputs/request.txt'), '标题为空时提示请输入标题');
  try {
    const audit = inspectExpectedProvenance([{
      case_id: 'TC-1', expected: '显示请输入标题',
      expected_basis: [{ expected: '显示请输入标题', kind: 'requirement', source_path: 'inputs/ghost.txt', quote: '标题为空时提示请输入标题' }],
    }], root, dir);
    assert.match(audit.problems.join(';'), /already verified task source/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('预期溯源：quote 不是原文摘录时拦下，引用不允许靠意会', () => {
  const dir = resolve(root, 'output/runs', `run-gate-basis-${randomUUID()}`);
  mkdirSync(resolve(dir, 'inputs'), { recursive: true });
  writeFileSync(resolve(dir, 'inputs/request.txt'), '标题为空时提示请输入标题');
  try {
    const audit = inspectExpectedProvenance([{
      case_id: 'TC-1', expected: '显示请输入标题',
      expected_basis: [{ expected: '显示请输入标题', kind: 'requirement', source_path: 'inputs/request.txt', quote: '标题为空时应提示' }],
    }], root, dir);
    assert.match(audit.problems.join(';'), /verbatim excerpt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('预期溯源：依据齐全时 recorded，且位置能定位', () => {
  const dir = resolve(root, 'output/runs', `run-gate-basis-${randomUUID()}`);
  mkdirSync(resolve(dir, 'inputs'), { recursive: true });
  writeFileSync(resolve(dir, 'inputs/request.txt'), '标题为空时提示请输入标题');
  try {
    const audit = inspectExpectedProvenance([{
      case_id: 'TC-1', expected: '显示请输入标题',
      expected_basis: [{ expected: '显示请输入标题', kind: 'requirement', source_path: 'inputs/request.txt', quote: '标题为空时提示请输入标题' }],
    }], root, dir);
    assert.deepEqual(audit.problems, []);
    assert.equal(audit.located, 1);
    assert.equal(audit.notRecorded, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
