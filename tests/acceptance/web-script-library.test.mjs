import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { beginAttempt, finishAttempt } from '../../scripts/execution-attempts.mjs';
import { archiveVerifiedWebScripts, reuseWebScripts } from '../../scripts/web-script-library.mjs';

const root = resolve(import.meta.dirname, '../..');
const save = (path, value) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };

test('approved sealed Web scripts are archived and matching later cases reuse an immutable copy', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'qa-script-library-'));
  const old = { context: process.env.QA_DIRECTORY_CONTEXT, data: process.env.QA_APP_DATA_ROOT };
  const session = resolve(temp, 'workspace', 'session');
  mkdirSync(session, { recursive: true });
  process.env.QA_DIRECTORY_CONTEXT = JSON.stringify({ version: 1, engine_root: root, workspace_root: resolve(temp, 'workspace'), session_root: session, session_id: 'session-2026-11-04-00-00-00-abcdef', project_id: 'project-a' });
  process.env.QA_APP_DATA_ROOT = resolve(temp, 'qa');
  const caseRow = { case_id: 'TC-A', title: 'A', automation_feasible: true, steps: ['open'], expected: 'visible' };
  const makeRun = (id, row = caseRow, script = false) => {
    const dir = resolve(session, 'output/runs', id);
    save(resolve(dir, 'manifest.json'), { run_id: id, directory_context: JSON.parse(process.env.QA_DIRECTORY_CONTEXT), confirmations: script ? [{ stage: 'execution', kind: 'result', status: 'approved', resolved_at: new Date(Date.now() + 10000).toISOString() }] : [] });
    save(resolve(dir, 'design/test_cases.json'), [row]);
    save(resolve(dir, 'environment/test-env.json'), { base_url: 'https://qa.example.test' });
    save(resolve(dir, 'execution/execution-plan.json'), { run_id: id, source: resolve(dir, 'design/test_cases.json'), environment_config: resolve(dir, 'environment/test-env.json'), cases: [{ case_id: row.case_id, title: row.title }], execution_policy: { test_dir: resolve(dir, 'execution/scripts') } });
    mkdirSync(resolve(dir, 'execution/scripts'), { recursive: true });
    if (script) {
      const spec = resolve(dir, 'execution/scripts/a.spec.ts');
      save(spec, "test('TC-A checks page', async () => {});\n");
      const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json')));
      manifest.confirmations.unshift({ stage: 'execution', kind: 'authorization', status: 'approved', execution_snapshot: { files: [{ path: spec.replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(spec)).digest('hex') }] } });
      save(resolve(dir, 'manifest.json'), manifest);
    }
    return dir;
  };
  try {
    const first = makeRun('run-first', caseRow, true);
    const attempt = beginAttempt(root, 'run-first');
    finishAttempt(attempt, { status: 'completed', result: { run_id: 'run-first', invocation_id: attempt.invocationId, status: 'completed', finished_at: new Date().toISOString(), cases: [{ case_id: 'TC-A', status: 'passed', flaky: false }] } });
    const archived = archiveVerifiedWebScripts(root, 'run-first');
    assert.equal(archived.status, 'archived');
    assert.equal(archiveVerifiedWebScripts(root, 'run-first').status, 'already_archived');
    const second = makeRun('run-second');
    const reused = reuseWebScripts(root, 'run-second');
    assert.deepEqual(reused.reused, ['TC-A']);
    assert.deepEqual(reused.remaining, []);
    assert.match(readFileSync(resolve(second, 'execution/scripts/a.spec.ts'), 'utf8'), /TC-A/);
    assert.equal(JSON.parse(readFileSync(resolve(second, 'execution/execution-plan.json'))).script_reuse[0].source_run_id, 'run-first');
    const changed = makeRun('run-changed', { ...caseRow, expected: 'different' });
    assert.deepEqual(reuseWebScripts(root, 'run-changed').remaining, ['TC-A']);
    save(resolve(changed, 'execution/scripts/draft.spec.ts'), 'existing draft');
    assert.equal(reuseWebScripts(root, 'run-changed').status, 'existing_drafts');
    assert.equal(readFileSync(resolve(first, 'execution/scripts/a.spec.ts'), 'utf8'), "test('TC-A checks page', async () => {});\n");
  } finally {
    if (old.context === undefined) delete process.env.QA_DIRECTORY_CONTEXT; else process.env.QA_DIRECTORY_CONTEXT = old.context;
    if (old.data === undefined) delete process.env.QA_APP_DATA_ROOT; else process.env.QA_APP_DATA_ROOT = old.data;
    rmSync(temp, { recursive: true, force: true });
  }
});
