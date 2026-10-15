import test from 'node:test';
import assert from 'node:assert/strict';
import { reliabilityPatches, patchReliabilityServer } from '../../scripts/penguin-reliability-patches.mjs';
import { recordCorrection, stageRevisionBudget } from '../../scripts/recovery-policy.mjs';
import { assertChildCommands } from '../../scripts/child-command-policy.mjs';

const replacement = prefix => reliabilityPatches.find(([before])=>before.startsWith(prefix))[1];
const method = prefix => new Function(`return ({${replacement(prefix)}})`)();

test('child sessions load only the installed QA pre-tool boundary and respect hooks disabled',async()=>{
  const construct=new Function('loadAgentState','listInstalledHooks','scriptPreToolUseHook',`return ({
    ${replacement('  async sessionHooks')}
      const { systemConfig } = await loadAgentState({root:root8,projectId,agentId});
      if(systemConfig.hooks?.enabled===false) return void 0;
      ${replacement('    const installed2 = await listInstalledHooks')}
      return {topLevel:true};
    }
  });`);
  const hook={name:'qa-stage-boundary',dir:'owned',pre_tool_use:[{command:'guard.mjs',timeout:10}],stop:['not-for-children'],user_prompt:['not-for-children']};
  let enabled=true,installed=[hook,{...hook,name:'other-hook'}],calls=[];
  const agent=construct(async()=>({systemConfig:{hooks:{enabled}}}),async()=>installed,(...args)=>{calls.push(args);return 'qa-pre-tool';});
  agent.state={root:'root',projectId:'project',agentId:'professional'};agent.pathPrepend='host-path';
  assert.deepEqual(await agent.sessionHooks(null,true),{preToolUse:['qa-pre-tool']});
  assert.deepEqual(calls,[['qa-stage-boundary','owned','guard.mjs',10,'host-path']]);
  assert.deepEqual(await agent.sessionHooks(null,false),{topLevel:true});
  enabled=false;assert.equal(await agent.sessionHooks(null,true),undefined);
  enabled=true;installed=[{...hook,name:'other-hook'}];assert.equal(await agent.sessionHooks(null,true),undefined);
});

test('literal boundary counts are accepted only with exact successful output and no executable extensions',()=>{
  const cmd=`node -e "const sample = 'abc123'; console.log(sample.length); console.log(sample);"`;
  const rows=(command,output='6\nabc123\n',stop_reason='completed')=>[
    {payload:{type:'tool_call',name:'exec_command',tool_call_id:'count',arguments:{cmd:command}}},
    {payload:{type:'tool_call_output',tool_call_id:'count',stop_reason,output}}
  ];
  const options={allowRecovery:true,requireControlledCommands:true};
  assert.doesNotThrow(()=>assertChildCommands(rows(cmd),options));
  assert.throws(()=>assertChildCommands(rows(cmd),{...options,allowRecovery:false}));
  assert.throws(()=>assertChildCommands(rows(cmd,'7\nabc123\n'),options));
  assert.throws(()=>assertChildCommands(rows(cmd,'6\nabc123\n','fatal'),options));
  for(const changed of [cmd+'; whoami',cmd.replace('abc123','$(whoami)'),cmd.replace('abc123','%SECRET%'),cmd.replace('const sample', 'const console'),cmd.replace('console.log(sample);',"require('fs').writeFileSync('x','y');"),cmd.replace('sample.length','process.env.SECRET'),cmd.replace('sample.length','sample.constructor.constructor'),cmd.replace('console.log(sample);','fetch(\'https://example.test\');')]) {
    assert.throws(()=>assertChildCommands(rows(changed),options),changed);
  }
});

test('patch refuses duplicate, missing and already patched upstream anchors',()=>{
  const original=reliabilityPatches.map(([before])=>before).join('\n');
  assert.match(patchReliabilityServer(original),/output_length_no_progress/);
  assert.throws(()=>patchReliabilityServer(original+original),/Unsupported/);
  assert.throws(()=>patchReliabilityServer('unknown'),/Unsupported/);
  assert.throws(()=>patchReliabilityServer(patchReliabilityServer(original)),/Unsupported/);
});

function managed(children=[],running=true) {
  const methods=method('  abortRun()');
  const handle=new Function('childSession',`return ({${replacement('        sessionId: hop,').replace('sessionId: hop,','sessionId: "test",')}\n });`)({
    listBackgroundSubagents:()=>children.map((_,i)=>({sessionId:String(i)})),
    abortBackgroundSubagentRun:id=>children[Number(id)].abortRun()
  });
  return Object.assign(methods,{handle,isRunning:running,killed:false,runCtrl:new AbortController(),reportCurrentRun:true,
    approvals:[{settled:false}],settle(req,decision){req.settled=true;req.decision=decision;this.approvals.splice(this.approvals.indexOf(req),1);}});
}

test('parent abort cancels foreground, background and grandchildren but not other parents',()=>{
  const grandchild=managed(),idleChild=managed([grandchild],false),foreground=managed(),background=managed(),unrelated=managed();
  const children=[idleChild,foreground,background];let denied=0;
  const parentAbort=new AbortController();
  const manager=Object.assign(method('  abortTask(sessionId)'),{entries:new Map([['parent',{
    abort:parentAbort,approvals:{denyAll(){denied++;}},session:{
      listBackgroundSubagents:()=>children.map((_,i)=>({sessionId:String(i)})),
      abortBackgroundSubagentRun:id=>children[Number(id)].abortRun()
    }
  }]])});
  assert.equal(manager.abortTask('parent'),true);
  for(const child of [grandchild,foreground,background]) {
    assert.equal(child.runCtrl.signal.aborted,true);assert.equal(child.reportCurrentRun,false);assert.equal(child.approvals.length,0);
    child.isRunning=false;
  }
  assert.equal(parentAbort.signal.aborted,true);assert.equal(denied,1);
  assert.equal(unrelated.runCtrl.signal.aborted,false);
  manager.entries.get('parent').abort=null;
  assert.equal(manager.abortTask('parent'),false);
  assert.equal(manager.abortTask('missing'),false);
});

test('idle parent still cancels live descendants and late approvals are denied',async()=>{
  const child=managed();const manager=Object.assign(method('  abortTask(sessionId)'),{entries:new Map([['idle',{
    session:{listBackgroundSubagents:()=>[{sessionId:'child'}],abortBackgroundSubagentRun:()=>child.abortRun()},approvals:{denyAll(){}}
  }]])});
  assert.equal(manager.abortTask('idle'),true);
  const approve=new Function(`${replacement('    if (this.killed) return Promise.resolve')} return Promise.resolve("allow");`);
  assert.equal(await approve.call(child),'deny');
});

test('cancellation while spawning or yielding metadata prevents child start',()=>{
  for(const prefix of ['      if (background) {','        if (meta2) yield meta2;']) {
    const body=replacement(prefix).split(prefix.startsWith('      if')?'      if (background) {':'        session.startRun')[0].replace('        if (meta2) yield meta2;','');
    const run=new Function('signal','session',`${body}\n session.startRun();`);
    let killed=0,started=0;
    assert.deepEqual(run({aborted:true},{kill(){killed++;},startRun(){started++;}}),{stopReason:'aborted'});
    assert.equal(killed,1);assert.equal(started,0);
  }
});

function attemptHarness(turns) {
  const recovery=replacement('        failedTurns.push(turn);');
  const run=new Function('turns','userText',`
    const nextInput=[{text:"original scope"}],failedTurns=[];
    let attemptInput=nextInput,qaLengthRecovery=false;
    const inputs=[];
    for (const turn of turns) {
      inputs.push(attemptInput);
      if(turn.outcome.status==="completed") return {inputs,completed:true};
      ${recovery}
    }
    return {inputs,attemptInput};
  `);
  const state={withRetriedTurns:(input,failed)=>[...input,...failed]};
  return {result:run.call(state,turns,(text,sender)=>({text,sender})),state};
}
const lengthFailure=()=>({outcome:{status:'retryable',errorMessage:'OpenaiChatClient returned no content other than thinking (finish_reason="length").'},toolOutputs:[],thinking:'large reasoning'});
test('thinking-only exhaustion gets a compact harness continuation without replayed reasoning',()=>{
  const {result}=attemptHarness([lengthFailure(),{outcome:{status:'completed'}}]);
  assert.equal(result.completed,true);
  assert.equal(result.inputs[1].length,2);assert.equal(result.inputs[1][1].sender,'harness');
  assert.ok(!JSON.stringify(result.inputs[1]).includes('large reasoning'));
});
test('repeated no-output exhaustion ends clearly; generic retries and tool outcomes stay intact',()=>{
  const {result,state}=attemptHarness([lengthFailure(),lengthFailure()]);
  assert.equal(result.errorCode,'output_length_no_progress');assert.deepEqual(state.pendingCarryOver,[{text:'original scope'}]);
  const withTools=lengthFailure();withTools.toolOutputs=['real outcome'];
  assert.equal(attemptHarness([withTools]).result.attemptInput[1],withTools);
  const generic={outcome:{status:'retryable',errorMessage:'network'},toolOutputs:[]};
  assert.equal(attemptHarness([generic]).result.attemptInput[1],generic);
});

test('progress policy retains audit counts without fixed correction or revision gates',()=>{
  const state={};const context={key:'draft',request_sha256:'one'};
  for(let i=1;i<=7;i++) {
    const recovery=recordCorrection(state,'artifact_revision',context,new Error('same'),null);
    assert.equal(recovery.retry_allowed,true);assert.equal(recovery.failure_number,i);assert.equal(recovery.stalled,i>=3);
  }
  assert.equal(recordCorrection(state,'artifact_revision',{...context,request_sha256:'two'},new Error('same'),null).stalled,false);
  assert.equal(recordCorrection(state,'artifact_revision',context,new Error('different'),null).stalled,false);
  assert.deepEqual(stageRevisionBudget(Array.from({length:7},()=>({type:'stage_recovered',stage:'analysis',actor:'controller_auto_revision'})),'analysis'),{limit:null,used:7,remaining:null,policy:'progress_based'});
});
