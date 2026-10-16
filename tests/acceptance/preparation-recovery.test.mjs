import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectPreparationSafety } from '../../scripts/preparation-recovery.mjs';
import { nativeBrowserContinuation } from '../../scripts/browser-task-resume.mjs';

const root=resolve(import.meta.dirname,'../..');
const fixture=()=>{const dir=resolve(root,'output/acceptance',randomUUID());mkdirSync(dir,{recursive:true});return {dir,dispatch:{dispatch_id:randomUUID(),mode:'prepare',at:'2026-10-16T00:00:00Z'}};};
const check=(f,rows=[])=>inspectPreparationSafety(root,f.dir,'run-test','session-test',f.dispatch,rows);
test('no output is not proof of safe recovery; reject execution evidence and unknown effects',()=>{
  for(const path of ['execution/browser-state.json','execution/browser-private.json','execution/test_results.json','execution/execution-state.json','execution/exploration.lock']) {
    const f=fixture();mkdirSync(resolve(f.dir,'execution'));writeFileSync(resolve(f.dir,path),'{}');
    assert.throws(()=>check(f),/Product execution evidence/);
  }
  const f=fixture();
  assert.equal(check(f).approval_granted,false);
  assert.throws(()=>check({...f,dispatch:{...f.dispatch,mode:'execute'}}),/preparation-only/);
  assert.throws(()=>check(f,[{payload:{type:'tool_call',name:'browser_click',tool_call_id:'1'}}]),/Unclassified tool/);
  assert.throws(()=>check(f,[{payload:{type:'tool_call',name:'exec_command',tool_call_id:'1'}}]),/terminal response/);
  assert.throws(()=>inspectPreparationSafety(root,f.dir,'run-test','session-test',f.dispatch,[],[{timestamp:f.dispatch.at,payload:{type:'tool_call',name:'browser_click'}}]),/Parent tool/);
});
test('commands require classified scripts and confirmed termination',()=>{
  for(const [script,status,terminated] of [['run-execution.mjs','completed',true],['validate-artifacts.mjs','running',false],['validate-artifacts.mjs','failed',false]]) {
    const f=fixture(),dir=resolve(f.dir,'audit/commands',randomUUID());mkdirSync(dir,{recursive:true});
    writeFileSync(resolve(dir,'command.json'),JSON.stringify({run_id:'run-test',script,status,started_at:f.dispatch.at,result:{termination_confirmed:terminated}}));
    assert.throws(()=>check(f),/product|termination/);
  }
});
test('human continuation uses latest native user reply, never harness messages or a prior yes followed by stop',()=>{
  const wait='2026-10-16T00:00:00Z';
  const reply=(text,sender)=>({type:'model_msg',timestamp:'2026-10-16T00:01:00Z',payload:{type:'text',role:'user',text,sender}});
  for(const text of ['已登录，继续','已经完成验证','已登录，不要重新登录，继续','Logged in; do not restart, continue.','Synthetic manual step completed; continue.']) assert.equal(nativeBrowserContinuation([reply(text)],wait),true);
  for(const text of ['还没完成','暂停','不要继续','not yet done','需要等一会','']) assert.equal(nativeBrowserContinuation([reply(text)],wait),false);
  assert.equal(nativeBrowserContinuation([reply('已完成','harness')],wait),false);
  assert.equal(nativeBrowserContinuation([reply('已完成'),reply('停止')],wait),false);
  assert.equal(nativeBrowserContinuation([reply('已完成')],'2026-10-16T00:02:00Z'),false);
});
