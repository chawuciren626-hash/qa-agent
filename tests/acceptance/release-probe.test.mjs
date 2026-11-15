import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  fingerprintRelease, detectRelease, planProbe, evaluateProbe,
  inspectReleaseProbe, readReleaseBaseline, writeReleaseBaseline,
  DEFAULT_THRESHOLD,
} from '../../scripts/release-probe.mjs';

const cases = Array.from({ length: 30 }, (_, i) => ({
  case_id: `TC-${String(i).padStart(2, '0')}`,
  module: `M${i % 4}`,
  priority: i < 8 ? 'S1' : 'S3',
}));

test('发布指纹对资源顺序不敏感：同样的内容换个顺序不该算发版', () => {
  const a = fingerprintRelease({ build_id: 'b1', assets: [{ path: '/a.js', sha256: '1' }, { path: '/b.js', sha256: '2' }] });
  const b = fingerprintRelease({ build_id: 'b1', assets: [{ path: '/b.js', sha256: '2' }, { path: '/a.js', sha256: '1' }] });
  assert.equal(a.digest, b.digest);
  const c = fingerprintRelease({ build_id: 'b1', assets: [{ path: '/a.js', sha256: '9' }, { path: '/b.js', sha256: '2' }] });
  assert.notEqual(a.digest, c.digest);
});

test('首次没有基线 → no_baseline，且不拦：第一次上线不能被自己的规则拦住', () => {
  const current = fingerprintRelease({ build_id: 'b1' });
  const d = detectRelease(null, current);
  assert.equal(d.status, 'no_baseline');
  assert.equal(d.changed, false);
  const result = inspectReleaseProbe({ previous: null, current });
  assert.equal(result.gate.allow_full_report, true);
});

test('构建号变化被识别为发版', () => {
  const previous = fingerprintRelease({ build_id: 'b1' });
  const current = fingerprintRelease({ build_id: 'b2' });
  const d = detectRelease(previous, current);
  assert.equal(d.status, 'changed');
  assert.deepEqual(d.changes.map(item => item.field), ['build_id']);
});

test('资源指纹变化也算发版（构建号不变但资源变了，是最容易漏的一种）', () => {
  const previous = fingerprintRelease({ build_id: 'b1', assets: [{ path: '/app.js', sha256: 'aaa' }] });
  const current = fingerprintRelease({ build_id: 'b1', assets: [{ path: '/app.js', sha256: 'bbb' }] });
  assert.equal(detectRelease(previous, current).changed, true);
});

test('既没构建号也没资源指纹 → unknown，不假装「没发版」', () => {
  const d = detectRelease({ digest: 'x', build_id: 'b1' }, fingerprintRelease({}));
  assert.equal(d.status, 'unknown');
  assert.equal(d.changed, false);
  assert.match(d.note, /不代表未发版/);
  // 不触发探针，但也不拦
  assert.equal(inspectReleaseProbe({ previous: { digest: 'x' }, current: fingerprintRelease({}) }).gate.allow_full_report, true);
});

test('探针选样是确定性的：随机抽样会让同一版本两次结论不同', () => {
  const a = planProbe(cases, { size: 10 });
  const b = planProbe([...cases].reverse(), { size: 10 });
  assert.deepEqual(a.selected.map(item => item.case_id), b.selected.map(item => item.case_id));
  assert.equal(a.selected.length, 10);
});

test('探针优先取 S1，且先覆盖不同模块', () => {
  const plan = planProbe(cases, { size: 6 });
  const modules = new Set(plan.selected.slice(0, 4).map(item => item.module));
  assert.equal(modules.size, 4, '前 4 条应覆盖 4 个模块');
  assert.ok(plan.selected.every(item => item.weight <= 2));
  assert.ok(plan.selected.some(item => item.weight === 0), '应包含 S1');
});

test('用例不足时如实说明，不凑数', () => {
  const plan = planProbe(cases.slice(0, 3), { size: 20 });
  assert.equal(plan.selected.length, 3);
  assert.match(plan.note, /样本越小/);
});

test('失败率阈值是 > 20%，20 条里 4 条失败不拦、5 条才拦', () => {
  const four = evaluateProbe({ results: Array.from({ length: 20 }, (_, i) => ({ status: i < 4 ? 'failed' : 'passed' })) });
  assert.equal(four.status, 'probe_passed');
  assert.equal(four.blocked, false);
  assert.equal(four.failure_rate, 0.2);

  const five = evaluateProbe({ results: Array.from({ length: 20 }, (_, i) => ({ status: i < 5 ? 'failed' : 'passed' })) });
  assert.equal(five.status, 'probe_failed');
  assert.equal(five.blocked, true);
  assert.match(five.expression, /5\/20 = 25\.0% > 20%/);
  assert.match(five.blocked_reason, /重建档/);
});

test('被拦时说的是「不出全量报告」，不是「本次结论无效」', () => {
  const result = evaluateProbe({ results: Array.from({ length: 10 }, () => ({ status: 'failed' })) });
  assert.match(result.note, /探针报告照常可看/);
});

test('inconclusive 不算失败也不算通过：算失败会误拦，算通过会掩盖环境问题', () => {
  const result = evaluateProbe({ results: Array.from({ length: 10 }, (_, i) => ({ status: i < 3 ? 'inconclusive' : 'passed' })) });
  assert.equal(result.failed, 0);
  assert.equal(result.inconclusive, 3);
  assert.equal(result.failure_rate, 0);
  assert.equal(result.blocked, false);
});

test('过半不可判 → 整体 inconclusive，失败率无意义', () => {
  const result = evaluateProbe({ results: Array.from({ length: 6 }, (_, i) => ({ status: i < 4 ? 'inconclusive' : 'failed' })) });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.failure_rate, null);
});

test('超预算算不可判，不给结论', () => {
  const result = evaluateProbe({ results: [{ status: 'passed' }], elapsed_ms: 400_000, budget_ms: 180_000 });
  assert.equal(result.status, 'inconclusive');
  assert.match(result.note, /先查环境/);
});

test('没有探针结果时既不拦也不放行', () => {
  const result = evaluateProbe({ results: [] });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.blocked, false);
  assert.match(result.note, /不能据此放行/);
});

test('发版 + 无结果 → 拦全量报告并说明要先跑探针', () => {
  const previous = fingerprintRelease({ build_id: 'b1' });
  const current = fingerprintRelease({ build_id: 'b2' });
  const result = inspectReleaseProbe({ previous, current, cases });
  assert.equal(result.gate.allow_full_report, false);
  assert.match(result.gate.why, /冒烟探针/);
});

test('发版 + 探针通过 → 放行；发版 + 探针失败 → 拦', () => {
  const previous = fingerprintRelease({ build_id: 'b1' });
  const current = fingerprintRelease({ build_id: 'b2' });
  const plan = planProbe(cases, { size: 10 });
  const ok = inspectReleaseProbe({ previous, current, cases, results: plan.selected.map(item => ({ case_id: item.case_id, status: 'passed' })) });
  assert.equal(ok.gate.allow_full_report, true);
  const bad = inspectReleaseProbe({ previous, current, cases, results: plan.selected.map((item, i) => ({ case_id: item.case_id, status: i < 5 ? 'failed' : 'passed' })) });
  assert.equal(bad.gate.allow_full_report, false);
  assert.match(bad.gate.why, /重建档/);
});

test('无变化时跳过探针，不浪费 3 分钟', () => {
  const previous = fingerprintRelease({ build_id: 'b1' });
  const result = inspectReleaseProbe({ previous, current: fingerprintRelease({ build_id: 'b1' }), cases });
  assert.equal(result.probe, null);
  assert.equal(result.gate.allow_full_report, true);
});

test('基线可读写，落盘后能读回', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'qa-probe-'));
  try {
    assert.deepEqual(readReleaseBaseline(root).releases, {});
    const fp = fingerprintRelease({ build_id: 'b9' });
    writeReleaseBaseline(root, fp);
    const store = readReleaseBaseline(root);
    assert.equal(store.releases.default.build_id, 'b9');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('默认阈值就是方案写的 20%', () => {
  assert.equal(DEFAULT_THRESHOLD, 0.2);
});
