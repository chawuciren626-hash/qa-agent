import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { recordTrace, readTrace, summarizeTrace, redactArgs, traceNodeId, tracePath, listTracedRuns } from '../../scripts/trace.mjs';

const RUN = 'run-11111111-2222-3333-4444-555555555555';

function withRoot(run) {
  const root = mkdtempSync(resolve(tmpdir(), 'qa-trace-'));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('没有 trace 时 available=false，不拿 0 当结论', () => withRoot(root => {
  const s = summarizeTrace(root, RUN);
  assert.equal(s.available, false);
  assert.equal(s.reason, 'no_trace');
  // 「没记录」和「没调用」不是一回事，摘要里必须说清
  assert.match(s.note, /不据此判断/);
}));

test('一次动作一行，节点 ID 由 run/阶段/动作拼成，与血缘图对齐', () => withRoot(root => {
  const row = recordTrace(root, { run_id: RUN, stage: 'case', action: 'diagnose_test_cases', session: 'session-1', status: 'completed', exit_code: 0, ok: true, elapsed_ms: 12.3456, args: { stage: 'case' }, tools: ['irval.check'] });
  assert.ok(row);
  assert.equal(row.node_id, `${RUN}:case:diagnose_test_cases`);
  assert.equal(traceNodeId({ runId: RUN, stage: 'case', action: 'x' }), `${RUN}:case:x`);
  assert.equal(row.elapsed_ms, 12.346, '耗时保留 3 位小数，毫秒级排查够用');
  const rows = readTrace(root, RUN);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempt, 1);
  assert.deepEqual(rows[0].tools, ['irval.check']);
}));

test('参数脱敏：密码/token/cookie 一律 [redacted]，文件里不留明文', () => withRoot(root => {
  recordTrace(root, {
    run_id: RUN, action: 'dispatch', stage: 'execution',
    args: { password: 'P@ssw0rd!', api_token: 'sk-live-abcdef', headers: { Cookie: 'sid=abc', 'content-type': 'application/json' }, nested: { secret: 'x' } },
  });
  const raw = readFileSync(tracePath(root, RUN), 'utf8');
  for (const leaked of ['P@ssw0rd!', 'sk-live-abcdef', 'sid=abc']) assert.ok(!raw.includes(leaked), `明文 ${leaked} 落盘了`);
  assert.ok(raw.includes('[redacted]'));
  // 非敏感键必须保留，否则 trace 就没有排查价值了
  assert.ok(raw.includes('content-type'));
}));

test('长文本截断、大数组只留长度：trace 是指路，不是参数仓库', () => withRoot(root => {
  const long = 'a'.repeat(500);
  const shaped = redactArgs({ text: long, ids: Array.from({ length: 40 }, (_, i) => i) });
  assert.match(shaped.text, /…\(500\)$/);
  assert.equal(shaped.ids.length, 11);
  assert.match(shaped.ids.at(-1), /40 items/);
}));

test('脱敏对数组里的对象同样生效（不能只处理顶层）', () => withRoot(root => {
  const shaped = redactArgs([{ token: 'a' }, { ok: 1 }]);
  assert.equal(shaped[0].token, '[redacted]');
  assert.equal(shaped[1].ok, 1);
}));

test('同一节点多次调用由读取端编号 attempt，写入端不读历史', () => withRoot(root => {
  for (let i = 0; i < 3; i += 1) recordTrace(root, { run_id: RUN, stage: 'case', action: 'validate_artifacts', ok: i === 2, status: i === 2 ? 'completed' : 'rejected' });
  const rows = readTrace(root, RUN);
  assert.deepEqual(rows.map(r => r.attempt), [1, 2, 3]);
  // 写入端确实没依赖历史：文件里不该出现 attempt 字段
  const raw = readFileSync(tracePath(root, RUN), 'utf8');
  assert.ok(!raw.includes('"attempt"'));
}));

test('按动作/阶段/成败过滤，limit 取最近 N 条', () => withRoot(root => {
  recordTrace(root, { run_id: RUN, stage: 'report', action: 'export_report', ok: true, status: 'completed' });
  recordTrace(root, { run_id: RUN, stage: 'case', action: 'validate_artifacts', ok: false, status: 'rejected', error: 'x' });
  recordTrace(root, { run_id: RUN, stage: 'case', action: 'validate_artifacts', ok: true, status: 'completed' });
  assert.equal(readTrace(root, RUN, { action: 'validate_artifacts' }).length, 2);
  assert.equal(readTrace(root, RUN, { stage: 'report' }).length, 1);
  assert.equal(readTrace(root, RUN, { ok: false }).length, 1);
  assert.equal(readTrace(root, RUN, { limit: 1 })[0].action, 'validate_artifacts');
}));

test('坏行不影响整份 trace：进程被杀留下的半行不能带崩读取', () => withRoot(root => {
  recordTrace(root, { run_id: RUN, action: 'a', ok: true, status: 'completed' });
  const path = tracePath(root, RUN);
  writeFileSync(path, '{"v":1,"at":"2026-01-01T00:00:00.000Z","act\n', { flag: 'a' });
  recordTrace(root, { run_id: RUN, action: 'b', ok: true, status: 'completed' });
  assert.deepEqual(readTrace(root, RUN).map(r => r.action), ['a', 'b']);
}));

test('摘要把失败与降级单列：排查入口不该埋在 46 个成功里', () => withRoot(root => {
  recordTrace(root, { run_id: RUN, action: 'export_report', ok: false, status: 'rejected', error: '工具「regression.select」已停用', degraded: ['regression.select'], tools: ['irval.check', 'regression.select'], elapsed_ms: 900 });
  recordTrace(root, { run_id: RUN, action: 'run_status', ok: true, status: 'completed', elapsed_ms: 5 });
  const s = summarizeTrace(root, RUN);
  assert.equal(s.available, true);
  assert.equal(s.total, 2);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.degraded_tools, { 'regression.select': 1 });
  assert.equal(s.failures.length, 1);
  assert.match(s.failures[0].error, /已停用/);
  assert.equal(s.slowest[0].action, 'export_report');
}));

test('无 run_id 落到全局 trace，不会伪造一个 run 目录', () => withRoot(root => {
  recordTrace(root, { action: 'create_run', ok: true, status: 'completed' });
  assert.equal(tracePath(root, null), resolve(root, 'output/traces/global.jsonl'));
  assert.equal(readTrace(root, null).length, 1);
  assert.equal(readTrace(root, null)[0].node_id, 'no-run:-:create_run');
}));

test('listTracedRuns 只列带 trace 的 run', () => withRoot(root => {
  recordTrace(root, { run_id: RUN, action: 'a', ok: true, status: 'completed' });
  mkdirSync(resolve(root, 'output/runs/run-99999999-0000-0000-0000-000000000000'), { recursive: true });
  const runs = listTracedRuns(root);
  assert.deepEqual(runs.map(r => r.run_id), [RUN]);
}));

test('写盘失败不抛：trace 是观测，不该让一次 action 因磁盘问题失败', () => {
  // 把 root 指到一个不可能创建的路径（普通文件下的子路径）
  const root = mkdtempSync(resolve(tmpdir(), 'qa-trace-bad-'));
  try {
    writeFileSync(resolve(root, 'output'), 'not a directory');
    assert.equal(recordTrace(root, { run_id: RUN, action: 'a' }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
