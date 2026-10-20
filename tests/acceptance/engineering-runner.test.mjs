import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectEngineeringTests, engineeringEnvironment, prepareTestWorkspace } from '../../scripts/run-engineering-tests.mjs';

const root=resolve(import.meta.dirname,'../..');

test('all tests are discovered exactly once and core/browser partition the default suite',()=>{
  const all=selectEngineeringTests(root,[]),core=selectEngineeringTests(root,['--suite=core']),browser=selectEngineeringTests(root,['--suite=browser']);
  assert.deepEqual([...core.files,...browser.files].sort(),all.files);
  assert.equal(new Set(all.files).size,all.files.length);
  for(const name of ['manifest-lock','delegation-binding','engineering-runner','trace-profile']) assert.ok(all.files.includes(`tests/acceptance/${name}.test.mjs`));
  assert.deepEqual(browser.files,['tests/acceptance/browser-task.test.mjs','tests/acceptance/browser-ui-assertions.test.mjs','tests/acceptance/browser-worker-exit.test.mjs','tests/acceptance/independent-task.test.mjs']);
});

test('list is read-only and invalid selectors cannot silently reduce test coverage',()=>{
  const file='tests/acceptance/manifest-lock.test.mjs';
  assert.deepEqual(selectEngineeringTests(root,[file]).files,[file]);
  assert.equal(selectEngineeringTests(root,['--list']).list,true);
  for(const args of [['--suite=typo'],['--suite=core',file],[file,file],['../test.mjs'],['--list','--list'],['--suite=core','--suite=all'],['--ignore-failures']]) assert.throws(()=>selectEngineeringTests(root,args));
  const result=spawnSync(process.execPath,['scripts/run-engineering-tests.mjs','--list'],{cwd:root,encoding:'utf8',env:{...process.env,QA_PYTHON:'missing'}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).list,true);
});

test('missing report runtime is an explicit error, not a skipped test suite',()=>{
  assert.throws(()=>engineeringEnvironment(root,['tests/acceptance/server.test.mjs'],{...process.env,QA_PYTHON:'missing'}),/python/i);
});

test('runner propagates failure, records reports, and cleans the isolated workspace',()=>{
  const sandbox=prepareTestWorkspace(root);
  try {
    const file='tests/acceptance/synthetic-runner-probe.test.mjs';
    writeFileSync(resolve(sandbox.root,file),"import test from 'node:test';import assert from 'node:assert/strict';test('synthetic failure',()=>assert.fail('intentional runner contract failure'));\n");
    const result=spawnSync(process.execPath,['scripts/run-engineering-tests.mjs',file],{cwd:sandbox.root,env:sandbox.env,encoding:'utf8',timeout:60000});
    assert.equal(result.status,1,result.stderr);
    const summary=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(summary.status,'failed');assert.equal(summary.workspace_removed,true);
    assert.ok(readFileSync(resolve(summary.report_dir,'results.tap'),'utf8').includes('not ok'));
    assert.ok(readFileSync(resolve(summary.report_dir,'results.xml'),'utf8').includes('<failure'));
    assert.equal(existsSync(resolve(sandbox.root,'config/test-env.json')),false);
    writeFileSync(resolve(sandbox.root,file),"import test from 'node:test';test('synthetic success',()=>{});test.skip('visible skip',()=>{});\n");
    const success=spawnSync(process.execPath,['scripts/run-engineering-tests.mjs',file],{cwd:sandbox.root,env:sandbox.env,encoding:'utf8',timeout:60000});
    assert.equal(success.status,0,success.stderr);
    const passed=JSON.parse(success.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(passed.status,'passed');assert.equal(passed.workspace_removed,true);
    assert.match(readFileSync(resolve(passed.report_dir,'results.xml'),'utf8'),/<skipped/);
    const unavailable=spawnSync(process.execPath,['scripts/run-engineering-tests.mjs',file],{cwd:sandbox.root,env:{...sandbox.env,QA_PYTHON:'missing'},encoding:'utf8',timeout:30000});
    assert.equal(unavailable.status,1);
    const error=JSON.parse(unavailable.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(error.status,'error');assert.match(error.error,/python/i);
  } finally {sandbox.cleanup();}
});

test('CI runs the same entry without secrets, product jobs or ignored failures',()=>{
  const workflow=readFileSync(resolve(root,'.github/workflows/engineering-tests.yml'),'utf8');
  const pkg=JSON.parse(readFileSync(resolve(root,'package.json')));
  assert.equal(pkg.scripts.test,'node scripts/run-engineering-tests.mjs --suite=all');
  assert.match(workflow,/suite: \[core, browser\]/);
  assert.match(workflow,/npm run test:\$\{\{ matrix.suite \}\}/);
  assert.match(workflow,/contents: read/);
  assert.match(workflow,/if: always\(\)/);
  assert.doesNotMatch(workflow,/pull_request_target|secrets\.|continue-on-error|acceptance:run|penguin:agents:sync/);
});
