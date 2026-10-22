import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { workflowDefinition, stageNames } from './stage-registry.mjs';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { getRunContext, withRunLock, writeJson, recomputeRunStatus } from './orchestration-state.mjs';
import { assertRunContext } from './directory-context.mjs';
import { assertUnlinked } from './skill-resources.mjs';
import { CommandUsageError } from './command-contracts.mjs';

export const trackLabels = { functional: '功能', api: '接口' };
export function safeDeliveryScope(value) {
  if(typeof value!=='string' || !value.trim() || value.length>160)throw new CommandUsageError('scope_name must be the actual feature/module name (1–160 characters)');
  const name=value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f#%]/g,'_').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'').slice(0,60).replace(/[. ]+$/g,'');
  if(!name || /^_+$/.test(name))throw new CommandUsageError('scope_name needs a readable feature/module name');
  return name;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (ok, message) => { if (!ok) throw new CommandUsageError(message); };
const readManifest = (root, id) => {const value=JSON.parse(readRunFile(runDirectory(root,id),'manifest.json').data);assertRunContext(root,value);return value;};

export function validateTrackRequest(request) {
  if(request.scope_name!==undefined)safeDeliveryScope(request.scope_name);
  check(Array.isArray(request.tracks) && request.tracks.length>0 && request.tracks.length<=2,'Provide one or two material-backed test tracks');
  check(new Set(request.tracks.map(t=>t?.type)).size===request.tracks.length,'Duplicate test track');
  for(const track of request.tracks) {
    check(track && Object.keys(track).every(k=>['type','source_paths','reason'].includes(k)) && Object.hasOwn(trackLabels,track.type),'Track type must be functional or api');
    check(typeof track.reason==='string' && track.reason.trim(),'Explain material classification, not just its filename');
    check(Array.isArray(track.source_paths) && track.source_paths.length>0 && new Set(track.source_paths).size===track.source_paths.length && track.source_paths.every(p=>typeof p==='string' && /^inputs\/[^/\\]+$/.test(p) && !p.includes('..')),'Each track needs archived input source_paths');
  }
  check(Array.isArray(request.stages) && request.stages.length>0 && new Set(request.stages).size===request.stages.length && request.stages.every(id=>Object.hasOwn(stageNames,id)),'Provide unique requested stages');
  check(['task','lifecycle'].includes(request.workflow_mode??'task'),'Invalid workflow mode');
  check(['auto','staged'].includes(request.review_mode??'auto'),'Invalid review mode');
  check(['provided_materials','live_product'].includes(request.source_mode??'provided_materials'),'Invalid source mode');
  check(request.source_mode!=='live_product' || (request.workflow_mode??'task')==='task','Live product is task mode only');
}

export function trackPlan(request,type) {
  const definition=workflowDefinition(),execution=type==='api'?'api_execution':'execution';
  const workflowMode=request.workflow_mode??'task',reviewMode=request.review_mode??'auto',sourceMode=request.source_mode??'provided_materials';
  const requested=new Set(request.stages.map(id=>['execution','api_execution'].includes(id)?execution:id));
  if(sourceMode==='live_product')requested.add(execution);
  const stages=definition.stages.map(s=>({...s,depends_on:s.id==='defects'?[execution]:[...s.depends_on]}));
  const selected=new Set();
  function visit(id){if(selected.has(id))return;const stage=stages.find(s=>s.id===id);check(stage,'Unknown track stage');if(workflowMode==='lifecycle')stage.depends_on.forEach(visit);selected.add(id);}
  requested.forEach(visit);
  for(const stage of stages) {
    stage.selected=selected.has(stage.id);
    // Task mode preserves only dependencies between capabilities actually selected.
    // Design-only tasks never acquire execution as an implicit prerequisite.
    if(workflowMode==='task') {
      const order=['analysis','test_points','test_cases',execution,'defects','report'];
      stage.depends_on=order.slice(0,order.indexOf(stage.id)).filter(id=>selected.has(id)).slice(-1);
      if(sourceMode==='live_product')stage.depends_on=stage.id===execution?[]:selected.has(stage.id)?[execution]:[];
    }
    stage.confirmation=reviewMode==='staged'?'after':'none';
  }
  if(sourceMode==='live_product')stages.sort((a,b)=>Number(b.id===execution)-Number(a.id===execution));
  return {workflow_id:definition.workflow_id,workflow_version:definition.workflow_version,workflow_mode:workflowMode,review_mode:reviewMode,source_mode:sourceMode,execution_branches:selected.has(execution)?[execution]:[],stages};
}

export function planTestTracks(root,runId,request) {
  validateTrackRequest(request);
  const project=JSON.parse(readFileSync(resolve(root,'config/project.json')));
  return withRunLock(root,project,runId,()=>{
    const {manifest,manifestPath}=getRunContext(root,project,runId),parentDir=runDirectory(root,runId);
    check(!manifest.test_track,'A typed child cannot create replacement tracks');
    check(!manifest.orchestration?.plan?.stages?.length && !manifest.orchestration?.events?.some(e=>e.stage),'Existing task plans cannot be split or reset; preserve their evidence');
    const spec={tracks:request.tracks.map(t=>({...t,source_paths:[...t.source_paths].sort()})).sort((a,b)=>a.type.localeCompare(b.type)),stages:[...request.stages].sort(),workflow_mode:request.workflow_mode??'task',review_mode:request.review_mode??'auto',source_mode:request.source_mode??'provided_materials',...(request.scope_name!==undefined?{scope_name:safeDeliveryScope(request.scope_name)}:{})};
    const key=digest(spec),prior=manifest.test_tracks;
    check(!prior || prior.spec_sha256===key,'Test tracks already planned; continue their existing run IDs, never reset or replace them');
    const contextPath='audit/user-input-context.json';
    const context=existsSync(resolve(parentDir,contextPath))?JSON.parse(readRunFile(parentDir,contextPath).data):null;
    const shared=context?.user_messages?.map(m=>m.path)??[];
    const snapshots=spec.tracks.map(t=>{
      const primary=t.source_paths.map(path=>{check(existsSync(resolve(parentDir,path)),'Track source is missing; use an archived input path');const f=readRunFile(parentDir,path);return {path,sha256:f.sha256};});
      const paths=new Set([...t.source_paths,...shared]);
      for(const path of t.source_paths)if(/\.docx$/i.test(path))for(const extra of [path+'.txt',path+'.extraction.json'])if(existsSync(resolve(parentDir,extra)))paths.add(extra);
      const files=[...paths].map(path=>{const f=readRunFile(parentDir,path);return {path,sha256:f.sha256,data:f.data};});
      return {...t,run_id:runId+'-'+t.type,primary,files};
    });
    if(prior)for(const t of snapshots)check(digest(t.primary)===digest(prior.tracks.find(p=>p.type===t.type)?.source_refs),'Original track material changed; preserve source snapshots');
    // Check every destination and source before publishing the group journal.
    for(const t of snapshots) {
      const dir=runDirectory(root,t.run_id);assertUnlinked(runDirectory(root,runId),parentDir);
      assertUnlinked(resolve(dir,'..'),dir);
      if(existsSync(resolve(dir,'manifest.json'))){const child=readManifest(root,t.run_id);check(prior && child.test_track?.group_id===runId && child.test_track?.spec_sha256===key,'Track run collision; no existing run overwritten');}
      else check(!existsSync(dir) || !!prior,'Unowned track directory collision');
    }
    const now=new Date().toISOString();
    manifest.test_tracks??={version:1,spec_sha256:key,spec,created_at:now,status:'creating',tracks:snapshots.map(({type,run_id,primary,reason})=>({type,run_id,source_refs:primary,reason}))};
    writeJson(manifestPath,manifest);
    for(const t of snapshots) {
      const dir=runDirectory(root,t.run_id);
      if(existsSync(resolve(dir,'manifest.json')))continue;
      for(const folder of ['inputs','analysis','design','execution/playwright','defects','report','audit'])mkdirSync(resolve(dir,folder),{recursive:true});
      for(const file of t.files){const path=resolve(dir,file.path);assertUnlinked(dir,path);if(existsSync(path))check(readRunFile(dir,file.path).sha256===file.sha256,'Interrupted track input differs');else writeFileSync(path,file.data,{flag:'wx'});}
      if(context)writeJson(resolve(dir,contextPath),{...context,run_id:t.run_id,attachments:context.attachments.filter(a=>t.source_paths.includes(a.path)),excluded_attachments:context.attachments.filter(a=>!t.source_paths.includes(a.path)).map(({message_key,source})=>({message_key,source})),warnings:context.warnings??[]});
      const plan={...trackPlan(spec,t.type),planned_at:now};
      const child={manifest_version:3,directory_context:manifest.directory_context,run_id:t.run_id,created_at:now,selected_agents:[],selected_skills:[],asset_refs:[],artifacts:[],test_track:{version:1,type:t.type,label:trackLabels[t.type],group_id:runId,spec_sha256:key,source_refs:t.primary,reason:t.reason},stages:Object.fromEntries(plan.stages.map(s=>[s.id,{status:s.selected?'planned':'skipped',updated_at:now,...(!s.selected?{reason:'未选择此类型的能力'}:{})}])),orchestration:{plan,resume_from:plan.stages.find(s=>s.selected)?.id??'completed',events:[{type:'plan_created',at:now,stages:plan.stages.filter(s=>s.selected).map(s=>s.id),test_type:t.type,group_id:runId}]}};
      if(spec.scope_name)child.delivery={scope_name:spec.scope_name};
      child.status=recomputeRunStatus(child);writeJson(resolve(dir,'manifest.json'),child);
    }
    manifest.test_tracks.status='ready';manifest.status='planned';manifest.updated_at=now;writeJson(manifestPath,manifest);
    return testTrackStatus(root,runId);
  });
}

export function testTrackStatus(root,runId) {
  const manifest=readManifest(root,runId);check(manifest.test_tracks?.version===1,'No test track group');
  const tracks=manifest.test_tracks.tracks.map(t=>{
    const m=readManifest(root,t.run_id);check(m.test_track?.group_id===runId && m.test_track?.spec_sha256===manifest.test_tracks.spec_sha256,'Track identity mismatch');
    const stages=m.orchestration.plan.stages.filter(s=>s.selected);
    const deliveries=[];
    for(const stage of stages) {
      const event=m.orchestration.events.filter(e=>e.stage===stage.id && e.type==='completed').at(-1);
      if(m.stages[stage.id]?.status!=='completed'||!event)continue;
      for(const file of event.evidence?.artifact_contract?.files??[]) {
        if(!ownsDelivery(stage.id,file.path))continue;
        const dir=runDirectory(root,t.run_id),alias=publishedPath(deliveryIdentity(dir,m),stage.id,file);
        if(!alias)continue;
        check(readRunFile(dir,file.path).sha256===file.sha256,'Completed track artifact changed');
        const published=alias && existsSync(resolve(dir,alias));
        if(published)check(readRunFile(dir,alias).sha256===file.sha256,'Published track delivery changed');
        deliveries.push({test_type:t.type,stage:stage.id,path:published?alias:file.path,source_path:file.path,
          absolute_path:resolve(dir,published?alias:file.path),sha256:file.sha256,
          label:alias.split('/').at(-1)});
      }
    }
    const incomplete=stages.filter(s=>m.stages[s.id]?.status!=='completed').map(s=>s.id);
    const executionPath=t.type==='api'?'execution/api/test_results.json':'execution/test_results.json';
    const execution=existsSync(resolve(runDirectory(root,t.run_id),executionPath))?JSON.parse(readRunFile(runDirectory(root,t.run_id),executionPath).data):null;
    return {...t,label:trackLabels[t.type],status:recomputeRunStatus(m),incomplete_stages:incomplete,execution_result:execution?{status:execution.status,summary:execution.summary,untested:execution.coverage?.untested??[]}:null,stages:m.stages,deliveries,dispatch_templates:stages.map(s=>({action:'dispatch',run_id:t.run_id,stage:s.id,agent:s.agent,skills:s.skills})),continuation:{action:'extend_plan',run_id:t.run_id,stages:['report'],reason:'按用户后续请求填写实际能力'}};
  });
  const terminal=tracks.every(t=>Object.values(t.stages).every(s=>['completed','skipped','failed','blocked','cancelled'].includes(s.status)));
  const status=tracks.every(t=>t.status==='completed')?'completed':terminal?'partial':'in_progress';
  return {run_id:runId,status,tracks,completion_message:status==='completed'?'各类型阶段已完成交接；测试结论仍以执行结果为准。':'本次任务部分完成，仍有阶段未交接；不能宣称全流程完成。',starts_execution:false,approval_granted:false,note:'Same user task, separate functional/API artifacts. Continue these run IDs; do not create replacement runs.'};
}

export function trackInstructions(track) {
  if(!track)return '';
  return `本任务属于${track.label}测试链路（test_type=${track.type}），关联任务=${track.group_id}。主要资料=${JSON.stringify(track.source_refs)}；分类依据=${track.reason}。只分析和交付本类型，另一类型由关联子流程独立处理，不将两类测试点、用例、缺陷或报告合并。功能用例execution_layer=ui；接口用例execution_layer=api。测试点也必须标明相同execution_layer；功能用例禁止api_scenario。保留本类型需求→测试点→用例→结果→缺陷→报告关联。标题和最终交付链接标注“${track.label}”；原材料中的其他类型任务不扩大本次职责。缺陷没有证据时交空列表及说明，不凑缺陷；未执行不是通过。只设计时不发业务请求。`;
}

export function assertTrackRows(track,rows,{design=false}={}) {
  if(!track)return;
  const layer=track.type==='api'?'api':'ui';
  for(const row of rows){if(design)check(row.execution_layer===layer,`${track.label}设计条目必须execution_layer=${layer}，不能混入另一类型`);else if(row.layer!==undefined)check(row.layer===layer,'Result layer differs from its test track');if(track.type==='functional')check(row.api_scenario===undefined,'Functional design cannot contain API scenarios');}
}

export function assertTrackStage(manifest,stage) {
  check(!manifest.api_snapshot_report || stage===undefined || stage==='report','Snapshot report runs cannot execute or add other stages; continue the original run');
  check(!manifest.test_tracks,'This is a task group; use its returned typed run IDs');
  const track=manifest.test_track;if(!track)return;
  check(stage!==(track.type==='api'?'execution':'api_execution'),'Execution channel differs from test track');
}

export function assertSiblingResources(root,manifest,stage,keys=[]) {
  if(!manifest.test_track || !['execution','api_execution'].includes(stage))return;
  const group=readManifest(root,manifest.test_track.group_id);
  for(const sibling of group.test_tracks.tracks.filter(t=>t.run_id!==manifest.run_id)) {
    const other=readManifest(root,sibling.run_id);
    for(const event of other.orchestration.events.filter(e=>e.type==='dispatched' && ['execution','api_execution'].includes(e.stage))) {
      const current=other.orchestration.events.filter(e=>e.type==='dispatched' && e.stage===event.stage).at(-1);
      if(event!==current)continue;
      const conflicts=keys.some(key=>(other.stages[event.stage]?.resource_keys??[]).includes(key));
      if(!conflicts)continue;
      const resultPath=event.stage==='api_execution'?'execution/api/test_results.json':'execution/test_results.json';
      let unknown=false;
      if(existsSync(resolve(runDirectory(root,sibling.run_id),resultPath))){const r=JSON.parse(readRunFile(runDirectory(root,sibling.run_id),resultPath).data);unknown=!!r.cases?.some(c=>c.result_unknown)||!!r.unknown_operations?.length;}
      check(other.stages[event.stage]?.status!=='in_progress' && !unknown,'Shared resource is active or has unknown effects in the sibling track; retain original tasks and wait for evidence');
    }
  }
}

const publishedNames={'analysis/requirement_analysis.md':'需求分析.md','design/test_points.xmind':'测试点.xmind','design/test_cases.xlsx':'测试用例.xlsx','report/test_report.html':'测试报告.html'};
function ownsDelivery(stage,path){const prefix={analysis:'analysis/',test_points:'design/test_points.',test_cases:'design/test_cases.',defects:'defects/',report:'report/'}[stage];return prefix && path.startsWith(prefix);}
function deliveryIdentity(dir,manifest) {
  const type=manifest.api_snapshot_report?'api':manifest.test_track?.type ?? (manifest.orchestration?.plan?.execution_branches?.includes('api_execution')?'api':'functional');
  let name=manifest.delivery?.scope_name;
  if(!name)for(const path of ['design/test_cases.json','design/test_points.json','analysis/requirement-ledger.json']) {
    if(!existsSync(resolve(dir,path)))continue;
    const data=JSON.parse(readRunFile(dir,path).data),rows=Array.isArray(data)?data:data.cases??data.test_cases??data.test_points??data.points??data.rules??[];
    const modules=[...new Set(rows.map(r=>r.module).filter(x=>typeof x==='string'&&x.trim()))];
    if(modules.length){name=modules.length===1?modules[0]:modules.slice(0,2).join('与')+(modules.length>2?'等模块':'');break;}
  }
  return {type,label:trackLabels[type]+(manifest.api_snapshot_report?'时点快照':''),scope_name:safeDeliveryScope(name??'当前测试任务')};
}
function publishedPath(identity,stage,file){return ownsDelivery(stage,file.path) && publishedNames[file.path]?`delivery/${stage}/${file.sha256}/${identity.scope_name}${stage==='analysis'||identity.scope_name.endsWith(identity.label)?'':identity.label}${publishedNames[file.path]}`:null;}
export function reportDeliveryTitle(root,runId) {
  const manifest=readManifest(root,runId),identity=deliveryIdentity(runDirectory(root,runId),manifest);
  return identity.scope_name+(identity.scope_name.endsWith(identity.label)?'':identity.label)+'测试报告';
}
export function configureDelivery(root,runId,scopeName) {
  const name=safeDeliveryScope(scopeName),project=JSON.parse(readFileSync(resolve(root,'config/project.json')));
  return withRunLock(root,project,runId,()=>{
    const {manifest,manifestPath}=getRunContext(root,project,runId);
    check(!manifest.test_tracks,'Configure each typed run, or provide scope_name when planning tracks');
    if(manifest.delivery?.scope_name===name)return {scope_name:name};
    check(!manifest.orchestration?.events?.some(e=>e.type==='completed'),'Delivery name is sealed after a completed stage; keep existing delivery links');
    manifest.delivery={scope_name:name};writeJson(manifestPath,manifest);return {scope_name:name};
  });
}
export function publishTrackDelivery(root,runId,stage) {
  const manifest=readManifest(root,runId),track=manifest.test_track;
  const event=manifest.orchestration.events.filter(e=>e.type==='completed' && e.stage===stage).at(-1);
  if(manifest.stages[stage]?.status!=='completed'||!event)return null;
  const dir=runDirectory(root,runId),files=[],identity=deliveryIdentity(dir,manifest);
  for(const f of event.evidence?.artifact_contract?.files??[]) {
    const path=publishedPath(identity,stage,f);if(!path)continue;
    const source=readRunFile(dir,f.path);check(source.sha256===f.sha256,'Track delivery source changed');
    const absolute=resolve(dir,path);assertUnlinked(dir,absolute);mkdirSync(dirname(absolute),{recursive:true});
    if(existsSync(absolute))check(readRunFile(dir,path).sha256===f.sha256,'Published track delivery changed');else writeFileSync(absolute,source.data,{flag:'wx'});
    files.push({test_type:identity.type,label:path.split('/').at(-1),path,absolute_path:absolute,sha256:f.sha256,source_path:f.path,markdown_link:`[${path.split('/').at(-1)}](<${absolute.replaceAll('\\','/')}>)`});
  }
  return {test_type:identity.type,scope_name:identity.scope_name,group_id:track?.group_id,files,user_message:files.length?files.map(f=>f.markdown_link).join(' · '):'本阶段执行结果及缺陷将汇入对应类型的 HTML 测试报告。',instruction:'向用户直接使用这些命名后的链接。内部 JSON、test_xxx、执行清单和缺陷中间文件不作为默认交付；报告只交付 HTML，不交付 Word/PDF。'};
}
