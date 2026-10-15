import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applicationDataRoot } from '../../scripts/application-data.mjs';
import { planIndexRelocation, applyIndexRelocation } from '../../scripts/relocate-workspace-index.mjs';
import { patchServer, relocatedPatch } from '../../scripts/install-penguin-workspace-adapter.mjs';

test('application data rejects relative, empty and engine-overlapping roots',()=>{
  const engine=resolve(tmpdir(),'qa-engine');
  for(const path of ['', 'relative', engine, resolve(engine,'data'),resolve(tmpdir())]) assert.throws(()=>applicationDataRoot(engine,{QA_APP_DATA_ROOT:path}));
  assert.equal(applicationDataRoot(engine,{LOCALAPPDATA:resolve(tmpdir(),'local')}),resolve(tmpdir(),'local/AITestWorker'));
});

test('relocation repairs empty bindings, preserves old index, is repeatable and refuses modified shims',t=>{
  const base=mkdtempSync(resolve(tmpdir(),'qa-relocate-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const engine=resolve(base,'new'),old=resolve(base,'old'),app=resolve(base,'app');
  const env={QA_APP_DATA_ROOT:app};
  const id='session-2026-10-12-00-00-00-abcdef12';
  const session=resolve(engine,id.slice(8));
  const context={version:1,mode:'isolated',engine_root:old,workspace_root:old,session_root:resolve(old,id.slice(8)),session_id:id,output_root:resolve(old,id.slice(8),'output'),run_root:resolve(old,id.slice(8),'output/runs')};
  mkdirSync(resolve(session,'scripts'),{recursive:true});mkdirSync(resolve(session,'output/runs'),{recursive:true});mkdirSync(resolve(engine,'output/session-workspaces'),{recursive:true});
  const index=resolve(engine,'output/session-workspaces',id+'.json');
  writeFileSync(index,JSON.stringify(context));writeFileSync(resolve(session,'.qa-session.json'),JSON.stringify(context));
  for(const file of ['project-action.mjs','project-command.mjs']) writeFileSync(resolve(session,'scripts',file),`import ${JSON.stringify(pathToFileURL(resolve(old,'scripts',file)).href)};\n`);
  const plan=planIndexRelocation(engine,old,env);assert.equal(plan.plans.length,1);assert.equal(plan.plans[0].native_workspace_rebind_required,true);
  const result=applyIndexRelocation(engine,plan,env);assert.equal(result.status,'completed');assert.ok(existsSync(result.journal));
  assert.equal(JSON.parse(readFileSync(index)).engine_root,old);
  assert.equal(JSON.parse(readFileSync(resolve(app,'session-workspaces',id+'.json'))).engine_root,engine);
  assert.equal(applyIndexRelocation(engine,planIndexRelocation(engine,old,env),env).status,'completed');
  writeFileSync(resolve(session,'scripts/project-action.mjs'),'custom');
  assert.throws(()=>planIndexRelocation(engine,old,env),/modified/);
  writeFileSync(resolve(session,'output/runs','business.json'),'{}');
  const deferred=planIndexRelocation(engine,old,env);assert.equal(deferred.plans.length,0);assert.equal(deferred.deferred[0].reason,'business_run_requires_archive_migration');
});

test('installer relocation permits only the exact known patch recipe',()=>{
  const original='    let workspaceDir2;\n    if (opts.workspaceDir) {\n    const sessionId = formatSessionId();\n    const spec = {\n        controlEnv: () => this.controlEnv({\n          projectId: this.state.projectId,\n          agentId: this.state.agentId,\n          sessionId\n        })\n      } : {},';
  const current=patchServer(original,'file:///old/adapter.mjs');
  const result=relocatedPatch(current,original,'file:///new/adapter.mjs');
  assert.equal(result.next,patchServer(original,'file:///new/adapter.mjs'));
  assert.equal(result.previous,'file:///old/adapter.mjs');
  assert.throws(()=>relocatedPatch(current+'modified',original,'file:///new/adapter.mjs'),/recipe differs/);
});
