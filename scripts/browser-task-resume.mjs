import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { assertParentSession, resolveDispatchedChild, readSession } from './stage-evidence.mjs';
import { browserLifecycle } from './browser-lifecycle.mjs';

export function nativeBrowserContinuation(rows, waitingAt) {
  const latest=rows.filter(r=>r.type==='model_msg' && r.payload?.role==='user' && r.payload?.type==='text' && r.payload.sender!=='harness' && typeof r.payload.text==='string' && r.payload.text.trim() && !/^\s*\[(?:Tool Result|System|Internal|Subagent)/i.test(r.payload.text)).at(-1);
  if(!latest || !(Date.parse(latest.timestamp)>Date.parse(waitingAt))) return false;
  const value=latest.payload.text;
  if(/暂停|停止|取消|不要(?:继续|执行|恢复|测试)|还没|未完成|尚未|\b(?:stop|cancel|wait|not yet)\b|\b(?:don't|do not)\s+(?:continue|resume|run|test)\b/i.test(value)) return false;
  return /继续|已登录|完成|好了|可以了|\b(?:resume|continue|done|completed|logged in|verified)\b/i.test(value);
}

export function browserWaiting(root,runId,manifest) {
  if((manifest.orchestration?.plan?.workflow_mode!=='task' && !browserLifecycle(manifest)) || manifest.stages?.execution?.status!=='in_progress') return null;
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
  if(waiting.human_protocol===1) throw new Error('Use the human action card or reply 已登录. The host resumes the original child and dispatch; do not redispatch or mark the task completed.');
  const rows=assertParentSession(root,runId,parent,agentRoot);
  if(!nativeBrowserContinuation(rows,waiting.waiting_at)) throw new Error('Wait for the actual user response confirming continuation; no technical unlock approval is needed');
  const child=resolveDispatchedChild(root,runId,'execution',parent,agentRoot);
  const trace=readSession(agentRoot,child.agent,child.child_session);
  const end=trace.filter(r=>['request_begin','request_end'].includes(r.payload?.type)).at(-1);
  if(end?.payload.type!=='request_end' || end.payload.status!=='completed') throw new Error('Previous browser child has not returned');
  return {resumes_dispatch_id:waiting.dispatch_id,human_kind:waiting.human_kind,child_session:child.child_session,waiting_command_id:waiting.waiting_command_id};
}
