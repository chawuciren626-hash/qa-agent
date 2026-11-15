import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCompleteness, adjustCoverage, buildEntityMatrix, CHECKS } from '../../scripts/requirement-completeness.mjs';

const rule = (id, statement) => ({ id, kind: 'requirement', scope: 'in_scope', status: 'confirmed', statement });

function ledgerOf(statements, entities) {
  return { version: 1, run_id: 'run-x', sources: [], rules: statements.map((text, i) => rule(`RULE-${i + 1}`, text)), ...(entities ? { entities } : {}) };
}

test('检查表固定五项：改这张表等于改口径，必须有意识地改', () => {
  assert.deepEqual(CHECKS.map(item => item.id), ['entity_crud', 'state_transitions', 'numeric_bounds', 'permission_matrix', 'failure_paths']);
});

test('没有 in_scope 需求时 available=false，不产生分数', () => {
  const result = inspectCompleteness({ rules: [] });
  assert.equal(result.available, false);
  assert.equal(result.score, null);
  assert.match(result.note, /不代表需求完整/);
});

test('out_of_scope 的需求不参与完备性判定', () => {
  const result = inspectCompleteness({ rules: [{ ...rule('R1', '订单创建'), scope: 'out_of_scope' }] });
  assert.equal(result.available, false);
});

test('声明了实体且四项操作齐全 → 实体完整性 covered', () => {
  const result = inspectCompleteness(ledgerOf(
    ['订单可以新增', '订单可以查询', '订单可以修改', '订单可以删除'],
    [{ name: '订单', operations: ['create', 'read', 'update', 'delete'] }],
  ));
  const check = result.checks.find(item => item.id === 'entity_crud');
  assert.equal(check.status, 'covered');
  assert.equal(check.basis, 'declared');
  assert.equal(check.confidence, 'high');
});

test('缺「删除」就报 missing，并指出缺的是哪个操作', () => {
  const result = inspectCompleteness(ledgerOf(
    ['订单可以新增', '订单可以查询', '订单可以修改'],
    [{ name: '订单', operations: ['create', 'read', 'update'] }],
  ));
  const check = result.checks.find(item => item.id === 'entity_crud');
  assert.equal(check.status, 'missing');
  assert.deepEqual(check.missing[0], { entity: '订单', missing_operations: ['delete'] });
});

test('文本推断：实体与动作同时出现才认，且标低置信', () => {
  const result = inspectCompleteness(ledgerOf(['用户可创建草稿', '草稿可查询']));
  assert.equal(result.basis, 'text_inference');
  assert.equal(result.confidence, 'low');
  const check = result.checks.find(item => item.id === 'entity_crud');
  assert.equal(check.status, 'missing');
  assert.ok(result.warnings.some(text => /文本推断/.test(text)));
});

test('数值字段没给边界 → 缺失；给了边界 → 覆盖', () => {
  const missing = inspectCompleteness(ledgerOf(['预算字段需要保存']));
  assert.equal(missing.checks.find(item => item.id === 'numeric_bounds').status, 'missing');

  const covered = inspectCompleteness(ledgerOf(['预算必须是非负整数，范围 0-120']));
  assert.equal(covered.checks.find(item => item.id === 'numeric_bounds').status, 'covered');
});

test('只写「谁能做什么」不写「谁不能做什么」→ 权限矩阵缺失', () => {
  const result = inspectCompleteness(ledgerOf(['管理员可以删除订单']));
  const check = result.checks.find(item => item.id === 'permission_matrix');
  assert.equal(check.status, 'missing');
  assert.match(check.missing[0].detail, /没写谁不能做什么/);
});

test('写了禁止性声明才算覆盖权限矩阵', () => {
  const result = inspectCompleteness(ledgerOf(['普通用户不得删除他人订单', '管理员可以删除订单']));
  assert.equal(result.checks.find(item => item.id === 'permission_matrix').status, 'covered');
});

test('外部依赖没有失败路径 → 缺失', () => {
  const result = inspectCompleteness(ledgerOf(['下单后调用支付接口完成扣款']));
  const check = result.checks.find(item => item.id === 'failure_paths');
  assert.equal(check.status, 'missing');
  assert.match(check.missing[0].detail, /没有失败\/超时\/重试路径/);
});

test('外部依赖写了超时与重试 → 覆盖', () => {
  const result = inspectCompleteness(ledgerOf(['调用支付接口超时后重试最多 3 次，仍失败则降级为待支付']));
  assert.equal(result.checks.find(item => item.id === 'failure_paths').status, 'covered');
});

test('有状态实体但没写回退与非法流转 → 两条缺口都列出来', () => {
  const result = inspectCompleteness(ledgerOf(
    ['草稿状态可以流转为已发布'],
    [{ name: '草稿', operations: ['create'], stateful: true }],
  ));
  const check = result.checks.find(item => item.id === 'state_transitions');
  assert.equal(check.status, 'missing');
  assert.deepEqual(check.missing.map(item => item.aspect), ['回退路径', '非法流转']);
});

test('unknown 不进分母：判不了不等于缺失，也不等于覆盖', () => {
  const result = inspectCompleteness(ledgerOf(['系统首页需要展示公告文案']));
  const unknown = result.checks.filter(item => item.status === 'unknown');
  assert.ok(unknown.length >= 3, '多数检查项应为 unknown');
  assert.equal(result.denominator.judged, result.denominator.covered + result.denominator.missing);
  assert.ok(result.warnings.some(text => /无法判定/.test(text)));
});

test('全部 unknown 时不给分：null 比 0 分诚实', () => {
  const result = inspectCompleteness(ledgerOf(['系统首页需要展示公告文案']));
  if (result.denominator.judged === 0) assert.equal(result.score, null);
  else assert.ok(result.score >= 0 && result.score <= 1);
});

test('打分口径：covered / (covered + missing)', () => {
  const result = inspectCompleteness(ledgerOf(
    ['订单可以新增', '订单可以查询', '订单可以修改', '订单可以删除', '预算范围 0-120'],
    [{ name: '订单', operations: ['create', 'read', 'update', 'delete'] }],
  ));
  const covered = result.checks.filter(item => item.status === 'covered').length;
  const missing = result.checks.filter(item => item.status === 'missing').length;
  assert.equal(result.score, Math.round((covered / (covered + missing)) * 1000) / 1000);
});

test('覆盖率分母修正：补入结构性缺口后分母变大，覆盖率下降', () => {
  const completeness = inspectCompleteness(ledgerOf(['预算字段需要保存', '订单可以新增']));
  const adjusted = adjustCoverage({ covered: 9, total: 10 }, completeness);
  assert.equal(adjusted.available, true);
  assert.equal(adjusted.reported, 0.9);
  assert.ok(adjusted.gaps >= 1);
  assert.ok(adjusted.adjusted < 0.9, '修正后必须低于原始值，否则这条修正没有意义');
  assert.match(adjusted.note, /分母由 10 修正为/);
});

test('完备性不可判时不修正分母，并说明原因', () => {
  const adjusted = adjustCoverage({ covered: 9, total: 10 }, inspectCompleteness({ rules: [] }));
  assert.equal(adjusted.available, false);
  assert.equal(adjusted.adjusted, null);
  assert.match(adjusted.note, /不代表业务完整性/);
});

test('buildEntityMatrix 声明优先：有 entities 就不再从文本瞎猜', () => {
  const matrix = buildEntityMatrix(
    { entities: [{ name: '订单', operations: ['create'], stateful: true }] },
    [rule('R1', '用户可创建草稿')],
  );
  assert.equal(matrix.basis, 'declared');
  assert.deepEqual(matrix.entities.map(item => item.name), ['订单']);
});
