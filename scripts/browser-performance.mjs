const performancePhases=['navigation','browser_action','assertion_wait','privacy_scan','snapshot_dom','screenshot_with_privacy','evidence_write'];

// Receipts must already be source-hash and attempt bound by the caller.
export function summarizeBrowserPerformance(receipts) {
  const phases=Object.fromEntries(performancePhases.map(phase=>[phase,{measured_operations:0,duration_ms:null}]));
  let measured=0,missing=0,invalid=0,total=0;
  const finite=n=>typeof n==='number' && Number.isFinite(n) && n>=0 && n<=Number.MAX_SAFE_INTEGER;
  for(const receipt of receipts) {
    const p=receipt?.result?.performance;
    if(p===undefined || p===null) {missing++;continue;}
    if(p.version!==1 || !finite(p.worker_elapsed_ms) || !Array.isArray(p.spans) || p.spans.length>10000 ||
      p.spans.some(s=>!s || !performancePhases.includes(s.phase) || !finite(s.start_offset_ms) || !finite(s.duration_ms) || s.start_offset_ms+s.duration_ms>p.worker_elapsed_ms+0.001)) {invalid++;continue;}
    if(!finite(total+p.worker_elapsed_ms)) {invalid++;continue;}
    measured++;total+=p.worker_elapsed_ms;
    for(const phase of performancePhases) {
      const spans=p.spans.filter(s=>s.phase===phase).sort((a,b)=>a.start_offset_ms-b.start_offset_ms);
      if(!spans.length) continue;
      let end=0,duration=0;
      for(const s of spans) {const next=s.start_offset_ms+s.duration_ms;duration+=Math.max(0,next-Math.max(end,s.start_offset_ms));end=Math.max(end,next);}
      phases[phase].measured_operations++;phases[phase].duration_ms=(phases[phase].duration_ms ?? 0)+duration;
    }
  }
  return {version:1,status:measured?'observed':invalid?'invalid':'not_recorded',measured_operations:measured,missing_operations:missing,invalid_operations:invalid,
    recorded_operation_ms:measured?total:null,phases,model_round_trip_ms:null,queue_ms:null,
    interpretation:'Indexed completed receipts only. Operation totals are not session wall time or product test counts. Same-phase overlap is unioned within each operation; different phases and human handoff can overlap. Missing phases are unknown. Excludes transport and final receipt writes; no model/queue inference.'};
}

export function operationPerformance(clock=()=>performance.now()) {
  const start=clock(),spans=[];
  const record=(phase,at)=>spans.push({phase,start_offset_ms:Math.max(0,at-start),duration_ms:Math.max(0,clock()-at)});
  return {
    async measure(phase,fn) {const at=clock();try {return await fn();} finally {record(phase,at);}},
    measureSync(phase,fn) {const at=clock();try {return fn();} finally {record(phase,at);}},
    snapshot() {return {version:1,worker_elapsed_ms:Math.max(0,clock()-start),spans:spans.map(s=>({...s})),model_round_trip_ms:null,queue_ms:null,
      interpretation:'Monotonic worker measurements before final receipt commit. Nested spans overlap; do not sum them as wall time. Excludes CLI startup, final receipt/checkpoint writes and transport. Model and queue times are not measured here; null is not zero.'};}
  };
}

// A handoff window includes delivery and dispatch latency, not just human effort.
// Monotonic durations are meaningful only in this worker lifetime.
export function humanHandoffTiming({clock=()=>performance.now(),wall=()=>new Date().toISOString()}={}) {
  const intervals=[];let pending=null;
  const duration=start=>Math.max(0,clock()-start);
  return {
    begin(requestId,kind) {
      if(pending) throw new Error('Human handoff is already open');
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(requestId ?? '') || !['captcha','mfa','access','business_question','risk_decision'].includes(kind)) throw new Error('Invalid human handoff identity');
      pending={request_id:requestId,kind,started_at:wall(),start:clock()};
      return pending.started_at;
    },
    end(reason) {
      if(!['resumed','finished_without_resume','worker_expired'].includes(reason)) throw new Error('Invalid human handoff ending');
      if(!pending) return;
      const {start,...entry}=pending;
      intervals.push({...entry,ended_at:wall(),duration_ms:duration(start),reason});pending=null;
    },
    snapshot() {
      const {start,...entry}=pending ?? {};
      const open=pending?{...entry,elapsed_ms:duration(start)}:null;
      const closedMs=intervals.reduce((sum,item)=>sum+item.duration_ms,0);
      return {version:1,clock:'worker_monotonic',measured_through_at:wall(),intervals:intervals.map(item=>({...item})),open,
        closed_window_ms:closedMs,observed_window_ms:closedMs+(open?.elapsed_ms ?? 0),
        interpretation:'Pause declaration to first accepted resumed dispatch, finish or worker expiry. Includes handoff/orchestration latency, not measured human effort. Open intervals are measured only through this snapshot; worker loss does not establish their end. May overlap operation spans; do not subtract or sum blindly.'};
    }
  };
}

// Whitelist projection for normal and recovered reports; never copy free text.
export function summarizeHumanHandoff(value) {
  const missing=status=>({status,closed_window_ms:null,open_observed_ms:null,human_effort_ms:null});
  if(value===undefined || value===null) return missing('not_recorded');
  const number=n=>typeof n==='number' && Number.isFinite(n) && n>=0;
  const date=s=>typeof s==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s) && Number.isFinite(Date.parse(s));
  const ids=new Set(),kinds=['captcha','mfa','access','business_question','risk_decision'];
  const entry=row=>row && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(row.request_id ?? '') && !ids.has(row.request_id) && kinds.includes(row.kind) && date(row.started_at);
  if(value.version!==1 || value.clock!=='worker_monotonic' || !Array.isArray(value.intervals) || !date(value.measured_through_at)) return missing('invalid');
  let sum=0;const counts={resumed:0,finished_without_resume:0,worker_expired:0};
  for(const row of value.intervals) {
    if(!entry(row) || !number(row.duration_ms) || !date(row.ended_at) || !Object.hasOwn(counts,row.reason)) return missing('invalid');
    ids.add(row.request_id);sum+=row.duration_ms;counts[row.reason]++;
  }
  const open=value.open;
  if(open!==null && (!entry(open) || !number(open.elapsed_ms))) return missing('invalid');
  if(!number(sum) || !number(value.closed_window_ms) || !number(value.observed_window_ms) || Math.abs(value.closed_window_ms-sum)>0.001 || Math.abs(value.observed_window_ms-sum-(open?.elapsed_ms ?? 0))>0.001) return missing('invalid');
  return {status:'observed',closed_windows:value.intervals.length,ended_by:counts,closed_window_ms:sum,open:open!==null,
    open_observed_ms:open?.elapsed_ms ?? null,measured_through_at:new Date(value.measured_through_at).toISOString(),human_effort_ms:null};
}
