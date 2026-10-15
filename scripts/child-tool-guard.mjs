import { isAbsolute, relative, resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { dataPath, directoryContext } from './directory-context.mjs';
import { isPermittedChildShell } from './child-command-policy.mjs';
import { guardSensitiveRead } from './sensitive-file-guard.mjs';

const stages={
  requirement_analysis_agent:'analysis',
  test_point_agent:'test_points',
  test_case_agent:'test_cases',
  automation_execution_agent:'execution',
  defect_analysis_agent:'defects',
  test_report_agent:'report'
};

const exact={
  test_points:new Set(['design/test_points.json','design/test_points.xmind','design/test_points-task.json']),
  test_cases:new Set(['design/test_cases.json','design/test_cases.xlsx','design/test_cases-task.json']),
  execution:new Set(['environment/test-env.json'])
};

const directories={
  analysis:['analysis/'],
  execution:['execution/'],
  defects:['defects/'],
  report:['report/']
};

function parse(input) {
  return typeof input.arguments==='string'?JSON.parse(input.arguments):input.arguments;
}

function patchTargets(args) {
  const patch=String(args?.patch ?? args?.input ?? args ?? '');
  const paths=[...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to):\s*(.+?)\s*$/gm)].map(match=>match[1]);
  if(!paths.length) throw new Error('apply_patch targets are unreadable');
  return paths;
}

function currentRunId(agentRoot,agentId,sessionId) {
  const date=/^session-(\d{4}-\d{2}-\d{2})-/.exec(sessionId)?.[1];
  if(!date) throw new Error('invalid child session ID');
  const dir=resolve(agentRoot,agentId,'traces',date);
  const rows=readdirSync(dir).filter(name=>name.startsWith(`${sessionId}_`) && name.endsWith('.jsonl')).sort().flatMap(name=>readFileSync(resolve(dir,name),'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)));
  const prompts=rows.filter(row=>row.payload?.type==='text' && row.payload.role==='user').map(row=>row.payload.text ?? '').join('\n');
  const ids=[...new Set([...prompts.matchAll(/\brun_id=(run-[A-Za-z0-9-]+)\b/g)].map(match=>match[1]))];
  if(ids.length!==1) throw new Error('child prompt must identify exactly one run_id');
  return ids[0];
}

function runRelative(root,target,runId) {
  const context=directoryContext(root);
  const absolute=isAbsolute(target)?resolve(target):dataPath(root,target);
  const rel=relative(context.session_root,absolute).replaceAll('\\','/');
  if(!rel || rel.startsWith('../') || isAbsolute(rel)) throw new Error('write target is outside the current task workspace');
  const match=new RegExp(`^output/runs/${runId.replaceAll('-','\\-')}/(.+)$`).exec(rel);
  return {absolute,workspaceRelative:rel,runRelative:match?.[1] ?? null};
}

function allowed(stage,path) {
  if(/^output\/action-requests\/[A-Za-z0-9._-]+\.json$/.test(path.workspaceRelative)) return true;
  if(!path.runRelative) return false;
  if(exact[stage]?.has(path.runRelative)) return true;
  return (directories[stage] ?? []).some(prefix=>path.runRelative.startsWith(prefix));
}

export function guardChildTool(root,input,{agentId,agentRoot}) {
  const sensitive=guardSensitiveRead(root,input);
  if(sensitive.decision==='deny') return sensitive;
  if(input.tool_name==='exec_command' && stages[agentId]) {
    try {
      if(isPermittedChildShell(parse(input)?.cmd)) return {};
    } catch {}
    return {decision:'deny',reason:'QA shell redirect: This command was NOT executed. Use read_file with the supplied absolute engine/run paths for inspection; for test data lengths and integer money use diagnose_test_cases after saving the draft and task summary. Use the structured project-action entry for supported work. Correct the tool choice and continue without user approval, nested shells, helper scripts or repeated unchanged attempts.'};
  }
  if(!['write_file','edit_file','apply_patch'].includes(input.tool_name)) return {};
  try {
    const stage=stages[agentId];
    if(!stage) throw new Error(`unknown professional role ${agentId}`);
    const runId=currentRunId(agentRoot,agentId,input.session_id);
    const args=parse(input);
    const targets=input.tool_name==='apply_patch'?patchTargets(args):[args?.file_path];
    for(const target of targets) {
      if(typeof target!=='string' || !target.trim()) throw new Error('file target is missing');
      const absolute=isAbsolute(target)?resolve(target):null;
      const scratch=resolve(agentRoot,agentId,'scratchpad',input.session_id);
      if(absolute) {
        const rel=relative(scratch,absolute);
        if(rel==='' || (!rel.startsWith('..') && !isAbsolute(rel))) continue;
      }
      const path=runRelative(root,target,runId);
      const runPath=path.runRelative?.toLowerCase();
      if(stage==='execution' && runPath && (/^execution\/browser-/.test(runPath) || ['execution/test_results.json','execution/exploration.json','execution/exploration.lock'].includes(runPath))) {
        throw new Error('Controlled execution evidence is read-only to agents. Keep original results; correct only execution-task.json or action inputs. If the validator is incompatible, return the exact diagnostic to the controller without rewriting evidence or repeating product operations.');
      }
      if(!allowed(stage,path)) throw new Error(`${agentId} owns ${stage} outputs only; return this stage to the controller and let the mapped role create ${path.runRelative ?? path.workspaceRelative}`);
    }
    return {};
  } catch(error) {return {decision:'deny',reason:`QA stage boundary: ${error.message}`};}
}
