import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { assertParentSession, resolveDispatchedChild, readSession } from './stage-evidence.mjs';

export function browserWaiting(root,runId,manifest) {
  if(manifest.orchestration?.plan?.workflow_mode!=='task' || manifest.stages?.execution?.status!=='in_progress') return null;
  const dir=runDirectory(root,runId), path=resolve(dir,'execution/browser-state.json');
  if(!existsSync(path)) return null;
  const state=JSON.parse(readRunFile(dir,'execution/browser-state.json').data);
  const dispatch=manifest.orchestration.events.filter(e=>e.type==='dispatched' && e.stage==='execution').at(-1);
  if(state.status!=='waiting_human' || state.dispatch_id!==dispatch?.dispatch_id || !/^[a-f0-9-]{36}$/.test(state.waiting_command_id ?? '')) return null;
  const base=`audit/commands/${state.waiting_command_id}`;
  const command=JSON.parse(readRunFile(dir,`${base}/command.json`).data), result=JSON.parse(readRunFile(dir,`${base}/command.log`).data);
  if(command.script!=='browser-task.mjs' || command.run_id!==runId || command.status!=='completed' || command.result?.termination_confirmed!==true || result.status!=='waiting_human' || result.question!==state.question) return null;
  return state;
}

export function assertBrowserResume(root,runId,manifest,parent,agentRoot=process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(),'.penguin/data/default_project/agents')) {
  const waiting=browserWaiting(root,runId,manifest);
  if(!waiting) throw new Error('No verified human-waiting browser task; do not use resume for failures');
  const rows=assertParentSession(root,runId,parent,agentRoot);
  if(!rows.some(r=>r.payload?.role==='user' && r.payload?.type==='text' && Date.parse(r.timestamp)>Date.parse(waiting.waiting_at))) throw new Error('Wait for the actual user response; no technical unlock approval is needed');
  const child=resolveDispatchedChild(root,runId,'execution',parent,agentRoot);
  const trace=readSession(agentRoot,child.agent,child.child_session);
  const end=trace.filter(r=>['request_begin','request_end'].includes(r.payload?.type)).at(-1);
  if(end?.payload.type!=='request_end' || end.payload.status!=='completed') throw new Error('Previous browser child has not returned');
  return {resumes_dispatch_id:waiting.dispatch_id,human_kind:waiting.human_kind,child_session:child.child_session,waiting_command_id:waiting.waiting_command_id};
}
