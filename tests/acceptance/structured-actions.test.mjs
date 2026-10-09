import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertChildCommands } from '../../scripts/child-command-policy.mjs';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { actionCatalog, actionCommand, executeAction, actionFailureSummary } from '../../scripts/structured-actions.mjs';
import { readControllerSession } from '../../scripts/controller-command-session.mjs';
const root=resolve(import.meta.dirname,'../..');
function fixture() {
  const id=`session-2026-10-09-00-00-00-${randomUUID().replaceAll('-','')}`;
  const agentRoot=resolve(root,'output/acceptance',`actions-${randomUUID()}`);
  const dir=resolve(agentRoot,'test_agent/traces/2026-10-09'); mkdirSync(dir,{recursive:true});
  writeFileSync(resolve(dir,`${id}_001.jsonl`),JSON.stringify({type:'session_meta',payload:{session_id:id,agent_state:resolve(agentRoot,'test_agent/agent_state'),workspace:root}}));
  const run_id=`run-actions-${randomUUID()}`;
  const execute=request=>executeAction(root,id,()=>JSON.stringify(request),{agentRoot});
  return {id,agentRoot,run_id,execute};
}
test('catalog and adapters remove shell and dual run-id construction',()=>{
  assert.ok(actionCatalog().actions.archive_input);
  assert.deepEqual(actionCommand({action:'plan_run',run_id:'run-a',stages:['analysis']},'parent'),{script:'plan-run.mjs',args:['--run-id=run-a','--stages=analysis']});
  assert.throws(()=>actionCommand({action:'plan_run',run_id:'run-a',stages:'analysis'},'parent'));
  assert.throws(()=>actionCommand({action:'create_run',run_id:'run-a',cmd:'echo unsafe'},'parent'));
});
test('create, archive, plan and status work without shell and preserve literal input',async()=>{
  const f=fixture();
  assert.equal((await f.execute({action:'create_run',run_id:f.run_id})).exit_code,0);
  assert.equal((await f.execute({action:'archive_input',run_id:f.run_id,name:'fixture.txt',text:'Synthetic 中文; $(literal)'})).exit_code,0);
  assert.equal(readFileSync(resolve(root,'output/runs',f.run_id,'inputs/fixture.txt'),'utf8'),'Synthetic 中文; $(literal)');
  assert.equal((await f.execute({action:'plan_run',run_id:f.run_id,stages:['analysis']})).exit_code,0);
  const status=await f.execute({action:'run_status',run_id:f.run_id});
  assert.equal(status.data.stages[0].status,'planned');
});
test('malformed request latches failure and later corrected action is auditable but denied',async()=>{
  const f=fixture();
  const bad=await executeAction(root,f.id,()=>'{broken',{agentRoot:f.agentRoot});
  assert.equal(bad.classification,'input_rejected');
  const before=readControllerSession(root,f.id).sha256;
  const denied=await f.execute({action:'create_run',run_id:f.run_id});
  assert.equal(denied.classification,'session_stopped');
  assert.equal(readControllerSession(root,f.id).sha256,before);
  const summary=actionFailureSummary(root,f.id);
  assert.equal(summary.blocked_after_stop,1); assert.equal(summary.action_attempts,2);
  assert.match(summary.user_summary,/不能据此声称从未重试/);
});
test('archive never overwrites and blocks traversal and out-of-scope sources',async()=>{
  for (const extra of [{name:'../escape.txt',text:'test'},{name:'secret.txt',source:'README.md'},{name:'both.txt',text:'test',source:'acceptance/requirements.md'}]) {
    const f=fixture(); await f.execute({action:'create_run',run_id:f.run_id});
    assert.equal((await f.execute({action:'archive_input',run_id:f.run_id,...extra})).exit_code,2);
  }
  const f=fixture(); await f.execute({action:'create_run',run_id:f.run_id});
  await f.execute({action:'archive_input',run_id:f.run_id,name:'old.txt',text:'original'});
  assert.equal((await f.execute({action:'archive_input',run_id:f.run_id,name:'old.txt',text:'replace'})).exit_code,2);
  assert.equal(readFileSync(resolve(root,'output/runs',f.run_id,'inputs/old.txt'),'utf8'),'original');
});
test('script refusal is distinct from session refusal; status diagnostics do not unlock',async()=>{
  const f=fixture(); await f.execute({action:'create_run',run_id:f.run_id});
  await f.execute({action:'plan_run',run_id:f.run_id,stages:['analysis']});
  const duplicate=await f.execute({action:'plan_run',run_id:f.run_id,stages:['analysis']});
  assert.notEqual(duplicate.exit_code,0);
  const state=readControllerSession(root,f.id);
  assert.equal((await f.execute({action:'run_status',run_id:f.run_id})).exit_code,0);
  assert.equal(readControllerSession(root,f.id).sha256,state.sha256);
  assert.equal(actionFailureSummary(root,f.id).failures[0].classification,'script_failure');
});
test('unplanned terminal event cannot create fake stage and archive source bytes match',async()=>{
  const f=fixture(); await f.execute({action:'create_run',run_id:f.run_id});
  const copied=await f.execute({action:'archive_input',run_id:f.run_id,name:'requirements.md',source:'acceptance/requirements.md'});
  assert.equal(copied.exit_code,0);
  assert.deepEqual(readFileSync(resolve(root,'output/runs',f.run_id,'inputs/requirements.md')),readFileSync(resolve(root,'acceptance/requirements.md')));
  const before=readFileSync(resolve(root,'output/runs',f.run_id,'manifest.json'),'utf8');
  const rejected=await f.execute({action:'block',run_id:f.run_id,stage:'analysis',dispatch_id:'synthetic',reason:'Synthetic refusal test'});
  assert.notEqual(rejected.exit_code,0);
  assert.equal(readFileSync(resolve(root,'output/runs',f.run_id,'manifest.json'),'utf8'),before);
});
test('CLI accepts request files and child evidence checks include the new entry',()=>{
  const f=fixture(); const request=resolve(f.agentRoot,'request.json');
  writeFileSync(request,JSON.stringify({action:'create_run',run_id:f.run_id}));
  const result=spawnSync(process.execPath,['scripts/project-action.mjs','execute',`--controller-session=${f.id}`,`--request=${request}`],{cwd:root,encoding:'utf8',env:{...process.env,PENGUIN_AGENT_ROOT:f.agentRoot}});
  assert.equal(result.status,0,result.stdout); assert.equal(JSON.parse(result.stdout).data.run_id,f.run_id);
  const rows=output=>[{payload:{type:'tool_call',name:'exec_command',tool_call_id:'one',arguments:{cmd:'node scripts/project-action.mjs execute'}}},{payload:{type:'tool_call_output',tool_call_id:'one',output:JSON.stringify(output)}}];
  assert.doesNotThrow(()=>assertChildCommands(rows(JSON.parse(result.stdout))));
  assert.throws(()=>assertChildCommands(rows({status:'rejected',exit_code:2,classification:'session_stopped'})));
  assert.doesNotThrow(()=>assertChildCommands(rows({status:'completed',exit_code:0,execution_mode:'in_process',launches_child:false,action_receipt:'synthetic-only'})));
});
