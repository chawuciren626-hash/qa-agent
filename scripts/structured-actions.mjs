import { readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withControllerSession, readControllerSession, ControllerGateError } from './controller-command-session.mjs';
import { assertParentSession } from './stage-evidence.mjs';
import { runProjectCommand } from './command-runtime.mjs';
import { CommandUsageError } from './command-contracts.mjs';
import { writeJson } from './orchestration-state.mjs';

const definitions = {
  create_run: ['run_id'], plan_run: ['run_id','stages'], run_status: ['run_id'],
  archive_input: ['run_id','name','source','text'],
  dispatch: ['run_id','stage','agent','skills','mode'],
  complete: ['run_id','stage','dispatch_id','child_session','artifacts'],
  block: ['run_id','stage','dispatch_id','reason'], fail: ['run_id','stage','dispatch_id','reason'],
  request_confirmation: ['run_id','stage'], resolve_confirmation: ['run_id','stage','decision','reason'],
  generate_analysis: ['run_id'], validate_analysis: ['run_id']
};
const hash = data => createHash('sha256').update(data).digest('hex');
const requireInput = (ok, message) => { if (!ok) throw new CommandUsageError(message); };
export function actionCatalog() {
  return { status: 'help', actions: definitions, request_format: { action: 'plan_run', run_id: 'run-example', stages: ['analysis'] },
    invocation: 'node scripts/project-action.mjs execute --controller-session=<parent_session> --request=<JSON-file>',
    notes: ['Only listed fields accepted; stages/skills/artifacts are arrays', 'archive_input requires exactly one of source/text', 'No automatic retries, approvals or session review'] };
}
function validate(request) {
  requireInput(request && !Array.isArray(request) && typeof request === 'object', 'Request must be an object');
  requireInput(Object.hasOwn(definitions, request.action), 'Unknown action');
  requireInput(Object.keys(request).every(k => k === 'action' || definitions[request.action].includes(k)), 'Unknown action field');
  requireInput(/^run-[A-Za-z0-9-]+$/.test(request.run_id ?? ''), 'Valid run_id required');
  for (const key of definitions[request.action]) {
    if (['mode','source','text'].includes(key)) continue;
    const v = request[key];
    requireInput(['stages','skills','artifacts'].includes(key) ? Array.isArray(v) && v.length && v.every(s => typeof s === 'string' && s.trim() && !s.includes(',')) : typeof v === 'string' && v.trim(), `Invalid or missing ${key}`);
  }
  if (request.mode !== undefined) requireInput(request.mode === 'prepare', 'Only explicit prepare mode is supported');
}
export function actionCommand(request, session) {
  validate(request);
  const r=request; const id=r.run_id;
  const event = { dispatch:'dispatched', complete:'completed', block:'blocked', fail:'failed' }[r.action];
  if (event) {
    const args=[id,event,`--stage=${r.stage}`,`--parent-session-id=${session}`];
    for (const [field,flag] of [['agent','agent'],['skills','skills'],['mode','mode'],['dispatch_id','dispatch-id'],['child_session','session-id'],['artifacts','artifacts'],['reason','reason']]) {
      if (r[field] !== undefined) args.push(`--${flag}=${Array.isArray(r[field]) ? r[field].join(',') : r[field]}`);
    }
    return { script:'record-orchestration-event.mjs',args };
  }
  const commands={
    create_run:['create-run.mjs',[`--run-id=${id}`]],
    plan_run:['plan-run.mjs',[`--run-id=${id}`,`--stages=${r.stages?.join(',')}`]],
    run_status:['show-run-status.mjs',[id]],
    request_confirmation:['request-stage-confirmation.mjs',[id,r.stage]],
    resolve_confirmation:['resolve-stage-confirmation.mjs',[id,r.stage,r.decision,r.reason]],
    generate_analysis:['generate-analysis-markdown.mjs',[id]],
    validate_analysis:['validate-artifacts.mjs',[id,'analysis']]
  };
  const command=commands[r.action]; return command ? {script:command[0],args:command[1]} : null;
}
function inside(base, path) {
  const rel=relative(base,path); return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}
function archive(root, r) {
  requireInput(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.name), 'Input name must be a basename');
  requireInput((r.source !== undefined) !== (r.text !== undefined), 'Exactly one source or text required');
  const dir=resolve(root,'output/runs',r.run_id,'inputs');
  requireInput(realpathSync(dir) === dir && existsSync(resolve(dir,'../manifest.json')), 'Existing non-linked run inputs required');
  let bytes;
  if (r.source !== undefined) {
    requireInput(typeof r.source === 'string', 'source must be a project path');
    const path=realpathSync(resolve(root,r.source));
    requireInput(['inputs','acceptance'].some(folder => inside(resolve(root,folder),path)), 'Source must be inside project inputs or acceptance');
    bytes=readFileSync(path);
  } else { requireInput(typeof r.text === 'string' && r.text.trim(), 'text must be nonempty'); bytes=Buffer.from(r.text); }
  const path=resolve(dir,r.name); writeFileSync(path,bytes,{flag:'wx'});
  return {status:'completed',exit_code:0,execution_mode:'in_process',launches_child:false,result:{path:`inputs/${r.name}`,sha256:hash(bytes),source:r.source ?? 'literal_request_text'}};
}
function auditDir(root,session) {
  requireInput(/^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(session ?? ''), 'Valid controller session required');
  return resolve(root,'output/action-audit',session);
}
export async function executeAction(root,session,loadRequest,{agentRoot,signal}={}) {
  assertParentSession(root,'run-command-session',session,agentRoot);
  const dir=auditDir(root,session); mkdirSync(dir,{recursive:true});
  const path=resolve(dir,`${randomUUID()}.json`);
  const receipt={version:1,session_id:session,at:new Date().toISOString(),status:'started',action:null,request_sha256:null};
  writeJson(path,receipt);
  let parsed; let parseError;
  try { const raw=loadRequest(); receipt.request_sha256=hash(raw); parsed=JSON.parse(raw); receipt.action=typeof parsed?.action === 'string' && Object.hasOwn(definitions,parsed.action) ? parsed.action : null; }
  catch(error) { parseError=error; }
  try {
    const result=await withControllerSession(root,session,async()=>{
      if (parseError) throw new CommandUsageError(`Request unreadable: ${parseError.message}`);
      const command=actionCommand(parsed,session);
      if (parsed.action === 'archive_input') return archive(root,parsed);
      const output=await runProjectCommand(root,{kind:'node',...command,signal});
      if (output.status === 'completed') {
        try { output.data=JSON.parse(output.output_tail); } catch { output.data=null; output.data_note='Read full command log; no inferred result'; }
      }
      return output;
    },{agentRoot,diagnostic:['run_status','block','fail'].includes(receipt.action)});
    Object.assign(receipt,{status:result.status,exit_code:result.exit_code,classification:result.exit_code === 0 ? 'completed' : 'script_failure',command_evidence:result.evidence_dir ?? null});
    return {...result,action_receipt:path};
  } catch(error) {
    Object.assign(receipt,{status:'rejected',exit_code:2,classification:error instanceof ControllerGateError ? error.code : error instanceof CommandUsageError ? 'input_rejected' : 'runner_error',error:error.message});
    return {...receipt,next_action:'stop_and_request_review',action_receipt:path};
  } finally { receipt.finished_at=new Date().toISOString(); writeJson(path,receipt); }
}
export function actionFailureSummary(root,session) {
  const state=readControllerSession(root,session); const dir=auditDir(root,session);
  const records=existsSync(dir) ? readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(resolve(dir,n)))).sort((a,b)=>a.at.localeCompare(b.at)) : [];
  if (records.some(r=>r.session_id !== session)) throw new Error('Audit session mismatch');
  const denied=records.filter(r=>r.classification === 'session_stopped').length;
  return {status:'ready',session_status:state.status,session_sha256:state.sha256,current_failure:state.failure ?? null,
    action_attempts:records.length,blocked_after_stop:denied,incomplete_attempts:records.filter(r=>r.status === 'started').length,
    failures:records.filter(r=>r.status !== 'completed').map(r=>({action:r.action,at:r.at,classification:r.classification ?? 'unknown',error:r.error ?? null,command_evidence:r.command_evidence ?? null})),
    coverage:'Structured action receipts only; direct CLI and other tools are not fully covered; zero is not proof of no retry',
    user_summary:`会话状态：${state.status}。结构化动作记录${records.length}次，停止后被拒绝${denied}次。此统计不覆盖直接CLI及其他工具，不能据此声称从未重试。`};
}
