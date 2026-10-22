import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRunFile } from './design-quality.mjs';
import { readSession, findParentDispatch } from './stage-evidence.mjs';
import { ownerHasExited } from './process-identity.mjs';

export function inspectApiHumanAction(workspace,parent,runId,agentRoot) {
  const dir=resolve(workspace,'output/runs',runId),path='execution/api/human-action.json';
  if(!existsSync(resolve(dir,path))) return null;
  if(realpathSync(dir)!==dir) throw new Error('Redirected API task');
  const read=p=>JSON.parse(readRunFile(dir,p).data),manifest=read('manifest.json'),card=read(path);
  if(!card.worker_pid || ownerHasExited(card.worker_pid,card.process_identity)) return null;
  const dispatch=manifest.orchestration?.events?.filter(e=>e.stage==='api_execution' && e.type==='dispatched').at(-1);
  if(card.status!=='waiting_human' || card.parent_session!==parent || card.dispatch_id!==dispatch?.dispatch_id || manifest.stages?.api_execution?.status!=='in_progress' || !card.child_session || !/^[a-f0-9-]{36}$/.test(card.action_id)) return null;
  const rows=readSession(agentRoot,'test_agent',parent),meta=rows.find(r=>r.type==='session_meta')?.payload;
  if(meta?.session_id!==parent || resolve(meta.workspace??'')!==resolve(workspace)) return null;
  if(!findParentDispatch(rows,{runId,agent:dispatch.agent,childId:card.child_session,dispatchedAt:dispatch.at,dispatchId:dispatch.dispatch_id,commandPolicy:dispatch.child_command_policy,parallel:true})) return null;
  const child=readSession(agentRoot,dispatch.agent,card.child_session).find(r=>r.type==='session_meta')?.payload;
  if(child?.source!=='subagent' || resolve(child.workspace??'')!==resolve(workspace)) return null;
  const receiptFile=`audit/human-actions/${card.action_id}.json`,receipt=existsSync(resolve(dir,receiptFile))?read(receiptFile):null;
  return {...card,agent:dispatch.agent,status:receipt?.status??card.status,decision:receipt?.decision??null};
}
