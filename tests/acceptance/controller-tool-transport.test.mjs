import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guardControllerTool } from '../../scripts/controller-tool-guard.mjs';
import { reliabilityPatches } from '../../scripts/penguin-reliability-patches.mjs';

function fixture(t) {
  const root=mkdtempSync(path.join(tmpdir(),'qa-controller-transport-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(path.join(root,'output/action-requests'),{recursive:true});
  mkdirSync(path.join(root,'output/runs/run-a/report'),{recursive:true});
  const session_id='session-2026-10-16-12-00-00-abcd';
  const cmd=`node scripts/project-action.mjs execute --controller-session=${session_id} --request=output/action-requests/test.json`;
  const check=args=>guardControllerTool(root,{tool_name:'exec_command',session_id,arguments:args});
  return {root,cmd,check,file:path.join(root,'output/action-requests/test.json')};
}

test('complete controller request is saved before execution, with no guessing or overwrite',t=>{
  const f=fixture(t),body={action:'create_run'};
  assert.equal(f.check({cmd:f.cmd}).decision,'deny');assert.equal(existsSync(f.file),false);
  assert.deepEqual(f.check({cmd:f.cmd,qa_request:body}),{});
  const bytes=readFileSync(f.file,'utf8');assert.deepEqual(JSON.parse(bytes),body);
  assert.deepEqual(f.check({cmd:f.cmd,qa_request:body}),{});
  assert.equal(f.check({cmd:f.cmd,qa_request:{action:'plan_run',run_id:'run-a'}}).decision,'deny');
  assert.equal(readFileSync(f.file,'utf8'),bytes);
  assert.equal(existsSync(path.join(f.root,'output/runs/run-a/manifest.json')),false);
});

test('rejected transport cannot create a request or grant professional authority',t=>{
  const f=fixture(t);
  for(const args of [
    {cmd:f.cmd,qa_request:{action:'browser_task',run_id:'run-a'}},
    {cmd:f.cmd,qa_request:[]},
    {cmd:f.cmd.replace('12-00-00','13-00-00'),qa_request:{action:'create_run'}},
    {cmd:f.cmd+' --unknown=x',qa_request:{action:'create_run'}},
    {cmd:f.cmd+' --request=output/action-requests/another.json',qa_request:{action:'create_run'}},
    {cmd:f.cmd.replace('output/action-requests/test.json','inputs/test.json'),qa_request:{action:'create_run'}},
    {cmd:f.cmd,workdir:'../other',qa_request:{action:'create_run'}},
    {cmd:'node scripts/project-action.mjs catalog',qa_request:{action:'create_run'}},
    {cmd:f.cmd+'; whoami',qa_request:{action:'create_run'}}
  ]) { assert.equal(f.check(args).decision,'deny',JSON.stringify(args));assert.equal(existsSync(f.file),false); }
});

test('inspection allows one literal stage directory, never recursive or executable extensions',t=>{
  const f=fixture(t),dir=path.join(f.root,'output/runs/run-a/report').replaceAll('\\','/');
  assert.deepEqual(f.check({cmd:`ls -la "${dir}/"`}),{});
  assert.deepEqual(f.check({cmd:'ls -la output/runs/run-a/report'}),{});
  for(const cmd of [`ls -la "${dir}"; whoami`,`ls -laR "${dir}"`,`ls -la "${dir}/*"`,`ls -la "${f.root.replaceAll('\\','/')}"`,`ls -la "${dir}/../.."`,`ls -la "${dir}/$(whoami)"`]) assert.equal(f.check({cmd}).decision,'deny',cmd);
  assert.equal(f.check({cmd:'ls -la output/runs/run-a/report',workdir:'../other'}).decision,'deny');
});

const replacement=reliabilityPatches.find(([before])=>before.startsWith('      const rawWorkdir'))[1];
const AsyncGeneratorFunction=Object.getPrototypeOf(async function*(){}).constructor;
const resolveHost=new AsyncGeneratorFunction('args2','ctx','cmd','path19',`const delta=output=>output; ${replacement}\n return {workdir};`);
async function host(root,cmd,args={}) {return await resolveHost(args,{workspaceDir:root},cmd,path).next();}

test('host resolves only missing QA CWD placeholders and preserves actual paths',async t=>{
  const f=fixture(t),cmd='node scripts/project-action.mjs catalog';
  assert.equal((await host(f.root,cmd,{workdir:'CWD'})).value.workdir,path.join(f.root,'CWD'));
  writeFileSync(path.join(f.root,'.qa-session.json'),'{}');
  assert.equal((await host(f.root,cmd,{workdir:'CWD'})).value.workdir,f.root);
  assert.equal((await host(f.root,'node other.mjs',{workdir:'CWD'})).value.workdir,path.join(f.root,'CWD'));
  mkdirSync(path.join(f.root,'CWD'));
  assert.equal((await host(f.root,cmd,{workdir:'CWD'})).value.workdir,path.join(f.root,'CWD'));
  assert.equal(f.check({cmd,workdir:'CWD'}).decision,'deny');
});

test('host fails closed without prepared exact body, even if the hook is disabled',async t=>{
  const f=fixture(t),qa_request={action:'create_run'};
  assert.match((await host(f.root,f.cmd,{qa_request})).value,/no command was launched/);
  assert.deepEqual(f.check({cmd:f.cmd,qa_request}),{});
  assert.deepEqual((await host(f.root,f.cmd,{qa_request})).value,{workdir:f.root});
  assert.match((await host(f.root,f.cmd,{qa_request:{action:'plan_run'}})).value,/no command was launched/);
  assert.match((await host(f.root,'echo ignored',{qa_request})).value,/no command was launched/);
});
