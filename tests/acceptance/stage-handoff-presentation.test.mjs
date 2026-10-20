import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Isolate imported readers for fault injection without adding bypass hooks to handoff.
async function scenario(name,sourceUrl) {
  const assert=(await import('node:assert/strict')).default;
  const {readFileSync}=await import('node:fs');
  const {SourceTextModule,SyntheticModule}=await import('node:vm');
  const run='run-handoff',stage='analysis',parent='parent',dispatch='dispatch-current';
  const reconciliation=name.startsWith('reconcile_');
  const confirmationRequired=!reconciliation || ['reconcile_confirmation','reconcile_pending_confirmation'].includes(name);
  const controller=new AbortController();
  let failedReceipt;
  const manifest={stages:{[stage]:{status:'in_progress'}},confirmations:[],orchestration:{
    plan:{stages:[{id:stage,selected:true,confirmation:confirmationRequired?'after':'none'}]},
    events:[{type:'dispatched',stage,dispatch_id:dispatch,'parent-session-id':parent}]
  }};
  let committed=false,enabled=true,reads=0,launches=0,completedChecks=0;
  const fail=point=>{if(enabled && name===point) throw new Error(`injected ${point}`);};
  const exports={
    './design-quality.mjs':{
      runDirectory:()=>{if(committed && reads>0) fail('directory');return '/synthetic';},
      readRunFile:()=>{
        reads++;
        if(enabled && name==='reconcile_inspection_failure' && reads>1) throw new Error('manifest unavailable');
        if(committed && reads>1) {
          fail('manifest_read');
          if(enabled && name==='manifest_parse') return {data:'{'};
          if(enabled && name==='manifest_stage') return {data:'{"stages":{}}'};
        }
        return {data:JSON.stringify(manifest)};
      }
    },
    './stage-evidence.mjs':{
      resolveDispatchedChild:()=>{fail('child');return {child_session:'child'};},
      verifyStageEvidence:()=>{fail('evidence');return {};},
      partialBrowserDelivery:()=>assert.fail('not a partial delivery'),
      draftHandoffReconciliation:()=>assert.fail('not a blocked recovery')
    },
    './artifact-contracts.mjs':{
      assertArtifactContract:()=>fail('contract'),assertDependencyArtifacts:()=>fail('dependency'),
      assertCompletedArtifacts:()=>{completedChecks++;fail('changed_artifact');fail('reconcile_artifact_changed');}
    },
    './orchestration-state.mjs':{assertStageHistory:()=>fail('history')},
    './execution-authorization.mjs':{executionSnapshot:()=>assert.fail('not execution')},
    './command-contracts.mjs':{CommandUsageError:class extends Error {}},
    './command-runtime.mjs':{runProjectCommand:async(_root,command)=>{
      launches++;
      assert.equal(command.timeoutMs,120000);
      assert.equal(command.signal,controller.signal,'cancellation must reach the writer');
      if(name==='command_failure') return {status:'failed',exit_code:1};
      if(name==='command_throw') throw new Error('writer unavailable');
      const lostResponse=reconciliation && enabled && (name!=='reconcile_confirmation' || command.script==='request-stage-confirmation.mjs');
      const failure=()=>{
        if(name==='reconcile_aborted') controller.abort();
        failedReceipt={status:name==='reconcile_interrupted'?'interrupted':name==='reconcile_nonzero'?'completed':
          name==='reconcile_launch_failed'?'launch_failed':'timeout',exit_code:124,
          command_id:'original-command',evidence_dir:'/synthetic/audit/original-command',
          result:{pid:['reconcile_not_launched','reconcile_pure_failure'].includes(name)?null:123,
            termination_confirmed:name!=='reconcile_unconfirmed',termination:name==='reconcile_interrupted_result'?'interrupted':'timeout'}};
        return failedReceipt;
      };
      if(lostResponse && ['reconcile_not_committed','reconcile_pure_failure'].includes(name)) return failure();
      if(command.script==='record-orchestration-event.mjs') {
        assert.equal(committed,false,'completion must not repeat');committed=true;
        manifest.stages[stage].status='completed';
        manifest.orchestration.events.push({type:'completed',stage,'dispatch-id':dispatch,evidence:{parent_session_id:parent}});
      } else {
        assert.equal(command.script,'request-stage-confirmation.mjs');
        assert.equal(manifest.confirmations.length,0,'confirmation must not repeat');
        manifest.confirmations.push({stage,id:'confirmation',status:'pending'});
        manifest.orchestration.events.push({type:'confirmation_requested',stage,confirmation_id:'confirmation'});
        manifest.stages[stage].status='awaiting_confirmation';
      }
      if(lostResponse) {
        if(name==='reconcile_foreign_dispatch') {
          manifest.orchestration.events[0].dispatch_id='foreign-dispatch';
          manifest.orchestration.events[1]['dispatch-id']='foreign-dispatch';
        }
        return failure();
      }
      return {status:'completed',exit_code:0};
    }},
    './run-status-summary.mjs':{summarizeRun:()=>{fail('run_status');return {consistency:'consistent'};}},
    './analysis-summary.mjs':{analysisSummary:()=>{fail('analysis_summary');return {summary:'analysis'};}},
    './independent-task.mjs':{
      isIndependent:()=>{fail('independent_mode');return false;},
      usesTaskArtifacts:()=>{fail('task_mode');return true;},
      inspectIndependentArtifacts:()=>{
        fail('task_result');
        return enabled && name==='task_invalid'?{status:'blocked',errors:['invalid task'],delivery:{summary:'unsafe'}}:
          {status:'passed',delivery:{summary:'task'}};
      }
    },
    './delivery-presentation.mjs':{deliveryPresentation:()=>{fail('delivery');fail('reconcile_presentation');return {reply_template:'verified'};}}
  };
  const module=new SourceTextModule(readFileSync(new URL(sourceUrl),'utf8'));
  await module.link(specifier=>{
    const values=exports[specifier];assert.ok(values,`unexpected import ${specifier}`);
    return new SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values)) this.setExport(key,value);});
  });
  await module.evaluate();
  const invoke=()=>{reads=0;return module.namespace.handoffStage('/synthetic',parent,{run_id:run,stage,artifacts:['analysis/requirement_analysis.md']},{signal:controller.signal});};
  if(['child','evidence','contract','dependency','history'].includes(name)) {
    await assert.rejects(invoke(),module.namespace.HandoffInputError);assert.equal(launches,0);return;
  }
  if(name==='command_throw') {await assert.rejects(invoke(),/writer unavailable/);assert.equal(committed,false);return;}
  const result=await invoke();
  if(reconciliation) {
    const success=['reconcile_completion','reconcile_confirmation','reconcile_nonzero','reconcile_presentation'].includes(name);
    const expectedLaunches=name==='reconcile_confirmation'?2:1;
    assert.equal(launches,expectedLaunches,'must never replay or continue commands after a failed response');
    assert.equal(result.handoff_receipts.length,expectedLaunches);
    assert.equal(result.handoff_receipts.at(-1),failedReceipt,'keep the exact failure receipt');
    assert.equal(result.approval_granted ?? result.data.approval_granted,false);
    if(!success) {
      assert.equal(result.status,failedReceipt.status);assert.equal(result.exit_code,failedReceipt.exit_code);
      assert.equal(result.result,failedReceipt.result);assert.equal(result.data?.commit_reconciled,undefined);
      if(['reconcile_not_launched','reconcile_pure_failure','reconcile_unconfirmed','reconcile_interrupted',
        'reconcile_interrupted_result','reconcile_aborted','reconcile_launch_failed'].includes(name)) assert.equal(reads,1,'ineligible failures must not trigger reconciliation');
      if(name==='reconcile_pending_confirmation') assert.equal(manifest.confirmations.length,0);
      if(['reconcile_not_committed','reconcile_pure_failure'].includes(name)) assert.equal(committed,false);
      return;
    }
    assert.equal(result.status,'completed');assert.equal(result.exit_code,0);assert.equal(result.data.commit_reconciled,true);
    assert.equal(result.data.dispatch_id,dispatch);assert.equal(result.data.execution_started,false);
    assert.equal(result.data.presentation.status,name==='reconcile_presentation'?'unavailable':'ready');
    assert.equal(completedChecks,1);
    enabled=false;
    const retry=await invoke();
    assert.equal(retry.status,'completed');assert.equal(retry.data.already_recorded,true);
    assert.equal(retry.data.commit_reconciled,false);assert.equal(retry.handoff_receipts.length,0);
    assert.equal(launches,expectedLaunches);assert.equal(completedChecks,2);
    assert.equal(manifest.confirmations.length,name==='reconcile_confirmation'?1:0);
    return;
  }
  if(name==='command_failure') {assert.equal(result.status,'failed');assert.equal(committed,false);return;}
  assert.equal(result.status,'completed');assert.equal(result.exit_code,0);assert.equal(result.data.dispatch_id,dispatch);
  assert.equal(result.data.approval_granted,false);assert.equal(result.data.execution_started,false);
  assert.equal(launches,2);assert.equal(result.handoff_receipts.length,2);
  if(name!=='ready' && name!=='changed_artifact') {
    assert.equal(result.data.presentation.status,'unavailable');assert.equal(result.data.next_action,'inspect_presentation');
    assert.equal(result.data.presentation.errors.length,1);
    const actions={directory:'manifest',manifest_read:'manifest',manifest_parse:'manifest',manifest_stage:'manifest',
      independent_mode:'analysis_summary',task_mode:'task_result',task_invalid:'task_result'};
    assert.equal(result.data.presentation.errors[0].action,actions[name] ?? name);
    if(['directory','manifest_read','manifest_parse','manifest_stage'].includes(name)) assert.equal(result.data.stage_status,null);
    if(name==='task_invalid') assert.equal(result.data.presentation.task_result,undefined);
  } else assert.equal(result.data.presentation.status,'ready');
  if(name==='changed_artifact') {
    await assert.rejects(invoke(),module.namespace.HandoffInputError);assert.equal(launches,2);return;
  }
  // Simulate a lost response or failed presentation: retry must inspect the same commit.
  enabled=false;
  const retry=await invoke();
  assert.equal(retry.status,'completed');assert.equal(retry.data.already_recorded,true);
  assert.equal(retry.launches_child,false);assert.equal(retry.handoff_receipts.length,0);
  assert.equal(retry.data.presentation.status,'ready');assert.equal(retry.data.next_action,'present_result_and_wait_for_user');
  assert.equal(launches,2);assert.equal(completedChecks,1);assert.equal(manifest.confirmations.length,1);
}

for(const name of ['ready','directory','manifest_read','manifest_parse','manifest_stage','run_status','analysis_summary',
  'independent_mode','task_mode','task_result','task_invalid','delivery','child','evidence','contract','dependency','history',
  'changed_artifact','command_failure','command_throw','reconcile_completion','reconcile_confirmation','reconcile_nonzero',
  'reconcile_pending_confirmation','reconcile_not_committed','reconcile_unconfirmed','reconcile_interrupted',
  'reconcile_interrupted_result','reconcile_aborted','reconcile_foreign_dispatch','reconcile_artifact_changed',
  'reconcile_inspection_failure','reconcile_not_launched','reconcile_pure_failure','reconcile_launch_failed','reconcile_presentation']) {
  test(`handoff presentation boundary: ${name}`,()=>{
    const source=new URL('../../scripts/stage-handoff.mjs',import.meta.url).href;
    const code=`await (${scenario.toString()})(${JSON.stringify(name)},${JSON.stringify(source)});`;
    const result=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',code],
      {encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(result.status,0,result.stderr || result.error?.message);
  });
}
