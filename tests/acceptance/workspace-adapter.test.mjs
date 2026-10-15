import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { applies, bindWorkspace, bindChildHookContext, contextForWorkspace, workspaceEnv } from '../../scripts/penguin-workspace-adapter.mjs';
import { patchServer } from '../../scripts/install-penguin-workspace-adapter.mjs';
const state={projectId:'default_project',agentId:'test_agent'};
const appData=mkdtempSync(resolve(tmpdir(),'qa-app-data-test-'));
const previousAppData=process.env.QA_APP_DATA_ROOT;
process.env.QA_APP_DATA_ROOT=appData;
after(()=>{if(previousAppData===undefined) delete process.env.QA_APP_DATA_ROOT;else process.env.QA_APP_DATA_ROOT=previousAppData;rmSync(appData,{recursive:true,force:true});});
const id=()=>`session-2026-10-10-00-00-00-${randomUUID().replaceAll('-','')}`;

test('selected workspace creates unique timestamp directory, persists binding and shares engine shims',t=>{
  const selected=mkdtempSync(resolve(tmpdir(),'qa-selected-'));const session=id();
  t.after(()=>rmSync(selected,{recursive:true,force:true}));
  const dir=bindWorkspace(state,{workspaceDir:selected},session,selected);
  assert.equal(dir,resolve(selected,session.slice(8)));
  const context=contextForWorkspace(dir,session);
  assert.ok(existsSync(resolve(appData,'session-workspaces',session+'.json')));
  assert.equal(existsSync(resolve(import.meta.dirname,'../../output/session-workspaces',session+'.json')),false);
  assert.equal(context.workspace_root,selected);assert.equal(context.session_id,session);
  assert.deepEqual(contextForWorkspace(dir,session),context);
  assert.throws(()=>contextForWorkspace(dir,id()),/another session/);
  assert.deepEqual(contextForWorkspace(dir,id(),'subagent'),context);
  assert.equal(bindWorkspace(state,{source:'subagent',workspaceDir:dir},id(),dir),dir);
  assert.throws(()=>bindWorkspace(state,{workspaceDir:selected},session,selected),/already exists/);
  const cli=spawnSync(process.execPath,['scripts/project-action.mjs','catalog'],{cwd:dir,env:{...process.env,...workspaceEnv(dir,session)},encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.ok(JSON.parse(cli.stdout).actions.handoff);
  assert.equal(existsSync(resolve(dir,'node_modules')),false);
});
test('unselected workspace uses configured default while other agents and legacy workspaces remain untouched',t=>{
  const session=id();const dir=bindWorkspace(state,{},session);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const c=contextForWorkspace(dir,session);
  const config=JSON.parse(readFileSync(new URL('../../config/session-workspaces.json',import.meta.url)));
  assert.equal(c.workspace_root,resolve(config.default_workspace));
  assert.equal(applies({...state,agentId:'other_agent'},{}),false);
  assert.equal(bindWorkspace({...state,agentId:'other_agent'},{},id(),'unchanged'),'unchanged');
  const legacy=mkdtempSync(resolve(tmpdir(),'qa-legacy-'));
  t.after(()=>rmSync(legacy,{recursive:true,force:true}));
  assert.equal(contextForWorkspace(legacy,session),null);assert.deepEqual(workspaceEnv(legacy,session),{});
});
test('child hook derives the parent workspace context from verified subagent trace identity',t=>{
  const selected=mkdtempSync(resolve(tmpdir(),'qa-child-hook-workspace-'));const parent=id();const workspace=bindWorkspace(state,{workspaceDir:selected},parent,selected);
  const child=id(),agent='automation_execution_agent',agentRoot=resolve(selected,'agents');
  const trace=resolve(agentRoot,agent,'traces',child.slice(8,18));mkdirSync(trace,{recursive:true});mkdirSync(resolve(agentRoot,agent,'agent_state'),{recursive:true});
  writeFileSync(resolve(trace,`${child}_001.jsonl`),JSON.stringify({type:'session_meta',payload:{session_id:child,source:'subagent',workspace,agent_state:resolve(agentRoot,agent,'agent_state')}}));
  const prior=process.env.QA_DIRECTORY_CONTEXT;t.after(()=>{if(prior===undefined) delete process.env.QA_DIRECTORY_CONTEXT;else process.env.QA_DIRECTORY_CONTEXT=prior;rmSync(selected,{recursive:true,force:true});});
  const context=bindChildHookContext(child,agent,agentRoot);
  assert.equal(context.session_root,workspace);assert.equal(context.session_id,parent);
  assert.throws(()=>bindChildHookContext(child,'test_case_agent',agentRoot));
});
test('runtime patch refuses unknown or already patched code',()=>{
  assert.throws(()=>patchServer('different runtime','file:///adapter.mjs'),/not unique/);
  assert.throws(()=>patchServer('qaWorkspaceBind','file:///adapter.mjs'),/already present/);
});

test('new controller sessions cannot write into engine or its subdirectories',()=>{
  const engine=resolve(import.meta.dirname,'../..');
  for(const workspace of [engine,resolve(engine,'inputs'),resolve(engine,'new-business-workspace')]) {
    const session=id();
    assert.throws(()=>bindWorkspace(state,{workspaceDir:workspace},session),/engine directory/);
    assert.equal(existsSync(resolve(workspace,session.slice(8))),false);
    assert.equal(existsSync(resolve(appData,'session-workspaces',session+'.json')),false);
  }
});
