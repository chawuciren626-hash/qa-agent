import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  resolvePlatformEndpoint, validatePlatformTaskRef, validatePlatformSummary,
  writebackPlatformTaskAnalysis,
} from '../../scripts/qa-platform-writeback.mjs';

const SUMMARY = {
  requirement_points: ['登录优化涉及验证码与记住密码两条链路'],
  suggested_test_scope: ['验证码错误重试', '记住密码跨会话'],
  suggested_priority: 'high',
  priority_reason: '登录是核心入口',
  risks: [],
  open_questions: [],
};

test('endpoint resolution prefers explicit args over env over host_data files', () => {
  const saved = { url: process.env.PENGUIN_API_URL, token: process.env.PENGUIN_API_TOKEN, home: process.env.PENGUIN_HOME };
  try {
    delete process.env.PENGUIN_API_URL;
    delete process.env.PENGUIN_API_TOKEN;
    delete process.env.PENGUIN_HOME;
    // env 缺失且无 host_data：明确报错，不猜地址
    assert.throws(() => resolvePlatformEndpoint(), /server\.lock not found/);
    // host_data 文件发现：server.lock 端口 + api-token
    const dir = mkdtempSync(resolve(tmpdir(), 'ptw-hostdata-'));
    try {
      writeFileSync(resolve(dir, 'server.lock'), JSON.stringify({ pid: 1, port: 59764 }));
      writeFileSync(resolve(dir, 'api-token'), 't'.repeat(48));
      const fromFiles = resolvePlatformEndpoint({ hostData: dir });
      assert.equal(fromFiles.baseUrl, 'http://localhost:59764');
      assert.equal(fromFiles.token, 't'.repeat(48));
      // 坏 token 格式拒绝
      writeFileSync(resolve(dir, 'api-token'), 'short');
      assert.throws(() => resolvePlatformEndpoint({ hostData: dir }), /invalid api-token/);
      writeFileSync(resolve(dir, 'api-token'), 't'.repeat(48));
      // env 覆盖文件；显式参数覆盖 env
      process.env.PENGUIN_API_URL = 'http://localhost:8001/';
      const fromEnv = resolvePlatformEndpoint({ hostData: dir });
      assert.equal(fromEnv.baseUrl, 'http://localhost:8001');
      const explicit = resolvePlatformEndpoint({ baseUrl: 'http://127.0.0.1:8002', token: 'u'.repeat(48) });
      assert.equal(explicit.baseUrl, 'http://127.0.0.1:8002');
      assert.equal(explicit.token, 'u'.repeat(48));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('task_ref and summary validators pin the write-back contract', () => {
  assert.equal(validatePlatformTaskRef({ kind: 'platform', task_id: 'ptl-1', project_id: 'proj' }), null);
  assert.equal(validatePlatformTaskRef({ kind: 'local', task_id: 'qlt-1', project_id: 'proj' }), null);
  assert.match(validatePlatformTaskRef(null) ?? '', /task_ref/);
  assert.match(validatePlatformTaskRef({ kind: 'other' }) ?? '', /kind/);
  assert.match(validatePlatformTaskRef({ kind: 'platform', task_id: '', project_id: 'p' }) ?? '', /task_id/);

  assert.equal(validatePlatformSummary(SUMMARY), null);
  assert.match(validatePlatformSummary(null) ?? '', /summary/);
  // 需求要点与建议范围同时为空 → 无效（服务端同样拒绝）
  assert.match(validatePlatformSummary({ requirement_points: [], suggested_test_scope: [] }) ?? '', /non-empty/);
  assert.match(validatePlatformSummary({ requirement_points: ['x'], suggested_priority: 'urgent' }) ?? '', /suggested_priority/);
  assert.match(validatePlatformSummary({ requirement_points: ['x'], risks: 'no' }) ?? '', /risks/);
  assert.match(validatePlatformSummary({ requirement_points: Array.from({ length: 21 }, (_, i) => String(i)) }) ?? '', /20 items/);
});

test('writeback posts Bearer JSON to the analysis-result endpoint and reports server rejection honestly', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ updated: true }) };
  };
  const outcome = await writebackPlatformTaskAnalysis({
    taskRef: { kind: 'platform', task_id: 'ptl-1', project_id: 'proj-1' },
    summary: SUMMARY,
    runId: 'run-abc-123',
    baseUrl: 'http://localhost:59764',
    token: 't'.repeat(48),
    fetchImpl,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.updated, true);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'http://localhost:59764/api/projects/proj-1/agents/qa/platform-tasks/ptl-1/analysis-result');
  assert.equal(init.method, 'POST');
  assert.match(init.headers.authorization, /^Bearer t{48}$/);
  assert.equal(init.headers['content-type'], 'application/json');
  const body = JSON.parse(init.body);
  assert.deepEqual(body.summary, SUMMARY);
  assert.equal(body.run_id, 'run-abc-123');

  // 服务端业务拒绝：ok=false 带 code/message，不抛异常——由总控如实上报
  const rejecting = async () => ({ ok: false, status: 409, json: async () => ({ code: 'analysis_not_running', message: '当前没有进行中的预分析' }) });
  const rejected = await writebackPlatformTaskAnalysis({
    taskRef: { kind: 'platform', task_id: 'ptl-1', project_id: 'proj-1' },
    summary: SUMMARY,
    baseUrl: 'http://localhost:59764',
    token: 't'.repeat(48),
    fetchImpl: rejecting,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'analysis_not_running');
  assert.match(rejected.message, /预分析/);

  // 网络/JSON 异常收敛为 network_error，不冒充成功
  const broken = async () => { throw new Error('ECONNREFUSED'); };
  const network = await writebackPlatformTaskAnalysis({
    taskRef: { kind: 'local', task_id: 'qlt-1', project_id: 'proj-1' },
    summary: SUMMARY,
    baseUrl: 'http://localhost:59764',
    token: 't'.repeat(48),
    fetchImpl: broken,
  });
  assert.equal(network.ok, false);
  assert.equal(network.code, 'network_error');
});

test('invalid task_ref short-circuits without any network call', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; };
  const outcome = await writebackPlatformTaskAnalysis({
    taskRef: { kind: 'platform' },
    summary: SUMMARY,
    baseUrl: 'http://localhost:59764',
    token: 't'.repeat(48),
    fetchImpl,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'invalid_task_ref');
  assert.equal(called, 0);
});
