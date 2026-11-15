import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  riskTier, diffSince, pickSample, evaluateSample, planConfirmation, checkCompletion,
} from '../../scripts/confirm-gate.mjs';

const it = (id, over = {}) => ({ id, title: `t-${id}`, risk: 'P1', ...over });

// ---------------- 风险分级 ----------------

test('涉资字段 / 权限变更视同 P0 强制全审（方案原文）', () => {
  assert.equal(riskTier({ risk: 'P2', money_fields: true }), 'force');
  assert.equal(riskTier({ risk: 'P2', permission_change: true }), 'force');
});

test('P0→force、P1→normal、P2→sample', () => {
  assert.equal(riskTier({ risk: 'P0' }), 'force');
  assert.equal(riskTier({ risk: 'P1' }), 'normal');
  assert.equal(riskTier({ risk: 'P2' }), 'sample');
});

test('缺风险字段 → unknown（调用方按 force 对待）', () => {
  assert.equal(riskTier({}), 'unknown');
});

// ---------------- 差异判定 ----------------

test('内容未变 → unchanged；新增或内容变了 → changed', () => {
  const prev = [it('a', { risk: 'P1', title: '旧标题' }), it('b')];
  const cur = [it('a', { title: '新标题' }), it('b'), it('c')];
  const { changed, unchanged } = diffSince(cur, prev);
  assert.deepEqual(changed.map(i => i.id).sort(), ['a', 'c']);
  assert.deepEqual(unchanged.map(i => i.id), ['b']);
});

test('版本号与时间戳变化不算实质差异', () => {
  const prev = [{ id: 'a', title: 'x', version: 1, updated_at: '2026-01-01' }];
  const cur = [{ id: 'a', title: 'x', version: 2, updated_at: '2026-02-02' }];
  assert.deepEqual(diffSince(cur, prev).changed, []);
});

test('没有上一版 → 全部按新增审（不假装能继承）', () => {
  const { changed, unchanged } = diffSince([it('a'), it('b')], null);
  assert.equal(changed.length, 2);
  assert.equal(unchanged.length, 0);
});

// ---------------- 抽样 ----------------

test('抽样确定性：同一种子同一批抽出的名单完全一致', () => {
  const items = Array.from({ length: 50 }, (_, i) => it(`c${String(i).padStart(3, '0')}`));
  const a = pickSample(items, { rate: 0.1, seed: 's1' }).map(i => i.id);
  const b = pickSample(items, { rate: 0.1, seed: 's1' }).map(i => i.id);
  assert.deepEqual(a, b);
});

test('抽样比例：ceil(n*rate)，至少 1 条', () => {
  const items = Array.from({ length: 50 }, (_, i) => it(`c${i}`));
  assert.equal(pickSample(items, { rate: 0.1 }).length, 5);
  assert.equal(pickSample([it('x')], { rate: 0.1 }).length, 1);
});

test('不同种子抽出不同名单', () => {
  const items = Array.from({ length: 50 }, (_, i) => it(`c${String(i).padStart(3, '0')}`));
  const a = pickSample(items, { seed: 's1' }).map(i => i.id);
  const b = pickSample(items, { seed: 's2' }).map(i => i.id);
  assert.notDeepEqual(a, b);
});

// ---------------- 抽样判定 ----------------

test('问题率整数比较：2/19 = 10.5% 超阈值 10% → 退回全审', () => {
  // 浮点 2/19 > 0.1 直觉上可能判错，整数法 200 > 190 必判对
  const r = evaluateSample({ picked: 19, problems: 2, threshold: 0.1 });
  assert.equal(r.escalate, true);
});

test('问题率未超阈值 → 不升级', () => {
  const r = evaluateSample({ picked: 20, problems: 1, threshold: 0.1 });
  assert.equal(r.escalate, false);
  assert.equal(r.conclusive, true);
});

test('样本过小（<10）→ 统计无意义，宁多审不冒充有把握', () => {
  const r = evaluateSample({ picked: 5, problems: 0, unreviewed: 45 });
  assert.equal(r.conclusive, false);
  assert.equal(r.escalate, true);
});

test('抽样名单为空 → 不可判定且升级', () => {
  const r = evaluateSample({ picked: 0, problems: 0 });
  assert.equal(r.escalate, true);
});

// ---------------- 确认计划 ----------------

test('mode=diff：changed 必审、unchanged 低风险继承、force 不受省略', () => {
  const prev = [it('same', { risk: 'P1' })];
  const items = [
    it('changed-p1', { risk: 'P1', title: 'new' }),
    it('same', { risk: 'P1' }),
    it('same-force', { risk: 'P1', money_fields: true }),   // 未变但涉资 → 仍必审
    it('changed-p0', { risk: 'P0', title: 'new' }),
    it('changed-p2', { risk: 'P2', title: 'new' }),          // diff 模式下 changed 的 P2 也要审
  ];
  const plan = planConfirmation({ items, previous: prev, mode: 'diff' });
  assert.deepEqual(plan.must_review.sort(), ['changed-p0', 'changed-p1', 'changed-p2', 'same-force']);
  assert.deepEqual(plan.inherit, ['same']);
});

test('mode=sample：force 全审 + normal 进抽样池 + P2 继承（仅抽样待遇）', () => {
  const items = [
    it('f0', { risk: 'P0' }),
    it('n1', { risk: 'P1' }), it('n2', { risk: 'P1' }), it('n3', { risk: 'P1' }),
    it('n4', { risk: 'P1' }), it('n5', { risk: 'P1' }), it('n6', { risk: 'P1' }),
    it('n7', { risk: 'P1' }), it('n8', { risk: 'P1' }), it('n9', { risk: 'P1' }),
    it('n10', { risk: 'P1' }), it('n11', { risk: 'P1' }),
    it('p2', { risk: 'P2' }),
  ];
  const plan = planConfirmation({ items, mode: 'sample', rate: 0.2 });
  assert.deepEqual(plan.must_review, ['f0']);
  assert.equal(plan.sample_pool.length, 11);
  assert.deepEqual(plan.sampled.length >= 1 && plan.sampled.length <= 3, true);
  assert.ok(plan.inherit.includes('p2'));
  // 抽样名单必须来自抽样池
  for (const id of plan.sampled) assert.ok(plan.sample_pool.includes(id));
});

test('mode=all → 全审，任何模式缺风险字段按 force 对待', () => {
  const plan = planConfirmation({ items: [it('a'), it('b')], mode: 'all' });
  assert.deepEqual(plan.must_review.sort(), ['a', 'b']);
  const plan2 = planConfirmation({ items: [it('u', { risk: undefined })], mode: 'sample' });
  assert.deepEqual(plan2.must_review, ['u']);
});

// ---------------- 反绕过 ----------------

test('必审项缺确认记录 → complete=false 并逐条列出', () => {
  const plan = planConfirmation({ items: [it('a', { risk: 'P0' }), it('b', { risk: 'P0' })], mode: 'diff' });
  const r = checkCompletion(plan, [{ id: 'a', result: 'approved', by: '张三' }]);
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['b']);
});

test('skipped 不算确认——「审过了但跳过」是绕过的常见马甲', () => {
  const plan = planConfirmation({ items: [it('a', { risk: 'P0' })], mode: 'diff' });
  const r = checkCompletion(plan, [{ id: 'a', result: 'skipped', by: '张三' }]);
  assert.equal(r.complete, false);
  assert.deepEqual(r.skipped, ['a']);
  assert.match(r.note, /绕过/);
});

test('全部逐条确认 → complete=true', () => {
  const plan = planConfirmation({ items: [it('a', { risk: 'P0' })], mode: 'diff' });
  const r = checkCompletion(plan, [{ id: 'a', result: 'approved', by: '张三' }]);
  assert.equal(r.complete, true);
  assert.match(r.note, /无缺口/);
});
