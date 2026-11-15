import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDataset, parseDatasets, stepMutates, stepDatasetRefs,
  auditPlan, collectResidue, inspectLifecycle, renderLifecycleSection,
} from '../../scripts/data-lifecycle.mjs';

const ds = (over = {}) => parseDataset({ id: 'orders', setup: 'create orders', teardown: 'delete orders', ...over });

// ---------------- 声明解析 ----------------

test('声明缺 id 时拒绝归一化（返回 null）', () => {
  assert.equal(parseDataset({ setup: 'x' }), null);
  assert.equal(parseDataset(null), null);
});

test('无 teardown 的数据集自动获得 readonly_only 标记', () => {
  const d = parseDataset({ id: 'dic', setup: null, teardown: null });
  assert.equal(d.readonly_only, true);
  assert.equal(d.teardown, null);
});

test('parseDatasets 过滤掉无法归一化的条目', () => {
  const out = parseDatasets([{ id: 'a', teardown: 'x' }, { bad: true }, 'nope', null]);
  assert.deepEqual(out.map(d => d.id), ['a']);
});

// ---------------- 写语义判定 ----------------

test('显式声明优先：writes=true / readonly=true 直接生效', () => {
  assert.equal(stepMutates({ action: 'query', writes: true }).mutates, true);
  assert.equal(stepMutates({ action: 'create', readonly: true }).mutates, false);
});

test('HTTP 方法判定：POST/PUT/DELETE/PATCH 写、GET 只读', () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(stepMutates({ method: m }).mutates, true, m);
  }
  assert.equal(stepMutates({ method: 'get' }).mutates, false);
});

test('动词推断：create/delete 走写，query/verify 走只读', () => {
  assert.equal(stepMutates({ action: 'create_order' }).mutates, true);
  assert.equal(stepMutates({ action: 'verify_page' }).mutates, false);
});

test('判不出写语义时给 unknown，不冒充只读', () => {
  const v = stepMutates({ action: 'frobnicate' });
  assert.equal(v.mutates, false);
  assert.equal(v.reason, 'unknown');
});

test('数据集引用：${data.x} 占位与 dataset 字段两种写法都认', () => {
  const refs = stepDatasetRefs({ dataset: 'orders', inputs: { user: '${data.users.name}' } });
  assert.deepEqual(refs.sort(), ['orders', 'users']);
});

// ---------------- 计划审计 ----------------

test('写步骤引用未声明数据集 → UNDECLARED_DATASET', () => {
  const r = auditPlan({ steps: [{ id: 's1', action: 'create_order', dataset: 'vip' }] }, [ds()]);
  assert.ok(r.findings.some(f => f.code === 'UNDECLARED_DATASET' && f.dataset_id === 'vip'));
});

test('写步骤引用无 teardown 数据集 → MUTATING_WITHOUT_TEARDOWN（纪律 2）', () => {
  const r = auditPlan(
    { steps: [{ id: 's1', action: 'create_order', dataset: 'dic' }] },
    [ds({ id: 'dic', setup: null, teardown: null })],
  );
  assert.ok(r.findings.some(f => f.code === 'MUTATING_WITHOUT_TEARDOWN' && f.dataset_id === 'dic'));
});

test('写步骤引用无 setup 数据集 → MISSING_SETUP', () => {
  const r = auditPlan({ steps: [{ id: 's1', action: 'create_order', dataset: 'orders' }] },
    [ds({ setup: null })]);
  assert.ok(r.findings.some(f => f.code === 'MISSING_SETUP'));
});

test('对 persistent 数据集写 → PERSISTENT_MUTATED（纪律 3）', () => {
  const r = auditPlan({ steps: [{ id: 's1', action: 'delete_order', dataset: 'base' }] },
    [ds({ id: 'base', persistent: true })]);
  assert.ok(r.findings.some(f => f.code === 'PERSISTENT_MUTATED'));
});

test('只读计划零违规，写语义判不出的引用进 unknown_mutation', () => {
  const clean = auditPlan({ steps: [{ id: 's1', action: 'query_order', dataset: 'orders' }] }, [ds()]);
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.mutating_steps, 0);
  const unk = auditPlan({ steps: [{ id: 's2', action: 'do_magic', dataset: 'orders' }] }, [ds()]);
  assert.equal(unk.findings.length, 0);
  assert.equal(unk.unknown_mutation.length, 1);
});

// ---------------- 残留汇总 ----------------

test('teardown 失败进 data_residue，不许静默', () => {
  const r = collectResidue([ds()], [{ dataset_id: 'orders', ok: false, reason: '连接超时' }]);
  assert.deepEqual(r.data_residue, [{ dataset_id: 'orders', reason: '连接超时' }]);
});

test('声明了 teardown 但没执行记录 → 同样进 residue（没跑 ≠ 没残留）', () => {
  const r = collectResidue([ds()], []);
  assert.deepEqual(r.data_residue, [{ dataset_id: 'orders', reason: 'teardown 未执行——声明了清理但没有执行记录' }]);
});

test('清理成功进 cleaned；无 teardown 数据集进 readonly_sets', () => {
  const sets = [ds(), ds({ id: 'dic', setup: null, teardown: null })];
  const r = collectResidue(sets, [{ dataset_id: 'orders', ok: true }]);
  assert.deepEqual(r.cleaned, ['orders']);
  assert.deepEqual(r.readonly_sets, ['dic']);
  assert.deepEqual(r.data_residue, []);
});

test('清理结果对应的数据集未声明 → 同样进 residue（孤儿结果不许静默丢弃）', () => {
  const r = collectResidue([ds()], [{ dataset_id: 'orders', ok: true }, { dataset_id: 'ghost', ok: true }]);
  assert.deepEqual(r.data_residue, [{ dataset_id: 'ghost', reason: '清理结果对应的数据集未声明（ok=true）——声明与执行不一致' }]);
});

// ---------------- 汇总入口与呈现 ----------------

test('既无声明也无计划 → available=false 且说明后果', () => {
  const r = inspectLifecycle({});
  assert.equal(r.available, false);
  assert.equal(r.reason, 'no_declaration');
  assert.match(r.note, /未纳入任何清理机制/);
});

test('全链路：声明齐全 + 干净 teardown → 零违规零残留', () => {
  const r = inspectLifecycle({
    datasets: [ds()],
    plan: { steps: [{ id: 's1', action: 'create_order', dataset: 'orders' }, { id: 's2', action: 'query_order', dataset: 'orders' }] },
    teardown_results: [{ dataset_id: 'orders', ok: true }],
  });
  assert.equal(r.available, true);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.data_residue, []);
  assert.deepEqual(r.cleaned, ['orders']);
});

test('persistent 未建档 → PERSISTENT_UNFILED（声明级检查）', () => {
  const r = inspectLifecycle({ datasets: [ds({ id: 'base', persistent: true, teardown: 'x' })] });
  assert.ok(r.findings.some(f => f.code === 'PERSISTENT_UNFILED'));
});

test('renderLifecycleSection：残留正面呈现且违规逐条列出', () => {
  const r = inspectLifecycle({
    datasets: [ds(), ds({ id: 'dic', setup: null, teardown: null })],
    plan: { steps: [{ id: 's1', action: 'create_order', dataset: 'dic' }] },
    teardown_results: [{ dataset_id: 'orders', ok: false, reason: '外键约束' }],
  });
  const md = renderLifecycleSection(r);
  assert.match(md, /数据残留（data_residue）：1 个/);
  assert.match(md, /orders：外键约束/);
  assert.match(md, /\[MUTATING_WITHOUT_TEARDOWN\]/);
  assert.match(md, /只允许只读用途/);
});

test('renderLifecycleSection：available=false 时如实说无法核对', () => {
  const md = renderLifecycleSection(inspectLifecycle({}));
  assert.match(md, /未提供数据集声明/);
  assert.match(md, /不在任何清理机制之内/);
});
