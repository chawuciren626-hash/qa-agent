import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { assertParentSession, readSession, recordedChildHandle, resolveDispatchedChild } from './stage-evidence.mjs';
import { assertArtifactContract, stageRequiredArtifacts } from './artifact-contracts.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const same = (a,b) => a && b && resolve(a) === resolve(b);
const after = (a,b) => Number.isFinite(Date.parse(a)) && Date.parse(a) > Date.parse(b);

// Explicit engineering recovery for a report whose original child was interrupted.
// This is never evidence that the child returned successfully.
export function verifyInterruptedReportRecovery(root, runId, manifest, parentId, artifacts, agentRoot = process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents')) {
  if (manifest.stages?.report?.status !== 'in_progress') throw new Error('Interrupted report recovery requires an active report');
  const dispatch = manifest.orchestration?.events?.filter(e => e.type === 'dispatched' && e.stage === 'report').at(-1);
  if (!dispatch || dispatch['parent-session-id'] !== parentId) throw new Error('Report dispatch owner mismatch');
  const child = resolveDispatchedChild(root, runId, 'report', parentId, agentRoot, {includeInterrupted:true});
  if (child.outcome !== 'interrupted' || child.completion_verified !== false) throw new Error('Original report child was not verified interrupted');
  const parent = assertParentSession(root, runId, parentId, agentRoot);
  if (recordedChildHandle(parent, dispatch, runId).subagent_id) throw new Error('Original child still has a recorded continuation handle');
  const childRows = readSession(agentRoot, dispatch.agent, child.child_session);
  const abort = childRows.filter(r => r.type === 'event_msg' && r.payload?.type === 'abort').at(-1);
  if (!abort || abort.payload?.error_code!=='user_abort') throw new Error('Child trace lacks a verified user interruption');
  const run = runDirectory(root, runId);
  const required = stageRequiredArtifacts(root, runId, 'report');
  if (!required?.length || required.some(path => !artifacts.includes(path))) throw new Error('Report completion list lacks required artifacts');
  const contract = assertArtifactContract(root, runId, 'report', {mode:'execute', artifacts});
  const generations = resolve(run, 'audit/artifact-generations');
  const exports = readdirSync(generations, {withFileTypes:true}).filter(x => x.isDirectory()).flatMap(x => {
    try { const value=json(resolve(generations,x.name,'generation.json')); return value.action==='export_report' && value.run_id===runId && value.dispatch_id===dispatch.dispatch_id && value.parent_session===parentId && value.status==='completed' ? [{id:x.name,value}]:[]; }
    catch { return []; }
  });
  const selected = exports.filter(({value}) => value.after?.length===2 && value.after.every(file => ['report/test_report.html','report/test_cases.xlsx'].includes(file.path) && readRunFile(run,file.path).sha256===file.sha256) && value.before?.some(file=>file.path==='report/test_report.md' && file.sha256===readRunFile(run,file.path).sha256)).at(-1);
  if (!selected) throw new Error('No matching controlled report export with current file hashes');
  const exportCommand = json(resolve(selected.value.command_evidence,'command.json'));
  if (!same(resolve(run,'audit/commands'),resolve(selected.value.command_evidence,'..')) || exportCommand.status!=='completed' || exportCommand.result?.code!==0 || !after(exportCommand.finished_at,abort.timestamp)) throw new Error('Report export command is not a successful post-interruption command');
  const auditDir=resolve(run,'../../action-audit',parentId);
  const audits=readdirSync(auditDir).filter(name=>/^[a-f0-9-]+\.json$/.test(name)).flatMap(name=>{
    try {const value=json(resolve(auditDir,name));return value.action==='validate_artifacts' && value.run_id===runId && value.session_id===parentId && value.status==='completed' && value.exit_code===0 && value.host_binding?.session_id===parentId ? [{name,value}]:[];} catch{return [];}
  });
  const verified=audits.find(({name,value})=>{
    if(!after(value.finished_at,exportCommand.finished_at)) return false;
    const binding=value.host_binding;
    const call=parent.find(r=>r.payload?.type==='tool_call' && r.payload.tool_call_id===binding.tool_call_id);
    const output=parent.find(r=>r.payload?.type==='tool_call_output' && r.payload.tool_call_id===binding.tool_call_id);
    if(!call || !output || output.payload.status!=='completed' || !after(output.timestamp,exportCommand.finished_at)) return false;
    let args,receipt,command,log;
    try {
      args=typeof call.payload.arguments==='string'?JSON.parse(call.payload.arguments):call.payload.arguments;
      receipt=JSON.parse(output.payload.output);
      command=json(resolve(value.command_evidence,'command.json'));
      log=json(resolve(value.command_evidence,'command.log'));
    } catch {return false;}
    if(args?.qa_request?.action!=='validate_artifacts' || args.qa_request.run_id!==runId || args.qa_request.stage!=='report' || receipt.command_id!==command.command_id || receipt.status!=='completed' || receipt.exit_code!==0) return false;
    if(!same(receipt.action_receipt,resolve(auditDir,name)) || !same(receipt.evidence_dir,value.command_evidence) || !same(value.command_evidence,resolve(run,'../../command-runs',command.command_id))) return false;
    if(command.script!=='validate-artifacts.mjs' || command.status!=='completed' || command.result?.code!==0 || command.host_binding?.tool_call_id!==binding.tool_call_id || log.run_id!==runId || log.stage!=='report' || log.status!=='passed' || log.errors?.length) return false;
    return contract.files.every(file=>log.files?.some(row=>row.path===file.path && row.sha256===file.sha256));
  });
  if(!verified) throw new Error('No parent controller success receipt validates the current report after export');
  return {kind:'interrupted_report',original_child_outcome:'interrupted',child_session_id:child.child_session,dispatch_id:dispatch.dispatch_id,export_audit:`audit/artifact-generations/${selected.id}/generation.json`,validation_audit:`../../action-audit/${parentId}/${verified.name}`,validated_at:verified.value.finished_at,product_actions_replayed:false,completion_claimed:false};
}
