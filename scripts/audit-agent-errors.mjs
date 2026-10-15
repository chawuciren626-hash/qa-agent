import { dataPath } from './directory-context.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readSession } from './stage-evidence.mjs';
import { writeJson } from './orchestration-state.mjs';

const root=resolve(import.meta.dirname,'..');
const [parent]=process.argv.slice(2);
const agentRoot=process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(),'.penguin/data/default_project/agents');
const sessions=[{agent:'test_agent',id:parent}];
const categories=[
  ['session_gate',/Controller session stopped|Correction budget exhausted/],
  ['source_contract',/invalid source kind|invalid category/],
  ['citation_mismatch',/source snapshot changed or quote missing/],
  ['argument_contract',/input_rejected|positional run_id|Invalid preparation mode|Exactly one source|Only explicit prepare/],
  ['existing_plan',/运行计划已存在/],
  ['module_path',/ERR_MODULE_NOT_FOUND/],
  ['inline_script',/SyntaxError/],
  ['command_length',/ENAMETOOLONG/],
  ['edit_mismatch',/old_string not found/],
  ['missing_path',/No such file|cannot access|does not exist|ENOENT|File not found/]
];
const report={parent_session:parent,scope:'Structured tool outputs in parent and linked child traces; no model reasoning or inferred success',sessions:[],failures:[],warning_outputs:0};
for (let index=0;index<sessions.length;index++) {
  const session=sessions[index];
  const rows=readSession(agentRoot,session.agent,session.id);
  const calls=new Map(); let spawn;
  for (const row of rows) {
    const p=row.payload;
    if (p?.type==='tool_call') {
      let args; try {args=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;} catch {args={};}
      calls.set(p.tool_call_id,{name:p.name,args});
      if (p.name==='run_subagent') spawn={agent:args.agent_id ?? session.agent};
    }
    if (p?.type==='subagent' && spawn && !sessions.some(s=>s.id===p.session_id)) sessions.push({...spawn,id:p.session_id});
    if (p?.type!=='tool_call_output') continue;
    const raw=typeof p.output==='string'?p.output:JSON.stringify(p.output);
    if (/\/etc\/profile/.test(raw)) report.warning_outputs++;
    if (p.stop_reason!=='fatal') continue;
    const [category]=categories.find(([,pattern])=>pattern.test(raw)) ?? ['other_tool_failure'];
    report.failures.push({session_id:session.id,agent:session.agent,at:row.timestamp,tool_call_id:p.tool_call_id,tool:calls.get(p.tool_call_id)?.name ?? 'unknown',category});
  }
  report.sessions.push({...session,rows:rows.length});
}
report.counts=Object.fromEntries([...new Set(report.failures.map(f=>f.category))].map(c=>[c,report.failures.filter(f=>f.category===c).length]));
const dir=dataPath(root, 'output/maintenance',parent);mkdirSync(dir,{recursive:true});
const path=resolve(dir,'tool-errors.json');writeJson(path,report);
console.log(JSON.stringify({report:path,sessions:report.sessions.length,failures:report.failures.length,warning_outputs:report.warning_outputs,counts:report.counts},null,2));
