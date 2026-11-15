import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildRuntimeSections } from '../../scripts/report-runtime-sections.mjs';

function withRun(fn) {
  const root = mkdtempSync(resolve(tmpdir(), 'qa-runtime-'));
  const dir = resolve(root, 'output/runs/run-22222222-3333-4444-5555-666666666666');
  mkdirSync(dir, { recursive: true });
  try { return fn({ root, dir }); } finally { rmSync(root, { recursive: true, force: true }); }
}

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test('产物全缺时每项都说「未生成」，不留空白让人以为没问题', () => withRun(({ root, dir }) => {
  const { markdown } = buildRuntimeSections({ root, dir });
  assert.match(markdown, /## 运行时事实/);
  assert.match(markdown, /未生成调用轨迹/);
  assert.match(markdown, /未提供外部依赖桩声明/);
  assert.match(markdown, /未生成需求完备性检查/);
  assert.match(markdown, /未生成缺陷根因聚类/);
  assert.match(markdown, /未生成覆盖度拆分/);
}));

test('有降级时报告正面上写明「纪律没生效」——这是上一轮最大的遗留', () => withRun(({ root, dir }) => {
  const lines = [
    { ok: true, action: 'export_report', tools: ['irval.check'], degraded: ['regression.select'] },
    { ok: false, action: 'validate_artifacts', tools: ['irval.check'], degraded: ['regression.select'] },
  ].map(row => JSON.stringify(row));
  mkdirSync(resolve(dir, 'traces'), { recursive: true });
  writeFileSync(resolve(dir, 'traces/trace.jsonl'), `${lines.join('\n')}\n`);
  const { markdown, data } = buildRuntimeSections({ root, dir });
  assert.match(markdown, /2 次结构化动作调用，失败 1 次/);
  assert.match(markdown, /纪律降级：regression\.select×2/);
  assert.match(markdown, /对应校验没有生效/);
  assert.equal(data.trace.degraded['regression.select'], 2);
}));

test('停用中的工具列出来：报告生成时不参与判定的能力要说清', () => withRun(({ root, dir }) => {
  writeJson(resolve(root, 'config/tool-runtime-state.json'), { version: 1, disabled: ['expected.provenance'] });
  const { markdown } = buildRuntimeSections({ root, dir });
  assert.match(markdown, /处于停用状态.*expected\.provenance/);
}));

test('需求完备性：无法判定的项单独说，不混进分数', () => withRun(({ root, dir }) => {
  writeJson(resolve(dir, 'analysis/requirement-completeness.json'), {
    available: true, score: 0.5,
    denominator: { covered: 2, missing: 2, unknown: 1 },
    checks: [
      { id: 'entity_crud', label: '实体完整性', status: 'missing', missing: [{ entity: '订单', missing_operations: ['delete'] }] },
      { id: 'numeric_bounds', label: '数值边界', status: 'covered', missing: [] },
    ],
  });
  const { markdown } = buildRuntimeSections({ root, dir });
  assert.match(markdown, /需求完备性：50%/);
  assert.match(markdown, /无法判定 1 项/);
  assert.match(markdown, /缺「实体完整性」/);
}));

test('缺陷聚类段落带「不合并单」的说明', () => withRun(({ root, dir }) => {
  writeJson(resolve(dir, 'defects/root-cause-clusters.json'), {
    merge_safety: 'display_only',
    stats: { records: 40, tickets_before: 40, groups_after: 1, clustered_defects: 40, clusters: 1 },
    clusters: [{ cluster_id: 'RC-1', size: 40, summary: '40 张单同源：HTTP500 @ GET /api/orders/:id' }],
  });
  const { markdown } = buildRuntimeSections({ root, dir });
  assert.match(markdown, /40 张单归并为 1 组/);
  assert.match(markdown, /仍各自可提单/);
}));

test('覆盖度段落区分已执行与仅分配', () => withRun(({ root, dir }) => {
  writeJson(resolve(dir, 'execution/coverage-split.json'), {
    available: true, designed: 10, executed: 7, assigned_only: 3,
    coverage_rate: 0.7, optimistic_rate: 1,
    by_layer: { UI: { designed: 7, executed: 7, assigned_only: 0 }, 性能: { designed: 3, executed: 0, assigned_only: 3 } },
    warnings: ['3 条设计用例只有验证方式分配、没有执行结果，不得计入已覆盖。'],
  });
  const { markdown } = buildRuntimeSections({ root, dir });
  assert.match(markdown, /已执行 7\/10 = 70\.0%/);
  assert.match(markdown, /不计入覆盖/);
}));

test('外部依赖桩声明写在报告里，含保留失败数', () => withRun(({ root, dir }) => {
  writeJson(resolve(dir, 'execution/execution-summary.json'), {
    stubs: { applied: true, declared: ['sms', 'pay'], downgraded: [{ case_id: 'C1' }], kept_fail: [{ case_id: 'C2' }] },
  });
  const { markdown } = buildRuntimeSections({ root, dir });
  assert.match(markdown, /已声明 2 个/);
  assert.match(markdown, /1 条因依赖不可用降为 inconclusive/);
  assert.match(markdown, /1 条依赖已打桩仍失败/);
}));

test('坏行不影响整段生成：报告不能因为一行损坏就整体失败', () => withRun(({ root, dir }) => {
  mkdirSync(resolve(dir, 'traces'), { recursive: true });
  writeFileSync(resolve(dir, 'traces/trace.jsonl'), '{"ok":true,"tools":[],"degraded":[]}\nnot json\n');
  const { markdown } = buildRuntimeSections({ root, dir });
  assert.match(markdown, /1 次结构化动作调用/);
}));
