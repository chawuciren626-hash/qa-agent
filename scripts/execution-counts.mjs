import { createHash } from 'node:crypto';
const requireValue=(ok,message)=>{if(!ok) throw new Error(message);};
export function uiCheckFingerprint(check) {
  return createHash('sha256').update(JSON.stringify({target:{by:check.target.by,value:check.target.value,name:check.target.name ?? null},condition:check.condition,value:check.value ?? (check.condition==='text'?check.target.value:null)})).digest('hex');
}
export function validateCountMetadata(check) {
  if(check.case_ref!==undefined) {
    const ref=check.case_ref;
    requireValue(ref && Object.keys(ref).every(k=>['source_path','case_id'].includes(k)) && typeof ref.source_path==='string' && (/^inputs\/[^\\:\x00-\x1f]+\.json$/.test(ref.source_path) || ref.source_path==='design/test_cases.json') && !ref.source_path.split('/').some(p=>p==='.' || p==='..') && typeof ref.case_id==='string' && ref.case_id.trim() && ref.case_id.length<=100,'case_ref needs an archived inputs/ JSON or design/test_cases.json source and exact case_id');
  }
  if(check.recheck_of!==undefined) requireValue(typeof check.recheck_of==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(check.recheck_of),'recheck_of must identify an earlier read-only assertion');
}

export function resolveCaseReference(ref,read) {
  if(!ref) return null;
  validateCountMetadata({case_ref:ref});
  const file=read(ref.source_path),value=JSON.parse(file.data);
  const rows=Array.isArray(value)?value:value.cases ?? value.test_cases;
  const matches=Array.isArray(rows)?rows.filter(row=>row?.case_id===ref.case_id):[];
  requireValue(matches.length===1 && typeof matches[0].expected==='string' && matches[0].expected.trim(),'Referenced design case must exist exactly once with an expected result; do not create predecessor files');
  return {...ref,source_sha256:file.sha256};
}

const statuses=['passed','failed','blocked','skipped','unknown'];
export function summarizeExecutionCounts(rows,{interactive=false,readSource}={}) {
  const counts=Object.fromEntries(statuses.map(status=>[status,rows.filter(row=>(statuses.includes(row.status)?row.status:'unknown')===status).length]));
  const linked=new Set();let mapped=0,rechecks=0,recovered=0,invalidRechecks=0;
  const seen=new Map();
  for(const row of rows) {
    if(interactive && row.case_ref && readSource) try {
      const actual=resolveCaseReference({source_path:row.case_ref.source_path,case_id:row.case_ref.case_id},readSource);
      if(actual.source_sha256===row.case_ref.source_sha256) {linked.add(JSON.stringify([actual.source_path,actual.source_sha256,actual.case_id]));mapped++;}
    } catch { /* Missing optional design evidence does not block delivery. */ }
    if(interactive && row.recheck_of) {
      const previous=seen.get(row.recheck_of);
      if(previous && !['simulated','simulation_affected'].includes(previous.evidence_mode) && !['simulated','simulation_affected'].includes(row.evidence_mode) && row.timing?.mode==='standalone_observation' && previous.verification_scope?.layer==='ui' && row.verification_scope?.layer==='ui' && previous.expected===row.expected && typeof row.check_fingerprint==='string' && row.check_fingerprint===previous.check_fingerprint && JSON.stringify(row.case_ref ?? null)===JSON.stringify(previous.case_ref ?? null)) {
        rechecks++;if(previous.status==='failed' && row.status==='passed') recovered++;
      } else invalidRechecks++;
    }
    // Duplicate identifiers are not silently collapsed into one passing result.
    if(seen.has(row.case_id)) seen.set(row.case_id,null);else seen.set(row.case_id,row);
  }
  let attempts=0,retries=0,withHistory=0,flaky=0,frameworkRuns=0;
  if(!interactive) for(const row of rows) {
    const history=row.retries;
    if(!Array.isArray(history) || !history.length || !history.every((item,i)=>item && Number.isInteger(item.retry) && item.retry>=0 && (i===0?item.retry===0:item.retry===0 || item.retry===history[i-1].retry+1) && ['passed','failed','timedOut','skipped','interrupted'].includes(item.status))) continue;
    withHistory++;attempts+=history.length;retries+=history.filter(item=>item.retry>0).length;frameworkRuns+=history.filter(item=>item.retry===0).length;
    let failed=false,recoveredStream=false;
    for(const item of history) {if(item.retry===0) failed=false;if(item.status==='passed' && failed) recoveredStream=true;if(['failed','timedOut'].includes(item.status)) failed=true;}
    if(recoveredStream) flaky++;
  }
  return {unit:interactive?'assertion_records':'result_records',records:rows.length,counts,
    evidence_modes:Object.fromEntries(['real','simulated','simulation_affected','not_recorded'].map(mode=>[mode,rows.filter(row=>(['real','simulated','simulation_affected'].includes(row.evidence_mode)?row.evidence_mode:'not_recorded')===mode).length])),
    linked_case_count:interactive && mapped?linked.size:null,linked_assertions:mapped,unmapped_assertions:interactive?rows.length-mapped:null,
    read_only_rechecks:interactive?rechecks:null,rechecks_passed_after_failure:interactive?recovered:null,invalid_recheck_links:interactive?invalidRechecks:null,
    framework_attempts:withHistory?attempts:null,framework_retries:withHistory?retries:null,framework_flaky_records:withHistory?flaky:null,
    framework_runs:withHistory?frameworkRuns:null,
    records_with_retry_history:withHistory,records_without_retry_history:interactive?null:rows.length-withHistory,
    duplicate_record_ids:rows.length-new Set(rows.map(row=>row.case_id)).size,
    interpretation:'Case links establish referenced design coverage only, not whole-case success or full coverage. Read-only rechecks are later observations, not product re-executions or framework retries. Original failures remain. Retry totals cover valid recorded histories only; missing history is unknown, not zero. Receipt reads and model/tool retries are not product executions.'};
}
