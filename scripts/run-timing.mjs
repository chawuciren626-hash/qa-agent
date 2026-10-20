import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { intervalUnion, profileAgentTrace } from './profile-agent-trace.mjs';
import { summarizeBrowserPerformance, summarizeHumanHandoff } from './browser-performance.mjs';

const sessionId=value=>typeof value==='string' && /^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(value);
const number=value=>typeof value==='number' && Number.isFinite(value) && value>=0;
const duration=spans=>intervalUnion(spans).reduce((total,[start,end])=>total+end-start,0);

export function correlateRunTiming({owner,sessions,commands=[],actions=[],receipts=[],human}) {
  const model=new Map(),tools=new Map(),calls=new Set(),profiles=[],seenSessions=new Set();let invalid=0;
  const add=(map,key,start,end)=>{if(!map.has(key)) map.set(key,[]);map.get(key).push([start,end]);};
  for(const {id,rows} of sessions) {
    if(!sessionId(id) || seenSessions.has(id)) continue;seenSessions.add(id);
    const begins=new Map(),toolStarts=new Map();
    const owned=rows.filter(row=>row?.qa_timing?.version===1 && row.qa_timing.owner_session_id===owner && row.qa_timing.session_id===id && typeof row.qa_timing.process_id==='string' && /^[a-f0-9-]{36}$/.test(row.qa_timing.process_id) && number(row.qa_timing.offset_ms));
    profiles.push({session_id:id,...profileAgentTrace(rows)});
    for(const row of owned) {
      const p=row.payload ?? {},t=row.qa_timing,process=t.process_id;
      if(p.type==='request_begin') begins.set(`${process}:${t.request_id}`,t.offset_ms);
      if(p.type==='request_end') {
        const key=`${process}:${t.request_id}`,start=begins.get(key);begins.delete(key);
        if(start!==undefined && number(t.model_request_ms) && Math.abs(t.offset_ms-start-t.model_request_ms)<0.01) add(model,process,start,t.offset_ms);else invalid++;
      }
      if(p.type==='tool_call' && typeof p.tool_call_id==='string') {calls.add(`${id}:${p.tool_call_id}`);toolStarts.set(`${process}:${p.tool_call_id}`,t.offset_ms);}
      if(p.type==='tool_call_output') {
        const key=`${process}:${p.tool_call_id}`,start=toolStarts.get(key);toolStarts.delete(key);
        if(start!==undefined && number(t.tool_total_ms) && Math.abs(t.offset_ms-start-t.tool_total_ms)<0.01) add(tools,process,start,t.offset_ms);else invalid++;
      }
    }
  }
  const linked=row=>row?.host_binding && calls.has(`${row.host_binding.session_id}:${row.host_binding.tool_call_id}`);
  const commandMap=new Map();
  for(const command of commands) if(linked(command) && typeof command.command_id==='string') commandMap.set(command.command_id,command);
  const queues=actions.filter(linked).filter(row=>number(row.timing?.queue_wait_ms));
  const unique=new Map();for(const receipt of receipts) if(commandMap.has(receipt.command_id) && receipt.status==='completed' && !unique.has(receipt.request_id)) unique.set(receipt.request_id,receipt);
  const sum=map=>map.size?[...map.values()].reduce((total,spans)=>total+duration(spans),0):null;
  return {version:1,status:model.size || tools.size?'observed':'not_recorded',sessions:profiles,
    model_request_union_ms:sum(model),tool_union_ms:sum(tools),process_epochs:new Set([...model.keys(),...tools.keys()]).size,
    linked_commands:commandMap.size,unlinked_commands:commands.length-commandMap.size,
    measured_queue_actions:queues.length,queue_wait_sum_ms:queues.length?queues.reduce((sum,row)=>sum+row.timing.queue_wait_ms,0):null,
    linked_browser_receipts:unique.size,browser:summarizeBrowserPerformance([...unique.values()]),human:summarizeHumanHandoff(human),invalid_intervals:invalid,
    pure_inference_ms:null,cost:null,
    interpretation:'Snapshot through report preparation. Host request envelopes include provider/network and orchestration, not pure inference. Parent/child intervals union within the same monotonic process epoch; separate restarts cannot be aligned. Tool, queue, browser and human spans overlap; never sum categories into wall time. Queue sum is per-action waiting, not a union. Only bound command IDs link browser facts; missing legacy correlation stays unknown. Report generation after this snapshot is excluded.'};
}

export function collectRunTiming(dir,manifest,{agentRoot=process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(),'.penguin/data/default_project/agents')}={}) {
  const events=manifest.orchestration?.events ?? [],owner=events.find(e=>sessionId(e['parent-session-id']))?.['parent-session-id'];
  if(!owner) return null;
  const specs=new Map([[owner,'test_agent']]);
  for(const e of events) if(e['parent-session-id']===owner && sessionId(e['session-id']) && /^[a-z0-9_]+$/.test(e.agent ?? '')) specs.set(e['session-id'],e.agent);
  // Completed events may omit agent; recover it only from the matching dispatch.
  for(const e of events) if(sessionId(e['session-id'])) {
    const dispatch=events.find(d=>d.type==='dispatched' && d.dispatch_id===(e.dispatch_id ?? e['dispatch-id']) && d['parent-session-id']===owner);
    if(dispatch && /^[a-z0-9_]+$/.test(dispatch.agent ?? '')) specs.set(e['session-id'],dispatch.agent);
  }
  const sessions=[],commands=[],actions=[],receipts=[];
  let unavailable=0;
  const read=path=>{if(realpathSync(path)!==resolve(path) || statSync(path).size>16*1024*1024) throw new Error();return readFileSync(path,'utf8');};
  for(const [id,agent] of specs) try {
    const base=resolve(agentRoot,agent,'traces',id.slice(8,18));
    const rows=readdirSync(base).filter(name=>name.startsWith(id+'_') && /_\d{3}\.jsonl$/.test(name)).sort().flatMap(name=>read(resolve(base,name)).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)));
    const meta=rows.find(row=>row.type==='session_meta')?.payload;
    if(meta?.session_id!==id || resolve(meta.agent_state ?? '')!==resolve(agentRoot,agent,'agent_state')) throw new Error();
    const since=Date.parse(manifest.created_at);
    sessions.push({id,rows:Number.isFinite(since)?rows.filter(row=>row.type==='session_meta' || Date.parse(row.timestamp)>=since):rows});
  } catch {unavailable++;}
  const list=(base,fn)=>{if(!existsSync(base)) return;for(const name of readdirSync(base)) try {fn(name);} catch {unavailable++;}};
  list(resolve(dir,'audit/commands'),name=>{if(/^[a-f0-9-]{36}$/.test(name)) {const row=JSON.parse(read(resolve(dir,'audit/commands',name,'command.json')));if(row.run_id===manifest.run_id) commands.push(row);}});
  list(resolve(dir,'../../action-audit',owner),name=>{if(/^[a-f0-9-]{36}\.json$/.test(name)) {const row=JSON.parse(read(resolve(dir,'../../action-audit',owner,name)));if(row.run_id===manifest.run_id && row.session_id===owner) actions.push(row);}});
  let state;
  try {state=JSON.parse(read(resolve(dir,'execution/browser-state.json')));} catch {}
  list(resolve(dir,'execution/browser-evidence'),name=>{
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(name)) return;
    const row=JSON.parse(read(resolve(dir,'execution/browser-evidence',name)));
    if(row.run_id===manifest.run_id && state?.run_id===manifest.run_id && row.invocation_id===state.invocation_id && row.dispatch_id===state.dispatch_id && name===row.request_id+'.json') receipts.push(row);
  });
  return {...correlateRunTiming({owner,sessions,commands,actions,receipts,human:state?.human_handoff_timing}),unavailable_sources:unavailable,
    scope:'Associated sessions during the run window, not exclusive attribution when a controller handles concurrent runs. Intervals crossing the window start are omitted, not guessed.'};
}
