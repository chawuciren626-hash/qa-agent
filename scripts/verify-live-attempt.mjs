/**
 * 端到端真实执行验证（流 D 收口）：
 * 隔离临时项目 → 真实执行计划 CLI → 真实环境预检 → 真实 Playwright 执行
 * → 产物落 execution/attempts/<invocation_id>/ → 结果批准 → 脚本归档/候选登记
 * → 人工晋升 verified → 第二次任务复用脚本（零生成）并再次真实执行。
 *
 * 用法：node scripts/verify-live-attempt.mjs
 * 该脚本只写隔离临时工作区，不修改仓库 config/ 与已有 output/。
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { renderAnalysis } from './analysis-markdown.mjs';
import { catalogPath } from './test-asset-catalog.mjs';
import { executionSnapshot } from './execution-authorization.mjs';
import { executeAttempt } from './execution-runner.mjs';
import { archiveVerifiedWebScripts, reuseWebScripts } from './web-script-library.mjs';

const root = resolve(import.meta.dirname, '..');
const run1 = `run-live-${Date.now()}`;
const run2 = `${run1}-rerun`;
const base = realpathSync(mkdtempSync(resolve(tmpdir(), 'qa-live-')));
const workspace = resolve(base, 'workspace');
const session = resolve(workspace, 'session');
const runs = resolve(session, 'output/runs');
const dataRoot = resolve(base, 'data');
const context = { version: 1, engine_root: root, workspace_root: workspace, session_root: session, session_id: 'session-2026-11-22-00-00-00-a1b2c3', project_id: 'live-verification' };
process.env.QA_DIRECTORY_CONTEXT = JSON.stringify(context);
process.env.QA_APP_DATA_ROOT = dataRoot;

const html = `<!doctype html><html><body>
<label>User <input id="username" /></label>
<label>Pass <input id="password" type="password" /></label>
<button id="login">Login</button>
<h1 id="status">idle</h1>
<script>
document.getElementById('login').onclick = () => {
  document.getElementById('status').textContent = document.getElementById('username').value === 'demo' ? 'welcome' : 'denied';
};
</script></body></html>`;

const spec = `import { test, expect } from '@playwright/test';

test('TC-LIVE-1 live login', async ({ page }) => {
  await page.goto(process.env.QA_BASE_URL!);
  await page.fill('#username', 'demo');
  await page.fill('#password', 'demo-pass');
  await page.click('#login');
  await expect(page.locator('#status')).toHaveText('welcome');
});
`;

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function seed(runId, port) {
  const dir = resolve(runs, runId);
  mkdirSync(resolve(dir, 'inputs'), { recursive: true });
  mkdirSync(resolve(dir, 'analysis'), { recursive: true });
  mkdirSync(resolve(dir, 'design'), { recursive: true });
  mkdirSync(resolve(dir, 'environment'), { recursive: true });
  const requirement = 'Live verification: clicking login with user demo shows welcome.';
  writeFileSync(resolve(dir, 'inputs/requirements.md'), `${requirement}\n`);
  const ledger = {
    version: 1, run_id: runId,
    sources: [{ id: 'SRC-LIVE', kind: 'user_requirement', path: 'inputs/requirements.md', origin: 'live verification fixture', locator: 'fixture requirement' }],
    rules: [{ id: 'RULE-LIVE', kind: 'requirement', scope: 'in_scope', status: 'confirmed', statement: requirement, citations: [{ source_id: 'SRC-LIVE', quote: requirement }] }],
  };
  writeJson(resolve(dir, 'analysis/requirement-ledger.json'), ledger);
  writeFileSync(resolve(dir, 'analysis/requirement_analysis.md'), renderAnalysis(ledger));
  writeJson(resolve(dir, 'design/test_cases.json'), [{
    case_id: 'TC-LIVE-1', title: 'live login', type: 'functional', module: 'login', priority: 'P0',
    preconditions: [], related_test_point: 'TP-LIVE', automation_feasible: true,
    steps: ['open page', 'fill demo credentials', 'click login'], expected: 'status shows welcome',
    design_contract: { basis: [{ source: 'inputs/requirements.md', rule: requirement, status: 'confirmed', rule_id: 'RULE-LIVE' }], assumptions: [], data_checks: [] },
    execution_contract: { data_isolation: 'read_only', assertion_mode: ['dynamic_ui'] },
  }]);
  writeJson(resolve(dir, 'environment/runtime.json'), {
    environment: 'live-local', base_url: `http://127.0.0.1:${port}/`,
    execution: { enabled: true, browser: 'chrome', max_workers: 1, timeout_ms: 15000 },
  });
  mkdirSync(resolve(dir, 'execution/scripts'), { recursive: true });
  writeFileSync(resolve(dir, 'execution/scripts/live-login.spec.ts'), spec);
  return dir;
}

function plan(runId) {
  const dir = resolve(runs, runId);
  const result = spawnSync(process.execPath, [
    'scripts/create-execution-plan.mjs', `--run-id=${runId}`,
    `--cases=${resolve(dir, 'design/test_cases.json')}`,
    `--environment-config=${resolve(dir, 'environment/runtime.json')}`,
    `--test-dir=${resolve(dir, 'execution/scripts')}`,
  ], { cwd: root, env: process.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`create-execution-plan failed: ${result.stderr || result.stdout}`);
}

function approve(runId, extras = []) {
  const dir = resolve(runs, runId);
  writeJson(resolve(dir, 'manifest.json'), {
    run_id: runId, directory_context: context,
    stages: { execution: { status: 'planned' } },
    confirmations: [{ id: randomUUID(), stage: 'execution', status: 'approved', resolved_at: new Date().toISOString(), execution_snapshot: executionSnapshot(root, runId), approval_source: { kind: 'native_user_message', session_id: context.session_id, timestamp: new Date().toISOString(), sha256: 'b'.repeat(64) } }, ...extras],
    orchestration: { events: [], plan: { stages: [{ id: 'execution', selected: true, confirmation: 'before', depends_on: [] }] } },
  });
}

async function main() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  try {
    // 第一次任务：真实执行
    const dir1 = seed(run1, port);
    plan(run1);
    approve(run1);
    const first = await executeAttempt(root, run1);
    const attempt1 = resolve(dir1, 'execution/attempts', first.invocation_id);
    const results1 = JSON.parse(readFileSync(resolve(attempt1, 'test_results.json'), 'utf8'));
    if (first.code !== 0 || results1.status !== 'completed' || results1.cases?.[0]?.status !== 'passed') throw new Error(`first attempt not passing: ${JSON.stringify(first)}`);

    // 结果批准 → 归档 verified 脚本并登记 candidate
    approve(run1, [{ id: randomUUID(), stage: 'execution', kind: 'result', status: 'approved', resolved_at: new Date(Date.now() + 1000).toISOString() }]);
    const archived = archiveVerifiedWebScripts(root, run1);
    if (archived.status !== 'archived') throw new Error(`archive failed: ${JSON.stringify(archived)}`);
    const catalogFile = catalogPath(root);
    const candidate = JSON.parse(readFileSync(catalogFile, 'utf8')).assets.find(asset => asset.kind === 'execution_script' && asset.data?.case_id === 'TC-LIVE-1');
    if (!candidate) throw new Error('candidate script asset was not registered');
    const promoted = spawnSync(process.execPath, ['scripts/manage-script-asset.mjs', `--promote=${candidate.id}`, '--evidence=真实 Playwright 首跑通过并核对断言'], { cwd: root, env: process.env, encoding: 'utf8' });
    if (promoted.status !== 0) throw new Error(`promotion failed: ${promoted.stderr}`);

    // 第二次任务：复用 verified 脚本（零生成）后再次真实执行
    const dir2 = seed(run2, port);
    // 复用要求脚本目录为空：把预置脚本清掉，只保留用例/环境
    rmSync(resolve(dir2, 'execution/scripts'), { recursive: true, force: true });
    plan(run2);
    const reused = reuseWebScripts(root, run2);
    if (!reused.reused.includes('TC-LIVE-1')) throw new Error(`script reuse failed: ${JSON.stringify(reused)}`);
    approve(run2);
    const second = await executeAttempt(root, run2);
    const attempt2 = resolve(dir2, 'execution/attempts', second.invocation_id);
    const results2 = JSON.parse(readFileSync(resolve(attempt2, 'test_results.json'), 'utf8'));
    if (second.code !== 0 || results2.cases?.[0]?.status !== 'passed') throw new Error(`rerun not passing: ${JSON.stringify(second)}`);

    console.log(JSON.stringify({
      status: 'passed',
      workspace: base,
      first_run: { run_id: run1, invocation_id: first.invocation_id, attempt_dir: attempt1, status: results1.status, case_status: results1.cases[0].status },
      archived: { bundle_id: archived.bundle_id, script_assets: archived.script_assets.status },
      promoted: { asset_id: candidate.id, catalog: catalogFile },
      rerun: { run_id: run2, invocation_id: second.invocation_id, attempt_dir: attempt2, reused: reused.reused, remaining: reused.remaining, status: results2.cases[0].status },
      files: ['attempt.json', 'test_results.json', 'playwright/playwright-results.json'].map(name => ({ name, exists: existsSync(resolve(attempt1, name)) })),
    }, null, 2));
  } finally {
    await new Promise(done => server.close(done));
  }
}

main().catch(error => {
  console.log(JSON.stringify({ status: 'failed', workspace: base, reason: error.message }, null, 2));
  process.exitCode = 1;
});
