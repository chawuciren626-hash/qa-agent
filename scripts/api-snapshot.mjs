import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { assertPlainPath } from './application-data.mjs';
import { apiHash } from './api-contract.mjs';
import { assertUnlinked } from './skill-resources.mjs';
import { withRunLock, getRunContext, writeJson } from './orchestration-state.mjs';
import { trackPlan } from './test-tracks.mjs';
import { CommandUsageError } from './command-contracts.mjs';

const check=(ok,message)=>{if(!ok)throw new CommandUsageError(message);};
const json=bytes=>JSON.parse(bytes);
const bytes=value=>Buffer.from(JSON.stringify(value,null,2));
const snapshotPath=/^execution\/api\/snapshots\/[a-f0-9]{64}\/snapshot\.json$/;
const receiptPath=/^execution\/api\/evidence\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/;
const localReceiptPath=/^inputs\/api-snapshot-evidence\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/;

// Freeze private progress plus exact public receipts, including completed requests
// in a scenario currently waiting for auth. Never copy private state or secrets.
export async function captureApiSnapshot(root,state) {
  const dir=runDirectory(root,state.run_id);
  let source,result,files,lastError;
  for(let attempt=0;attempt<8;attempt++) {
    try {
      const stateBytes=readFileSync(assertPlainPath(resolve(state.private_dir,'state.json'))),progress=json(stateBytes);
      source={sha256:apiHash(stateBytes)};
      check(progress.run_id===state.run_id && progress.dispatch_id===state.dispatch_id && progress.attempt_id===state.attempt_id,'API snapshot identity mismatch');
      const declared=json(readRunFile(dir,'execution/api/cases.json').data);
      check(declared.plan_sha256===progress.plan_sha256 && apiHash(declared.plan)===progress.plan_sha256,'API snapshot design changed');
      const receipts=new Map();
      files=Object.entries(progress.receipts??{}).map(([id,privateReceipt])=>{
        const path=`execution/api/evidence/${id}.json`;check(receiptPath.test(path),'Invalid API snapshot receipt path');
        const file=readRunFile(dir,path),value=json(file.data);
        check(file.sha256===apiHash(bytes({...privateReceipt,extracted:undefined})),'API snapshot receipt changed during capture');
        check(value.run_id===state.run_id && value.dispatch_id===state.dispatch_id && value.attempt_id===state.attempt_id,'API snapshot receipt identity mismatch');
        receipts.set(id,value);
        return {path:path.replace('execution/api/evidence/','inputs/api-snapshot-evidence/'),sha256:file.sha256,data:file.data};
      });
      check(new Set(files.map(f=>f.path)).size===files.length,'Duplicate API snapshot receipt');
      const cases=declared.plan.scenarios.map(s=>{
        const rows=s.steps.map(step=>receipts.get(step.request_id));
        const unknown=rows.some(r=>r && ['started','unknown'].includes(r.status) && (!['GET','HEAD','OPTIONS'].includes(r.method)||r.side_effect));
        const status=unknown?'blocked':rows.every(r=>r?.status==='passed')?'passed':rows.some(r=>r?.status==='failed')?'failed':'blocked';
        return {case_id:`api:${s.scenario_id}`,source_case_id:s.case_id,scenario_id:s.scenario_id,title:s.title??s.case_id,expected:s.expected,layer:'api',attempt:1,status,result_unknown:unknown,
          actual_result:status==='blocked'?'截至快照时刻尚未完成；已完成请求及断言保留。':status,assertions:rows.flatMap(r=>r?.assertions??[]),evidence_paths:rows.filter(Boolean).map(r=>`inputs/api-snapshot-evidence/${r.request_id}.json`)};
      });
      result={version:1,run_id:state.run_id,dispatch_id:state.dispatch_id,attempt_id:state.attempt_id,layer:'api',status:'partial',finished_at:null,result_origin:'api_snapshot',snapshot_at:new Date().toISOString(),started_at:progress.started_at??null,cases,
        summary:{total:cases.length,...Object.fromEntries(['passed','failed','blocked','skipped'].map(s=>[s,cases.filter(c=>c.status===s).length]))},evidence:files.map(({path,sha256})=>({path,sha256}))};
      break;
    }catch(error){lastError=error;source=null;if(attempt<7)await new Promise(done=>setTimeout(done,25));}
  }
  if(!source)throw new CommandUsageError('No consistent API snapshot available yet; retry collect without restarting execution: '+lastError.message);
  const id=apiHash([state.run_id,state.dispatch_id,state.attempt_id,source.sha256]);
  const base=`execution/api/snapshots/${id}`,path=`${base}/snapshot.json`;
  const target=resolve(dir,base);assertUnlinked(dir,target);
  if(existsSync(target)) {
    const previous=json(readRunFile(dir,path).data);
    check(previous.source_sha256===source.sha256 && previous.run_id===state.run_id && previous.dispatch_id===state.dispatch_id && previous.attempt_id===state.attempt_id,'Existing snapshot identity changed');
    result.snapshot_at=previous.snapshot_at;
  }
  files.push({path:'inputs/api-snapshot.json',data:bytes(result)});
  files=files.map(file=>({...file,sha256:apiHash(file.data)}));
  const record={version:1,kind:'api_execution_snapshot',run_id:state.run_id,dispatch_id:state.dispatch_id,attempt_id:state.attempt_id,source_sha256:source.sha256,snapshot_at:result.snapshot_at,result_path:'inputs/api-snapshot.json',files:files.map(({path,sha256})=>({path,sha256}))};
  if(!existsSync(target)) {
    const staging=target+'.pending-'+randomUUID();mkdirSync(staging,{recursive:true});
    for(const file of files){const dest=resolve(staging,file.path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,file.data,{flag:'wx'});}
    writeFileSync(resolve(staging,'snapshot.json'),bytes(record),{flag:'wx'});
    try{renameSync(staging,target);}catch(error){if(!existsSync(target))throw error;}
  }
  const saved=readRunFile(dir,path);check(saved.sha256===apiHash(bytes(record)),'Existing API snapshot changed');
  for(const file of files)check(readRunFile(dir,`${base}/${file.path}`).sha256===file.sha256,'Existing API snapshot evidence changed');
  const project=json(readFileSync(resolve(root,'config/project.json')));
  withRunLock(root,project,state.run_id,()=>{
    const {manifest,manifestPath}=getRunContext(root,project,state.run_id);
    const dispatch=manifest.orchestration.events.filter(e=>e.type==='dispatched' && e.stage==='api_execution').at(-1);
    check(dispatch?.dispatch_id===state.dispatch_id && dispatch['parent-session-id']===state.owner,'API snapshot dispatch changed');
    const prior=manifest.orchestration.events.find(e=>e.type==='api_snapshot_created' && e.snapshot_path===path);
    if(prior)check(prior.sha256===saved.sha256,'API snapshot audit changed');
    else {manifest.orchestration.events.push({type:'api_snapshot_created',at:new Date().toISOString(),snapshot_path:path,sha256:saved.sha256,dispatch_id:state.dispatch_id,attempt_id:state.attempt_id});writeJson(manifestPath,manifest);}
  });
  return {snapshot_path:path,snapshot_sha256:saved.sha256,snapshot_at:result.snapshot_at,result_path:`${base}/inputs/api-snapshot.json`,report_template:{action:'create_api_snapshot_report',run_id:state.run_id,snapshot_path:path}};
}

// The derived run has only a report stage. It cannot replace, finish or restart
// the execution whose immutable evidence it consumes.
export function createApiSnapshotReport(root,runId,owner,path) {
  check(snapshotPath.test(path),'Use the snapshot_path returned by API collect partial=true');
  const dir=runDirectory(root,runId);check(existsSync(resolve(dir,path)),'Snapshot is missing; use the snapshot_path returned by collect');
  const manifest=json(readRunFile(dir,'manifest.json').data),file=readRunFile(dir,path),record=json(file.data);
  const event=manifest.orchestration?.events?.find(e=>e.type==='api_snapshot_created' && e.snapshot_path===path && e.sha256===file.sha256);
  const dispatch=manifest.orchestration?.events?.find(e=>e.type==='dispatched' && e.stage==='api_execution' && e.dispatch_id===record.dispatch_id);
  check(event && record.kind==='api_execution_snapshot' && record.run_id===runId && event.attempt_id===record.attempt_id && dispatch?.['parent-session-id']===owner,'Snapshot must be audited and owned by this controller');
  check(record.result_path==='inputs/api-snapshot.json' && Array.isArray(record.files),'Invalid API snapshot manifest');
  const files=record.files.map(entry=>{
    check(entry.path===record.result_path || localReceiptPath.test(entry.path),'Invalid snapshot source path');
    const file=readRunFile(dir,`${path.slice(0,-'snapshot.json'.length)}${entry.path}`);
    check(file.sha256===entry.sha256,'Snapshot bytes changed');return {...entry,data:file.data};
  });
  check(new Set(files.map(f=>f.path)).size===files.length && files.some(f=>f.path===record.result_path),'Invalid snapshot sources');
  const reportId=`run-api-snapshot-${apiHash([runId,file.sha256,owner])}`,target=runDirectory(root,reportId);
  assertUnlinked(resolve(target,'..'),target);
  const binding={version:1,owner,source_run_id:runId,source_dispatch_id:record.dispatch_id,source_attempt_id:record.attempt_id,snapshot_path:path,snapshot_sha256:file.sha256,snapshot_at:record.snapshot_at,result_path:record.result_path,files:record.files};
  if(!existsSync(target)) {
    const now=new Date().toISOString(),plan={...trackPlan({stages:['report']},'api'),planned_at:now};
    const child={manifest_version:3,directory_context:manifest.directory_context,run_id:reportId,created_at:now,status:'planned',selected_agents:[],selected_skills:[],asset_refs:[],artifacts:[],api_snapshot_report:binding,
      delivery:{scope_name:manifest.delivery?.scope_name??'接口任务'},
      stages:Object.fromEntries(plan.stages.map(s=>[s.id,{status:s.selected?'planned':'skipped',updated_at:now}])),
      orchestration:{plan,resume_from:'report',events:[{type:'plan_created',at:now,stages:['report']} ]}};
    const staging=target+'.pending-'+randomUUID();
    for(const folder of ['inputs','analysis','design','execution','defects','report','audit'])mkdirSync(resolve(staging,folder),{recursive:true});
    for(const f of files){const dest=resolve(staging,f.path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,f.data,{flag:'wx'});}
    writeFileSync(resolve(staging,'manifest.json'),bytes(child),{flag:'wx'});
    renameSync(staging,target);
  }
  const saved=json(readRunFile(target,'manifest.json').data);
  check(apiHash(saved.api_snapshot_report)===apiHash(binding),'Snapshot report run collision');
  verifySnapshotReport(target,saved);
  return {run_id:reportId,source_run_id:runId,snapshot_at:record.snapshot_at,starts_execution:false,source_unchanged:true,dispatch_template:{action:'dispatch',run_id:reportId,stage:'report',agent:'test_report_agent',skills:['test-report-writing']}};
}

export function verifySnapshotReport(dir,manifest) {
  const binding=manifest.api_snapshot_report;if(!binding)return null;
  check(binding.result_path==='inputs/api-snapshot.json' && Array.isArray(binding.files),'Invalid snapshot report binding');
  for(const file of binding.files){check(file.path===binding.result_path || localReceiptPath.test(file.path),'Invalid snapshot report source');check(readRunFile(dir,file.path).sha256===file.sha256,'Snapshot report source changed');}
  check(binding.files.some(f=>f.path===binding.result_path),'Snapshot result is not bound');
  const result=json(readRunFile(dir,binding.result_path).data);
  check(result.result_origin==='api_snapshot' && result.status==='partial' && result.finished_at===null && result.run_id===binding.source_run_id && result.dispatch_id===binding.source_dispatch_id && result.attempt_id===binding.source_attempt_id,'Snapshot report identity or partial state changed');
  return result;
}
