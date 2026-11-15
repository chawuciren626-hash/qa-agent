import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCollection, toBacklog, contractDecision, downstreamNote,
} from '../../scripts/partial-submit.mjs';

const ids = count => Array.from({ length: count }, (_, index) => `REQ-${String(index + 1).padStart(4, '0')}`);

test('L-7 一条不缺就是 accepted，与旧行为一致', () => {
  const all = ids(40);
  const result = assessCollection(all, all.map(id => ({ id })));
  assert.equal(result.status, 'accepted');
  assert.equal(result.partial, false);
  assert.deepEqual(result.missing, []);
  assert.equal(result.coverage, 1);
  assert.equal(downstreamNote(result), null);
});

test('L-7 40 抽到 38：partial，放行 38 条、只卡那 2 条', () => {
  const all = ids(40);
  const submitted = all.slice(0, 38).map(id => ({ id }));
  const result = assessCollection(all, submitted, { blockOn: ['REQ-0001'] });
  assert.equal(result.status, 'partial');
  assert.equal(result.partial, true);
  assert.equal(result.accepted, 38);
  assert.deepEqual(result.missing, ['REQ-0039', 'REQ-0040']);
  assert.equal(result.coverage, 0.95);
  // 契约层要回的那一层：accept 与 partial 一起才说清放行了多少
  const decision = contractDecision(result);
  assert.equal(decision.accept, true);
  assert.equal(decision.partial, true);
  assert.deepEqual(decision.missing_ids, ['REQ-0039', 'REQ-0040']);
  // 下游必须知道这批不完整，否则它会在报告里写「已覆盖全部需求」
  assert.match(downstreamNote(result), /38\/40/);
  assert.match(downstreamNote(result), /不得表述为「已覆盖全部」/);
});

test('L-7 缺的是范围声明本身：blocked，部分放行会误导下游', () => {
  const all = ids(40);
  const submitted = all.filter(id => id !== 'REQ-0001').map(id => ({ id }));
  const result = assessCollection(all, submitted, { blockOn: ['REQ-0001'] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.partial, false);
  assert.match(result.reason, /范围声明本身缺失/);
});

test('L-7 覆盖率低于门槛就整批阻塞，不拿半张图去设计', () => {
  const all = ids(40);
  const submitted = all.slice(0, 20).map(id => ({ id }));
  const result = assessCollection(all, submitted);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /50.0% 低于门槛 80%/);
  // 门槛可调
  assert.equal(assessCollection(all, submitted, { minCoverage: 0.5 }).status, 'partial');
});

test('L-7 门槛不能关：minCoverage 必须是 (0,1]，空集合放不进去', () => {
  const all = ids(10);
  for (const minCoverage of [0, -0.1, 1.1, '0.8', Number.NaN]) {
    assert.throws(() => assessCollection(all, [{ id: 'REQ-0001' }], { minCoverage }), /minCoverage must be in \(0, 1\]/);
  }
  assert.throws(() => assessCollection([], [], { minCoverage: 0 }), /minCoverage/);
});

test('L-7 采到但不合规 = 错不是缺，必须重做而不是排队等补', () => {
  const all = ids(40);
  const submitted = all.slice(0, 39).map(id => ({ id }));
  // 第 39 条内容不合规（比如 statement 为空）
  submitted[38] = { id: 'REQ-0039', statement: '' };
  const result = assessCollection(all, submitted, { validId: id => id !== 'REQ-0039' });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.rejected, ['REQ-0039']);
  assert.match(result.reason, /这是错不是缺/);
});

test('L-7 一条都没采到不构成部分成功', () => {
  const result = assessCollection(ids(10), []);
  assert.equal(result.status, 'blocked');
  assert.equal(result.accepted, 0);
  assert.match(result.reason, /不构成部分成功/);
});

test('L-7 多采的条目单独列出，不当成缺也不悄悄吞掉', () => {
  const all = ids(5);
  const result = assessCollection(all, [...all, 'REQ-9999'].map(id => ({ id })));
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.unexpected, ['REQ-9999']);
});

test('L-7 待补队列：缺什么、属于哪个阶段，理由留空让人填', () => {
  const all = ids(10);
  const result = assessCollection(all, all.slice(0, 9).map(id => ({ id })));
  const backlog = toBacklog(result, { stage: 'analysis' });
  assert.deepEqual(backlog.map(item => item.id), ['REQ-0010']);
  assert.equal(backlog[0].stage, 'analysis');
  assert.equal(backlog[0].kind, 'awaiting_human_completion');
  // 理由不编：缺的原因只有人知道
  assert.equal(backlog[0].reason, null);
  const blocked = assessCollection(all, [{ id: 'REQ-0001' }]);
  assert.equal(toBacklog(blocked)[0].kind, 'blocking');
});

test('L-7 输入本身有问题时直接抛错，不做宽松解释', () => {
  assert.throws(() => assessCollection('x', []), /expectedIds must be an array/);
  assert.throws(() => assessCollection([], 'x'), /submitted must be an array/);
  assert.throws(() => assessCollection(['A', 'A'], []), /duplicate A/);
  assert.throws(() => assessCollection(['A'], [{ id: '' }]), /not a usable id/);
  assert.throws(() => assessCollection(['A'], [{}]), /not a usable id/);
});
