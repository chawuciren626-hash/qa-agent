import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactStates, normalizeInvalidation, matchesSubset, assessStageArtifacts, describeStaleness,
  artifactUsable, createProjectState, createPhaseState, declareModuleDependency, assertNoModuleCycle,
  moduleStageReady, recordArtifacts, writeCrossModule, summarizeProject,
} from '../../scripts/artifact-scope.mjs';

/* ── L-2：失效粒度 ───────────────────────────────────────────────── */

test('L-2 不带 artifact_subset 时保持整阶段失效，旧行为不变', () => {
  const request = normalizeInvalidation({ stage: 'test_cases', reason: '需求 REQ-0007 变更' });
  assert.equal(request.scope, 'stage');
  assert.equal(request.subset, null);
  const records = [{ id: 'TC-1', kind: 'case', fields: {} }, { id: 'TC-2', kind: 'case', fields: {} }];
  const result = assessStageArtifacts(records, request);
  assert.equal(result.state, 'stale');
  assert.deepEqual([...result.staleIds], ['TC-1', 'TC-2']);
});

test('L-2 给 subset.ids 时只失效点名的那几条，状态是 partially_stale', () => {
  const records = Array.from({ length: 1500 }, (_, index) => ({ id: `TC-${index + 1}`, kind: 'case', fields: {} }));
  const request = normalizeInvalidation({
    stage: 'test_cases', reason: 'REQ-0007 第 3 条判定规则变更',
    artifact_subset: { ids: records.slice(0, 12).map(record => record.id) },
  });
  assert.equal(request.scope, 'subset');
  const result = assessStageArtifacts(records, request);
  assert.equal(result.state, 'partially_stale');
  assert.equal(result.staleIds.length, 12);
  assert.equal(result.validIds.length, 1488);
  // 这是 P0-3 的验收点：报告要能说出「1500 条中 12 条」，而不是「全部失效」。
  assert.match(describeStaleness(result), /1500 条中 12 条基于旧版本/);
  assert.match(describeStaleness(result), /1488 条有效/);
});

test('L-2 subset 三种点名方式命中任一即失效，且它们回答不同问题', () => {
  const records = [
    { id: 'TC-1', kind: 'case', fields: { module: 'order' } },
    { id: 'TC-2', kind: 'case', fields: { module: 'pay' } },
    { id: 'TP-1', kind: 'point', fields: { module: 'order' } },
  ];
  assert.deepEqual([...assessStageArtifacts(records, normalizeInvalidation({ stage: 's', reason: 'r', artifact_subset: { ids: ['TC-2'] } })).staleIds], ['TC-2']);
  assert.deepEqual([...assessStageArtifacts(records, normalizeInvalidation({ stage: 's', reason: 'r', artifact_subset: { kinds: ['point'] } })).staleIds], ['TP-1']);
  assert.deepEqual([...assessStageArtifacts(records, normalizeInvalidation({ stage: 's', reason: 'r', artifact_subset: { selector: { module: 'order' } } })).staleIds], ['TC-1', 'TP-1']);
});

test('L-2 selector 数组条件按交集判，标量条件按相等判', () => {
  const record = { id: 'TC-1', kind: 'case', fields: { rule_ids: ['R-1', 'R-2'], module: 'order' } };
  assert.equal(matchesSubset(record, { selector: { rule_ids: ['R-2'] } }), true);
  assert.equal(matchesSubset(record, { selector: { rule_ids: ['R-9'] } }), false);
  assert.equal(matchesSubset(record, { selector: { module: 'order', rule_ids: ['R-1'] } }), true);
  assert.equal(matchesSubset(record, { selector: { module: 'pay' } }), false);
});

test('L-2 没有产物记录时返回 unknown，不猜一个好看的答案', () => {
  const result = assessStageArtifacts([], normalizeInvalidation({ stage: 'test_cases', reason: 'r', artifact_subset: { ids: ['TC-1'] } }));
  assert.equal(result.state, 'unknown');
  assert.match(describeStaleness(result), /无法判断/);
  // unknown 一律不可用：不知道基于哪个版本，就不能拿去出结论。
  assert.equal(artifactUsable(result, 'TC-1'), false);
});

test('L-2 partially_stale 里未点名的产物照常可用——这正是要的效果', () => {
  const records = [{ id: 'TC-1', kind: 'case', fields: {} }, { id: 'TC-2', kind: 'case', fields: {} }];
  const result = assessStageArtifacts(records, normalizeInvalidation({ stage: 's', reason: 'r', artifact_subset: { ids: ['TC-1'] } }));
  assert.equal(artifactUsable(result, 'TC-2'), true);
  assert.equal(artifactUsable(result, 'TC-1'), false);
  const all = assessStageArtifacts(records, normalizeInvalidation({ stage: 's', reason: 'r' }));
  assert.equal(artifactUsable(all, 'TC-2'), false);
});

test('L-2 非法失效请求一律拒绝，并说明为什么', () => {
  const cases = [
    [null, /expects an object/],
    [{ reason: 'r' }, /stage must be a stage identifier/],
    [{ stage: 'test_cases' }, /reason is required/],
    [{ stage: 'test_cases', reason: '  ' }, /reason is required/],
    [{ stage: 'test_cases', reason: 'r', artifact_subset: {} }, /an empty subset means "whole stage"/],
    [{ stage: 'test_cases', reason: 'r', artifact_subset: { ids: [] } }, /ids is empty/],
    [{ stage: 'test_cases', reason: 'r', artifact_subset: { ids: ['A', 'A'] } }, /duplicates/],
    [{ stage: 'test_cases', reason: 'r', artifact_subset: { kinds: ['Not-A-Kind'] } }, /kind identifiers/],
    [{ stage: 'test_cases', reason: 'r', artifact_subset: { selector: { module: undefined } } }, /undefined condition/],
  ];
  for (const [input, pattern] of cases) assert.throws(() => normalizeInvalidation(input), pattern);
});

test('L-2 三级状态枚举固定，report 不自己造词', () => {
  assert.deepEqual([...artifactStates], ['valid', 'partially_stale', 'stale']);
  const valid = assessStageArtifacts([{ id: 'A', kind: 'case', fields: {} }], normalizeInvalidation({ stage: 's', reason: 'r', artifact_subset: { ids: ['B'] } }));
  assert.equal(valid.state, 'valid');
  assert.match(describeStaleness(valid), /全部基于当前版本/);
});

/* ── L-11：多模块作用域 ──────────────────────────────────────────── */

test('L-11 PhaseState 带 scope，各模块产物互不覆盖', () => {
  const project = createProjectState({ project: 'proj-crm', modules: ['order', 'pay'] });
  recordArtifacts(project, 'order', 'test_cases', { state: 'valid', staleIds: [], validIds: ['TC-1'] });
  recordArtifacts(project, 'pay', 'test_cases', { state: 'partially_stale', staleIds: ['TC-9'], validIds: ['TC-8'] });
  assert.equal(project.phases.order.artifacts.test_cases.state, 'valid');
  assert.equal(project.phases.pay.artifacts.test_cases.state, 'partially_stale');
  // 单作用域时代，后跑的会覆盖前者；这里两条都在。
  assert.deepEqual([...project.phases.order.artifacts.test_cases.validIds], ['TC-1']);
  assert.deepEqual([...project.phases.pay.artifacts.test_cases.staleIds], ['TC-9']);
});

test('L-11 模块 A 的用例与模块 B 的需求可以同时处于 running', () => {
  const project = createProjectState({ project: 'p', modules: ['a', 'b'] });
  project.phases.a.stages.test_cases = { status: 'in_progress' };
  project.phases.b.stages.analysis = { status: 'in_progress' };
  assert.equal(project.phases.a.stages.test_cases.status, 'in_progress');
  assert.equal(project.phases.b.stages.analysis.status, 'in_progress');
});

test('L-11 跨模块产物只允许 ProjectState 写，模块写入直接拒', () => {
  const project = createProjectState({ project: 'p', modules: ['a'] });
  writeCrossModule(project, 'report', { id: 'R-1' });
  assert.equal(project.crossModule.reports.length, 1);
  assert.throws(() => writeCrossModule(project, 'report', { id: 'R-2' }, { by: 'a' }), /only be written by ProjectState/);
  assert.throws(() => writeCrossModule(project, 'case', {}), /Unknown cross-module artifact kind/);
});

test('L-11 模块依赖必须显式声明，成环当场拒绝且不留半条边', () => {
  const project = createProjectState({ project: 'p', modules: ['order', 'stock', 'pay'] });
  declareModuleDependency(project, 'order', 'stock');
  assert.deepEqual(project.dependsOn.order, ['stock']);
  assert.throws(() => declareModuleDependency(project, 'pay', 'pay'), /cannot depend on itself/);
  assert.throws(() => declareModuleDependency(project, 'pay', 'ghost'), /Unknown module/);
  // 成环在声明时就拒，不等调度时才发现；被拒的那条边必须撤回，否则图自己都过不了。
  assert.throws(() => declareModuleDependency(project, 'stock', 'order'), /Module dependency cycle: order -> stock -> order/);
  assert.equal(project.dependsOn.stock, undefined);
  assert.doesNotThrow(() => assertNoModuleCycle(project));
});

test('L-11 依赖未完成的模块不能派发，错误里要说清卡在谁身上', () => {
  const project = createProjectState({ project: 'p', modules: ['order', 'stock'] });
  declareModuleDependency(project, 'order', 'stock');
  project.phases.stock.stages.analysis = { status: 'in_progress' };
  const blocked = moduleStageReady(project, 'order', 'analysis');
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, [{ module: 'stock', stage: 'analysis', status: 'in_progress' }]);
  project.phases.stock.stages.analysis = { status: 'completed' };
  assert.equal(moduleStageReady(project, 'order', 'analysis').ready, true);
});

test('L-11 recordArtifacts 接受 unknown（如实记账），但拒绝凭空造词', () => {
  const project = createProjectState({ project: 'p', modules: ['a'] });
  recordArtifacts(project, 'a', 'test_cases', { state: 'unknown', reason: 'no records' });
  assert.equal(project.phases.a.artifacts.test_cases.state, 'unknown');
  assert.throws(() => recordArtifacts(project, 'a', 'test_cases', { state: 'probably_fine' }), /must be one of/);
  assert.throws(() => recordArtifacts(project, 'ghost', 'test_cases', { state: 'valid' }), /Unknown module/);
});

test('L-11 全局汇总：任何模块有 stale 都不能说全局 valid', () => {
  const project = createProjectState({ project: 'p', modules: ['a', 'b'] });
  recordArtifacts(project, 'a', 'test_cases', { state: 'valid', staleIds: [], validIds: ['TC-1'] });
  recordArtifacts(project, 'b', 'test_cases', { state: 'partially_stale', staleIds: ['TC-9'], validIds: ['TC-8'] });
  const mixed = summarizeProject(project);
  assert.equal(mixed.verdict, 'mixed');
  assert.equal(mixed.partiallyStaleStages, 1);
  recordArtifacts(project, 'b', 'test_cases', { state: 'valid', staleIds: [], validIds: ['TC-8'] });
  assert.equal(summarizeProject(project).verdict, 'valid');
  recordArtifacts(project, 'b', 'test_points', { state: 'unknown', reason: 'no records' });
  const incomplete = summarizeProject(project);
  assert.equal(incomplete.verdict, 'incomplete');
  assert.equal(incomplete.unknownStages, 1);
});

test('L-11 构造期就拒绝重名模块与非法标识，不等调度时才发现', () => {
  assert.throws(() => createProjectState({ project: 'p', modules: [] }), /at least one module/);
  assert.throws(() => createProjectState({ project: 'p', modules: ['a', 'a'] }), /Duplicate module/);
  assert.throws(() => createProjectState({ project: 'p', modules: ['Order-Module'] }), /Invalid module identifier/);
  assert.throws(() => createPhaseState(''), /requires a scope/);
});
