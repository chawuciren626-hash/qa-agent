import assert from 'node:assert/strict';

export function validateDialogPolicy(policy) {
  assert(policy && !Array.isArray(policy) && Object.keys(policy).every(k=>['type','message','action','prompt_text'].includes(k)), 'Invalid dialog_policy');
  assert(['alert','confirm','prompt'].includes(policy.type) && ['accept','dismiss'].includes(policy.action), 'Use an explicit native dialog type and action');
  assert(typeof policy.message==='string' && policy.message.length<=4000, 'Dialog policy needs exact message text');
  assert(policy.prompt_text===undefined || (policy.type==='prompt' && policy.action==='accept' && typeof policy.prompt_text==='string' && policy.prompt_text.length<=4000), 'prompt_text is only valid for an accepted prompt');
}

// One policy handles one matching dialog, never every dialog on the page. Text
// and prompt values are deliberately absent from evidence (they may be secrets).
export function createDialogTracker({onEvent=()=>{}}={}) {
  let active=null, sequence=0;
  const pending=new Set();
  const publish=event=>{try {onEvent({...event});} catch {event.evidence_unavailable=true;}};
  const begin=(requestId,policy)=>{
    if(policy) validateDialogPolicy(policy);
    assert(!active,'Previous dialog observation is still active');
    active={request_id:requestId,policy,events:[],used:false};
  };
  const arm=policy=>{
    validateDialogPolicy(policy);assert(active,'No active dialog observation');
    active.policy=policy;
  };
  const handle=dialog=>{
    const scope=active,policy=scope?.policy;
    const matched=!!policy && !scope.used && dialog.type()===policy.type && dialog.message()===policy.message;
    if(scope) scope.used=true;
    const event={id:++sequence,request_id:scope?.request_id ?? null,type:dialog.type(),policy_matched:matched,action:matched?policy.action:'dismiss',status:'pending',observed_at:new Date().toISOString()};
    scope?.events.push(event);publish(event);
    const operation=(async()=>{
      try {
        if(event.action==='accept') await dialog.accept(policy.prompt_text);
        else await dialog.dismiss();
        event.status='handled';
      } catch {event.status='handling_failed';}
      event.completed_at=new Date().toISOString();publish(event);
    })();
    pending.add(operation);operation.finally(()=>pending.delete(operation));
    return operation;
  };
  const settle=async()=>{while(pending.size) await Promise.all([...pending]);};
  const reason=()=>{
    const events=active?.events ?? [];
    if(events.some(e=>e.evidence_unavailable)) return 'dialog_evidence_unavailable';
    if(events.some(e=>e.status!=='handled')) return 'dialog_handling_unconfirmed';
    if(events.some(e=>!e.policy_matched)) return 'unexpected_dialog';
    if(active?.policy && !events.length) return 'expected_dialog_not_observed';
    return null;
  };
  const end=async()=>{
    await settle();
    const result={request_id:active?.request_id ?? null,policy_supplied:!!active?.policy,reason:reason(),events:(active?.events ?? []).map(e=>({...e})),interpretation:'Dialogs observed during this operation window, not causal or business-success proof. Missing expected dialogs are unverified; do not replay the action.'};
    active=null;return result;
  };
  return {begin,arm,handle,settle,reason,end};
}
