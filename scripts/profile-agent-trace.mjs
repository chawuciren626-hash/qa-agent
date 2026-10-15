import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function intervalUnion(intervals) {
  const merged=[];
  for(const [start,end] of intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>=a).sort((a,b)=>a[0]-b[0])) {
    const last=merged.at(-1);
    if(last && start<=last[1]) last[1]=Math.max(last[1],end);
    else merged.push([start,end]);
  }
  return merged;
}
const duration=intervals=>intervalUnion(intervals).reduce((sum,[a,b])=>sum+b-a,0);
const overlap=(a,b)=>duration(a.flatMap(([x,y])=>b.map(([u,v])=>[Math.max(x,u),Math.min(y,v)]).filter(([s,e])=>e>=s)));

export function profileAgentTrace(rows) {
  const ordered=rows.map((row,i)=>({row,i,t:Date.parse(row.timestamp)})).filter(r=>Number.isFinite(r.t)).sort((a,b)=>a.t-b.t||a.i-b.i);
  const requests=[],tools=[],pending=new Map(),byTool={},models=new Map(),warnings=[];
  let requestStart=null,requestCount=0,usageCount=0,failedTools=0;
  const tokens={};
  for(const {row,t} of ordered) {
    const p=row.payload??{};
    if(row.type==='session_meta') {
      const model={provider:p.provider??null,model_id:p.model_id??null,context_window:p.model_context_window??null};
      models.set(JSON.stringify(model),model);
    }
    if(p.type==='request_begin') {
      if(requestStart!==null) warnings.push('unclosed_request');
      requestStart=t;requestCount++;
    }
    if(p.type==='request_end') {
      if(requestStart!==null) requests.push([requestStart,t]);
      else warnings.push('request_end_without_begin');
      requestStart=null;
    }
    if(p.type==='token_usage' && p.request && typeof p.request==='object') {
      usageCount++;
      // Do not sum cumulative session usage, or assume provider token categories are disjoint.
      for(const key of ['input','output','cache_read','cache_write','reasoning','total']) {
        const n=p.request[key];
        if(Number.isFinite(n)&&n>=0) tokens[key]=(tokens[key]??0)+n;
      }
    }
    if(p.type==='tool_call') {
      if(pending.has(p.tool_call_id)) warnings.push('duplicate_pending_tool_id');
      pending.set(p.tool_call_id,{start:t,name:p.name??'unknown'});
    }
    if(p.type==='tool_call_output') {
      const call=pending.get(p.tool_call_id);
      if(!call) {warnings.push('tool_output_without_call');continue;}
      pending.delete(p.tool_call_id);
      const item=byTool[call.name]??={calls:0,failed_stop:0,intervals:[]};
      item.calls++;item.intervals.push([call.start,t]);tools.push([call.start,t]);
      if(['fatal','aborted'].includes(p.stop_reason)) {item.failed_stop++;failedTools++;}
    }
  }
  if(requestStart!==null) warnings.push('unclosed_request');
  if(pending.size) warnings.push('unfinished_tools');
  const requestIntervals=intervalUnion(requests),toolIntervals=intervalUnion(tools);
  const wall=ordered.length?ordered.at(-1).t-ordered[0].t:0;
  const covered=duration([...requestIntervals,...toolIntervals]);
  return {version:1,models:[...models.values()],wall_ms:wall,requests:requestCount,completed_request_intervals:requests.length,
    request_envelope_ms:duration(requestIntervals),tool_wall_ms:duration(toolIntervals),
    request_without_tools_ms:duration(requestIntervals)-overlap(requestIntervals,toolIntervals),
    outside_recorded_request_and_tools_ms:Math.max(0,wall-covered),
    tool_calls:tools.length,failed_tool_stops:failedTools,
    by_tool:Object.fromEntries(Object.entries(byTool).map(([name,v])=>[name,{calls:v.calls,failed_stop:v.failed_stop,wall_ms:duration(v.intervals)}])),
    request_usage_records:usageCount,reported_tokens:usageCount?tokens:null,warnings:[...new Set(warnings)],
    interpretation:'Per-session intervals only. Request-without-tools includes model, network and orchestration time, not pure inference or TTFT. Parent run_subagent waits overlap child execution; do not add session wall times. Tool failures count fatal/aborted stops, not every business or structured error. Token fields are provider-reported; missing is unknown, not zero. No prompts, reasoning text, tool arguments or outputs are retained.'};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [input,output,...extra]=process.argv.slice(2);
  if(!input||!output||extra.length||resolve(input)===resolve(output)) throw new Error('Usage: node scripts/profile-agent-trace.mjs <trace.jsonl> <new-summary.json>');
  const rows=readFileSync(input,'utf8').split(/\r?\n/).filter(s=>s.trim()).map(s=>JSON.parse(s));
  const profile=profileAgentTrace(rows);
  writeFileSync(output,JSON.stringify(profile,null,2),{flag:'wx'});
  console.log(JSON.stringify({output:resolve(output),requests:profile.requests,warnings:profile.warnings}));
}
