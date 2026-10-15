import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cleanupPlan } from '../../scripts/plan-archive-cleanup.mjs';
import { releaseResources } from '../../scripts/check-release-resources.mjs';
import { prepareTestWorkspace } from '../../scripts/run-engineering-tests.mjs';

test('cleanup only proposes backed-up unchanged test files and keeps tracked/history/changed data',t=>{
  const base=realpathSync(mkdtempSync(resolve(tmpdir(),'qa-cleanup-')));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const root=resolve(base,'engine'),archive=resolve(base,'archive');
  const paths=['inputs/word-fixture-abc.docx','inputs/word-fixture-def.docx','inputs/requirements.md','output/runs/business/result.json'];
  const files=paths.map(path=>({path,size:4,sha256:createHash('sha256').update('data').digest('hex')}));
  for(const file of files) for(const parent of [root,resolve(archive,'data')]) {const path=resolve(parent,file.path);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,'data');}
  const manifest={status:'verified',source_root:root,archive_root:archive,files,links:[]};
  writeFileSync(resolve(archive,'manifest.json'),JSON.stringify(manifest));
  writeFileSync(resolve(root,paths[1]),'changed');
  const result=cleanupPlan(root,archive,new Set([paths[2]]));
  assert.equal(result.mode,'review_only_no_delete');
  assert.deepEqual(result.files.map(f=>f.decision),['review_candidate','retain_changed_or_unverified','retain_tracked_source','retain_history_or_runtime_state']);
  assert.equal(readFileSync(resolve(root,paths[0]),'utf8'),'data');
  manifest.files[0].path='../escape';writeFileSync(resolve(archive,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>cleanupPlan(root,archive,new Set()),/Invalid archived path/);
});

test('release allowlist refuses local configuration, runtime data, and traversal',t=>{
  const root=realpathSync(mkdtempSync(resolve(tmpdir(),'qa-release-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(resolve(root,'scripts'));writeFileSync(resolve(root,'scripts/project-action.mjs'),'// fixture');
  assert.equal(releaseResources(root,{version:1,files:['scripts/project-action.mjs']}).exe_ready,false);
  for(const file of ['output/report.md','inputs/requirement.md','config/test-env.json','config/test-assets.json','scripts/../secret','scripts/tmp-stats.mjs']) assert.throws(()=>releaseResources(root,{version:1,files:[file]}));
});

test('engineering workspace isolates generated inputs, configuration and dependencies without reinstalling',()=>{
  const engine=resolve(import.meta.dirname,'../..');
  const sandbox=prepareTestWorkspace(engine);
  try {
    assert.equal(existsSync(resolve(sandbox.root,'config/test-env.json')),false);
    assert.equal(realpathSync(resolve(sandbox.root,'node_modules')),realpathSync(resolve(engine,'node_modules')));
    assert.ok(sandbox.env.QA_APP_DATA_ROOT.startsWith(sandbox.base));
    const file='inputs/isolation-proof.txt';writeFileSync(resolve(sandbox.root,file),'synthetic');
    assert.equal(existsSync(resolve(engine,file)),false);
    assert.equal(JSON.parse(readFileSync(resolve(sandbox.root,'config/session-workspaces.json'))).default_workspace,resolve(sandbox.base,'workspaces'));
  } finally {sandbox.cleanup();}
  assert.equal(existsSync(sandbox.base),false);
  assert.ok(existsSync(resolve(engine,'node_modules')));
});
