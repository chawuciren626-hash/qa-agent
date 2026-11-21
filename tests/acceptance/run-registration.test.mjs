import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { manifestFacts, registrationContext, finishRun, startRun } from '../../scripts/run-registration.mjs';

const RUN_ID = 'run-22222222-3333-4444-5555-666666666666';
const MANIFEST = {
  run_id: RUN_ID,
  manifest_version: 3,
  status: 'in_progress',
  sut_version: 'v2026.11.2',
  baseline: { content_hash: 'c677435cf1d2' },
  orchestration: { plan: { execution_branches: ['execution', 'api_execution'], execution_platform: 'web' } },
};

async function withManifest(fn) {
  const root = mkdtempSync(resolve(tmpdir(), 'qa-run-reg-'));
  const manifestPath = resolve(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(MANIFEST));
  try { return await fn({ manifestPath, cleanup: () => rmSync(root, { recursive: true, force: true }) }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

/** 本机 HTTP 捕获服务：记录 method/path/authorization/body，按 status 返回；随测试结束关闭。 */
function withCapture(status, body, fn) {
  return new Promise((resolveTest, rejectTest) => {
    const seen = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        seen.push({ path: request.url, authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : null });
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    server.on('error', rejectTest);
    server.listen(0, '127.0.0.1', () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      Promise.resolve(fn({ seen, baseUrl }))
        .then(resolveTest, rejectTest)
        .finally(() => server.close());
    });
  });
}

test('manifestFacts 与服务端 readRunFacts 同口径：api 分支优先、基线取 content_hash', () => withManifest(({ manifestPath }) => {
  const facts = manifestFacts(manifestPath);
  assert.deepEqual(facts, {
    runId: RUN_ID,
    manifestVersion: 3,
    status: 'in_progress',
    resourcePool: 'api',
    sutVersion: 'v2026.11.2',
    baselineHash: 'c677435cf1d2',
  });
}));

test('registrationContext 从会话目录上下文取 projectId/sessionId', () => {
  assert.deepEqual(registrationContext({ project_id: 'acct-x-sauc', session_id: 'session-2026-11-21-10-00-00-abcdef' }),
    { projectId: 'acct-x-sauc', sessionId: 'session-2026-11-21-10-00-00-abcdef' });
  assert.deepEqual(registrationContext({ session_id: 'session-2026-11-21-10-00-00-abcdef' }),
    { projectId: null, sessionId: 'session-2026-11-21-10-00-00-abcdef' });
});

test('startRun 携带 Bearer api-token POST 到 runs 端点', async () => {
  await withCapture(201, { run: { runId: RUN_ID, status: 'running' } }, async ({ seen, baseUrl }) => {
    const result = await startRun(
      { projectId: 'p1', sessionId: 'session-2026-11-21-10-00-00-abcdef', runId: RUN_ID, kind: 'execution', dispatch: { entry: 'run-ui-tests' } },
      { baseUrl, token: 'a'.repeat(40) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.run.status, 'running');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/api/projects/p1/qa/task-records/session-2026-11-21-10-00-00-abcdef/runs');
    assert.equal(seen[0].authorization, `Bearer ${'a'.repeat(40)}`);
    assert.equal(seen[0].body.kind, 'execution');
  });
});

test('startRun 409 run_exists → conflict=true，不视为失败', async () => {
  await withCapture(409, { error: { code: 'run_exists' } }, async ({ baseUrl }) => {
    const result = await startRun({ projectId: 'p1', sessionId: 's1', runId: RUN_ID }, { baseUrl, token: 'a'.repeat(40) });
    assert.equal(result.ok, true);
    assert.equal(result.conflict, true);
  });
});

test('finishRun 交回 manifest 事实与指纹', async () => {
  await withManifest(({ manifestPath }) => withCapture(200, { run: { runId: RUN_ID, status: 'in_progress' } }, async ({ seen, baseUrl }) => {
    const result = await finishRun(
      { projectId: 'p1', sessionId: 's1', runId: RUN_ID, manifestPath },
      { baseUrl, token: 'b'.repeat(40) },
    );
    assert.equal(result.ok, true);
    assert.equal(seen[0].path, `/api/projects/p1/qa/task-records/s1/runs/${RUN_ID}/finish`);
    assert.equal(seen[0].body.facts.runId, RUN_ID);
    assert.equal(seen[0].body.facts.resourcePool, 'api');
    assert.match(seen[0].body.manifestSha256, /^[0-9a-f]{64}$/);
    assert.match(seen[0].body.manifestPath, /manifest\.json$/);
    assert.ok(!seen[0].body.manifestPath.includes(String.fromCharCode(92)), 'manifest 路径一律正斜杠');
  }));
});

test('非法 run_id / manifest 身份不一致直接拒绝，不发请求', async () => {
  let requests = 0;
  await withCapture(500, {}, async ({ seen, baseUrl }) => {
    const bad = await startRun({ projectId: 'p1', sessionId: 's1', runId: 'not-a-run-id' }, { baseUrl, token: 'a'.repeat(40) });
    assert.equal(bad.ok, false);
    await withManifest(({ manifestPath, cleanup }) => withCapture(200, {}, async ({ }) => {
      const mismatch = await finishRun({ projectId: 'p1', sessionId: 's1', runId: 'run-other', manifestPath }, { baseUrl, token: 'a'.repeat(40) });
      assert.equal(mismatch.ok, false);
      assert.match(mismatch.error, /manifest reports/);
      cleanup();
    }));
    requests = seen.length;
    assert.equal(requests, 0, '校验失败一个请求都不发');
  });
});

 test('finish conflicts remain failures and registration requests have a bounded wait', async () => {
  await withManifest(({manifestPath}) => withCapture(409, {error:{code:'run_not_running'}}, async ({baseUrl}) => {
    const result = await finishRun({projectId:'p1',sessionId:'s1',runId:RUN_ID,manifestPath},{baseUrl,token:'a'.repeat(40)});
    assert.equal(result.ok,false);
  }));
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    throw new Error('simulated unavailable registration service');
  };
  try {
    const result = await startRun({projectId:'p1',sessionId:'s1',runId:RUN_ID},{baseUrl:'http://localhost:1',token:'a'.repeat(40)});
    assert.equal(result.ok,false);
    assert.match(result.error,/simulated unavailable/);
  } finally { globalThis.fetch = original; }
});
