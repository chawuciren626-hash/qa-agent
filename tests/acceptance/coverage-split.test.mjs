import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCoverage, renderCoverageSection } from '../../scripts/coverage-split.mjs';

const cases = [
  { case_id: 'C1', type: 'UI' }, { case_id: 'C2', type: 'UI' },
  { case_id: 'C3', type: 'API' },
  { case_id: 'C4', type: '性能' }, { case_id: 'C5', type: '性能' }, { case_id: 'C6', type: '性能' },
];

test('没有设计用例时不产生覆盖率：null 比 0 诚实', () => {
  const result = inspectCoverage({ cases: [], results: [] });
  assert.equal(result.available, false);
  assert.equal(result.coverage_rate, null);
  assert.match(result.note, /不代表已覆盖/);
});

test('全部执行 → 两个口径一致', () => {
  const results = cases.map(item => ({ case_id: item.case_id, status: 'passed' }));
  const result = inspectCoverage({ cases, results });
  assert.equal(result.executed, 6);
  assert.equal(result.assigned_only, 0);
  assert.equal(result.coverage_rate, 1);
  assert.equal(result.optimistic_rate, 1);
});

test('性能类只分配未执行：覆盖率与旧口径差出来，差的就是注水那部分', () => {
  const results = [
    { case_id: 'C1', status: 'passed' }, { case_id: 'C2', status: 'failed' }, { case_id: 'C3', status: 'passed' },
  ];
  const result = inspectCoverage({ cases, results });
  assert.equal(result.executed, 3);
  assert.equal(result.assigned_only, 3);
  assert.equal(result.coverage_rate, 0.5);
  assert.equal(result.optimistic_rate, 1);
  assert.equal(result.by_layer['性能'].assigned_only, 3);
  assert.deepEqual(result.assigned_only_cases.map(item => item.case_id), ['C4', 'C5', 'C6']);
});

test('blocked / skipped 不算已执行：没跑成不等于测过', () => {
  const results = [{ case_id: 'C1', status: 'blocked' }, { case_id: 'C2', status: 'skipped' }];
  const result = inspectCoverage({ cases, results });
  assert.equal(result.executed, 0);
  assert.ok(result.warnings.some(text => /blocked\/skipped/.test(text)));
});

test('同一条用例多次执行，任一次真跑过就算已执行', () => {
  const results = [
    { case_id: 'C1', status: 'blocked' },
    { case_id: 'C1', status: 'passed' },
  ];
  assert.equal(inspectCoverage({ cases: [cases[0]], results }).executed, 1);
});

test('分层统计按验证方式归类，未识别的不硬塞进 UI/接口', () => {
  const result = inspectCoverage({ cases: [{ case_id: 'X', type: 'soap' }], results: [] });
  assert.ok(Object.hasOwn(result.by_layer, 'soap'));
});

test('有结果但一条都对不上设计用例 → 明确提示查 ID', () => {
  const result = inspectCoverage({ cases: [cases[0]], results: [{ case_id: 'ZZZ', status: 'passed' }] });
  assert.ok(result.warnings.some(text => /先查 ID 是否一致/.test(text)));
});

test('报告段落同时给两个数，并说明为什么不按旧口径报', () => {
  const results = [{ case_id: 'C1', status: 'passed' }];
  const text = renderCoverageSection(inspectCoverage({ cases, results }));
  assert.match(text, /已执行 1\/6/);
  assert.match(text, /不计入覆盖/);
  assert.match(text, /旧口径会显示为 100\.0%/);
  assert.match(text, /性能\/安全类当前只做到「分配」/);
});

test('无数据时段落直接说明，不留空白让人瞎猜', () => {
  assert.match(renderCoverageSection(inspectCoverage({ cases: [] })), /覆盖度拆分：/);
});
