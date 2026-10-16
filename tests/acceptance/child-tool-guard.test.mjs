import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { guardChildTool } from '../../scripts/child-tool-guard.mjs';
import { assertChildCommands } from '../../scripts/child-command-policy.mjs';

test('shell detours are redirected before execution; only native recorded redirect is recoverable',()=>{
  const f=fixture(), options={agentId:'test_case_agent',agentRoot:f.agentRoot};
  for(const cmd of ['node -e "console.log(51)"','powershell -Command "$s=123; Write-Host $s.Length"','echo $env:PATH; dir /s /b schemas/test_case.schema.json','Get-Content "E:/engine/schemas/test_case.schema.json"','curl https://example.test','node scripts/generate-test-cases-xlsx.mjs run-a']) {
    const denied=guardChildTool(f.root,{tool_name:'exec_command',arguments:{cmd}},options);
    assert.equal(denied.decision,'deny');assert.match(denied.reason,/NOT executed/);
  }
  for(const cmd of ['node scripts/project-action.mjs catalog','node scripts/project-action.mjs execute --request=output/action-requests/request.json']) {
    assert.deepEqual(guardChildTool(f.root,{tool_name:'exec_command',arguments:{cmd}},options),{});
  }
  const call={payload:{type:'tool_call',name:'exec_command',tool_call_id:'redirect',arguments:{cmd:'node -e "console.log(51)"'}}};
  const decision={type:'event_msg',payload:{type:'approval_decision',tool_call_id:'redirect',decision:'deny'}};
  const output={payload:{type:'tool_call_output',tool_call_id:'redirect',stop_reason:'aborted',output:'Tool call denied by the qa-stage-boundary hook: QA shell redirect: This command was NOT executed.'}};
  const policy={allowRecovery:true,requireControlledCommands:true};
  assert.doesNotThrow(()=>assertChildCommands([call,decision,output],policy));
  assert.throws(()=>assertChildCommands([call,output],policy));
  assert.throws(()=>assertChildCommands([call,{...decision,payload:{...decision.payload,decision:'allow'}},output],policy));
  assert.throws(()=>assertChildCommands([call,decision,{payload:{...output.payload,output:'Tool call denied by user.'}}],policy));
  assert.throws(()=>assertChildCommands([call,decision,{payload:{...output.payload,stop_reason:'completed'}}],policy));
  assert.throws(()=>assertChildCommands([call,decision,output],{...policy,allowRecovery:false}));
});

function fixture() {
  const root=mkdtempSync(resolve(tmpdir(),'qa-child-guard-'));
  const agentRoot=resolve(root,'agents');
  const session_id='session-2026-10-14-16-00-00-abcd';
  mkdirSync(resolve(root,'output/action-requests'),{recursive:true});
  mkdirSync(resolve(root,'output/runs/run-a'),{recursive:true});
  mkdirSync(resolve(agentRoot,'automation_execution_agent/scratchpad',session_id),{recursive:true});
  for(const agent of ['automation_execution_agent','test_point_agent','test_case_agent','test_report_agent']) {
    const trace=resolve(agentRoot,agent,'traces/2026-10-14');mkdirSync(trace,{recursive:true});
    writeFileSync(resolve(trace,`${session_id}_001.jsonl`),JSON.stringify({payload:{type:'text',role:'user',text:'run_id=run-a stage dispatch'}}));
  }
  const input=(tool_name,file_path,extra={})=>({tool_name,session_id,arguments:{file_path,...extra}});
  return {root,agentRoot,session_id,input};
}

test('professional write guard permits only action requests, own stage and own scratchpad',()=>{
  const f=fixture();
  const options={agentId:'automation_execution_agent',agentRoot:f.agentRoot};
  for(const path of [
    'output/action-requests/explore.json',
    'output/runs/run-a/execution/execution-task.json',
    'output/runs/run-a/execution/evidence/page.png',
    'output/runs/run-a/environment/test-env.json',
    resolve(f.agentRoot,'automation_execution_agent/scratchpad',f.session_id,'PLAN.md')
  ]) assert.deepEqual(guardChildTool(f.root,f.input('write_file',path,{content:'x'}),options),{});
  for(const path of [
    'output/runs/run-a/generate-artifacts.py',
    'output/runs/run-a/design/test_cases.json',
    'output/runs/run-a/report/test_report.md',
    'output/runs/run-b/execution/execution-task.json'
  ]) assert.equal(guardChildTool(f.root,f.input('write_file',path,{content:'x'}),options).decision,'deny');
});

test('shared design folder remains split between test point and test case roles',()=>{
  const f=fixture();
  const point={agentId:'test_point_agent',agentRoot:f.agentRoot};
  const cases={agentId:'test_case_agent',agentRoot:f.agentRoot};
  assert.deepEqual(guardChildTool(f.root,f.input('write_file','output/runs/run-a/design/test_points.json',{content:'[]'}),point),{});
  assert.deepEqual(guardChildTool(f.root,f.input('write_file','output/runs/run-a/design/test_points.md',{content:'# points'}),point),{});
  assert.deepEqual(guardChildTool(f.root,f.input('write_file','output/runs/run-a/design/test_cases.md',{content:'# cases'}),cases),{});
  assert.equal(guardChildTool(f.root,f.input('write_file','output/runs/run-a/design/test_cases.md',{content:'# cases'}),point).decision,'deny');
  assert.equal(guardChildTool(f.root,f.input('write_file','output/runs/run-a/design/test_cases.json',{content:'[]'}),point).decision,'deny');
  assert.deepEqual(guardChildTool(f.root,f.input('edit_file','output/runs/run-a/design/test_cases.json',{old_string:'a',new_string:'b'}),cases),{});
  assert.equal(guardChildTool(f.root,f.input('edit_file','output/runs/run-a/design/test_points.json',{old_string:'a',new_string:'b'}),cases).decision,'deny');
});

test('execution agents cannot rewrite or rename controlled browser evidence',()=>{
  const f=fixture(), options={agentId:'automation_execution_agent',agentRoot:f.agentRoot};
  for(const path of ['execution/test_results.json','execution/Test_Results.JSON','execution/exploration.json','execution/browser-state.json','execution/browser-private.json','execution/browser-evidence/a.json','execution/browser-network.json','execution/browser-data-ledger.json']) {
    for(const tool of ['write_file','edit_file']) {
      const denied=guardChildTool(f.root,f.input(tool,`output/runs/run-a/${path}`,{content:'x',old_string:'a',new_string:'b'}),options);
      assert.equal(denied.decision,'deny');assert.match(denied.reason,/read-only/);
    }
  }
  const patch='*** Begin Patch\n*** Update File: output/runs/run-a/execution/draft.json\n*** Move to: output/runs/run-a/execution/test_results.json\n@@\n-old\n+new\n*** End Patch';
  assert.equal(guardChildTool(f.root,{tool_name:'apply_patch',session_id:f.session_id,arguments:{patch}},options).decision,'deny');
  assert.deepEqual(guardChildTool(f.root,f.input('write_file','output/runs/run-a/execution/scripts/login.spec.mjs',{content:'x'}),options),{});
});

test('patch targets are checked independently and cannot mix stages',()=>{
  const f=fixture();
  const options={agentId:'test_report_agent',agentRoot:f.agentRoot};
  const allowed='*** Begin Patch\n*** Add File: output/runs/run-a/report/test_report.md\n+# report\n*** End Patch';
  const mixed='*** Begin Patch\n*** Add File: output/runs/run-a/report/test_report.md\n+# report\n*** Add File: output/runs/run-a/design/test_cases.json\n+[]\n*** End Patch';
  assert.deepEqual(guardChildTool(f.root,{tool_name:'apply_patch',session_id:f.session_id,arguments:{patch:allowed}},options),{});
  assert.equal(guardChildTool(f.root,{tool_name:'apply_patch',session_id:f.session_id,arguments:{patch:mixed}},options).decision,'deny');
});
