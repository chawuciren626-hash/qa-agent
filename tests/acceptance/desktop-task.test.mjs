/**
 * 桌面 computer-use 引擎切片验收：desktop_task 动作模块的结构契约、锁与真实探针。
 *
 * 不触碰真实 GUI 动作（tap/replay 不在本文件执行）：动作层的真实交互由部署环境验收
 * （记事本 demo）。这里核对的是纪律层——封闭操作集、坐标拒绝、锁互斥、闸门绑定、
 * 平台枚举与阶段回执接线，以及 Python 探针在真实桌面上的快照（有 Python 时）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { acquireDesktopLock, runDesktopOperation, validateDesktopOperation } from '../../scripts/desktop-task.mjs';
import { gateAction } from '../../scripts/tool-gate.mjs';
import { DESKTOP_STAGE_TOOLS, stageToolReceipts } from '../../scripts/stage-tool-runtime.mjs';
import { desktopScenarioPrompt } from '../../scripts/stage-tool-scenarios.mjs';

const root = resolve(import.meta.dirname, '../..');

test('desktop_task 操作集封闭：未知类型/动作/坐标一律拒绝', () => {
  assert.throws(() => validateDesktopOperation({ type: 'evaluate', request_id: 'r1' }), /type must be one of/);
  assert.throws(() => validateDesktopOperation({ type: 'visual', request_id: 'r1', action: 'click' }), /action must be one of/);
  // 坐标不进计划：v2 §3.5.5 硬约束在重放层的落点
  assert.throws(() => validateDesktopOperation({ type: 'replay', request_id: 'r1', plan: { steps: [{ op: 'tap', target: { automation_id: 'a' }, x: 100 }] } }), /coordinates/);
  assert.throws(() => validateDesktopOperation({ type: 'visual', request_id: 'r1', action: 'tap' }), /target/);
  assert.throws(() => validateDesktopOperation({ type: 'snapshot', request_id: 'r1', command: 'rm' }), /unknown operation fields/);
  validateDesktopOperation({ type: 'doctor', request_id: 'r1' });
  validateDesktopOperation({ type: 'snapshot', request_id: 'r1', window_hint: { title: '记事本' } });
  validateDesktopOperation({ type: 'replay', request_id: 'r1', plan: { steps: [{ op: 'assert_anchor', target: { automation_id: 'btn' } }] } });
});

test('桌面锁互斥：活进程持锁拒绝，死进程锁可接管', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'desktop-lock-'));
  try {
    const release = acquireDesktopLock(dir, { request_id: 'req-a', type: 'snapshot' });
    assert.throws(() => acquireDesktopLock(dir, { request_id: 'req-b', type: 'snapshot' }), /Desktop is busy/);
    release();
    const second = acquireDesktopLock(dir, { request_id: 'req-b', type: 'snapshot' });
    second();
    // 伪造一个已退出的持有者：允许接管（宿主崩了不永久占屏）
    writeFileSync(resolve(dir, 'execution', 'desktop.lock'), JSON.stringify({ pid: 999999999, request_id: 'ghost', at: new Date().toISOString() }));
    const third = acquireDesktopLock(dir, { request_id: 'req-c', type: 'snapshot' });
    third();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('闸门绑定：desktop.snapshot 停用时 desktop_task 被硬拦截', () => {
  const rootDir = mkdtempSync(resolve(tmpdir(), 'desktop-gate-'));
  try {
    mkdirSync(resolve(rootDir, 'config'), { recursive: true });
    writeFileSync(resolve(rootDir, 'config', 'tool-runtime-state.json'), JSON.stringify({ disabled: ['desktop.snapshot'], versions: {} }));
    const blocked = gateAction(rootDir, 'desktop_task', {});
    assert.match(blocked.blocked ?? '', /desktop\.snapshot/);
    mkdirSync(resolve(rootDir, 'config'), { recursive: true });
    writeFileSync(resolve(rootDir, 'config', 'tool-runtime-state.json'), JSON.stringify({ disabled: [], versions: {} }));
    assert.equal(gateAction(rootDir, 'desktop_task', {}).blocked, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('桌面阶段工具登记与回执索引接线', () => {
  assert.deepEqual(Object.keys(DESKTOP_STAGE_TOOLS).sort(), ['desktop.replay', 'desktop.snapshot', 'desktop.visual_probe']);
  for (const spec of Object.values(DESKTOP_STAGE_TOOLS)) assert.equal(spec.stage, 'execution');
  // stageToolReceipts 接受桌面回执：伪造一份已完成回执，能被索引读出
  const rootDir = mkdtempSync(resolve(tmpdir(), 'desktop-receipts-'));
  try {
    const runDir = resolve(rootDir, 'output/runs/run-desktop-1');
    mkdirSync(resolve(runDir, 'audit/stage-tools'), { recursive: true });
    writeFileSync(resolve(runDir, 'manifest.json'), JSON.stringify({ run_id: 'run-desktop-1', stages: { execution: { status: 'completed' } } }));
    writeFileSync(resolve(runDir, 'audit/stage-tools', `${'a'.repeat(8)}-0000-4000-8000-000000000000.json`), JSON.stringify({
      version: 1, run_id: 'run-desktop-1', stage: 'execution', tool_id: 'desktop.snapshot', implementation: 'scripts/desktop-task.mjs',
      implementation_sha256: 'x', input_sha256: 'y', status: 'completed',
    }));
    const rows = stageToolReceipts(rootDir, 'run-desktop-1');
    assert.equal(rows.filter(row => row.tool_id === 'desktop.snapshot').length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('桌面轨道规则进入派发合同：快照先行、锚点降级、重放零模型', () => {
  const prompt = desktopScenarioPrompt();
  assert.match(prompt, /desktop\.snapshot/);
  assert.match(prompt, /anchor/);
  assert.match(prompt, /零模型/);
});

test('plan-run 平台枚举接受 desktop、拒绝未知平台', () => {
  // platform 校验先于 run-id 校验：desktop 能走到"缺 run-id"的用法错误，说明枚举放行
  const missingRun = spawnSync(process.execPath, [resolve(root, 'scripts/plan-run.mjs'), '--execution-platform=desktop'], { cwd: root, encoding: 'utf8' });
  assert.match(missingRun.stderr, /run_id/);
  const bad = spawnSync(process.execPath, [resolve(root, 'scripts/plan-run.mjs'), '--execution-platform=mainframe'], { cwd: root, encoding: 'utf8' });
  assert.match(bad.stderr, /execution-platform must be web, android, miniprogram or desktop/);
});

test('doctor 与 snapshot 在真实桌面上的回执（有 Python 时）', { skip: !process.env.QA_PYTHON && !process.env.AITEST_ENGINE_ROOT }, async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'desktop-run-'));
  try {
    const doctor = await runDesktopOperation({ root, dir, operation: { type: 'doctor', request_id: 'doctor-1' } });
    assert.equal(doctor.status, 'ok', JSON.stringify(doctor));
    assert.equal(doctor.result.python.ok, true);
    // UIA 探针依赖 pywinauto：部署运行时的 Python 未装它时，doctor 如实报缺，
    // snapshot 不跑（部署机装好后走完整路径）——能力缺失必须说出来，不冒充可用。
    if (!doctor.result.uia.ok) {
      assert.match(doctor.result.uia.error, /pywinauto|probe import/);
      return;
    }
    // snapshot：不给 hint = 全部顶层窗口，真实 UIA 枚举必须返回结构
    const snapshot = await runDesktopOperation({ root, dir, operation: { type: 'snapshot', request_id: 'snap-1', max_nodes: 60, max_depth: 4 } });
    assert.equal(snapshot.status, 'ok', JSON.stringify(snapshot).slice(0, 400));
    assert.equal(snapshot.result.source, 'dom');
    assert.ok(Array.isArray(snapshot.result.elements) && snapshot.result.elements.length > 0);
    // 幂等：同 request_id 复用原回执
    const again = await runDesktopOperation({ root, dir, operation: { type: 'snapshot', request_id: 'snap-1' } });
    assert.equal(again.duplicate, true);
    const receipt = JSON.parse(readFileSync(resolve(dir, 'execution/desktop-receipts/snap-1.json'), 'utf8'));
    assert.equal(receipt.request_id, 'snap-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
