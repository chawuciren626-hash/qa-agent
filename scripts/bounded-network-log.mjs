import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJson } from './orchestration-state.mjs';

export function boundedNetworkLog(dir,{window=500,limit=10000,interval=32}={}) {
  const events=[];let total=0,dirty=0,errors=0;
  const flush=()=>{
    if(!dirty) return;
    try {writeJson(resolve(dir,'browser-network.json'),{version:1,events,total_events:total,retained_events:events.length,dropped_from_window:Math.max(0,total-events.length),journal_events:Math.min(total,limit),journal_truncated:total>limit,write_errors:errors});dirty=0;}
    catch {errors++;}
  };
  return {events,flush,add(row) {
    total++;dirty++;events.push({...row,sequence:total});if(events.length>window) events.shift();
    if(total<=limit) try {appendFileSync(resolve(dir,'browser-network.jsonl'),JSON.stringify({version:1,...events.at(-1)})+'\n');} catch {errors++;}
    if(dirty>=interval) flush();
  },summary:()=>({total_events:total,journal_truncated:total>limit,write_errors:errors})};
}
