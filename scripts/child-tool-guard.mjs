import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { dataPath, directoryContext } from './directory-context.mjs';
import { isPermittedChildShell } from './child-command-policy.mjs';
import { guardSensitiveRead } from './sensitive-file-guard.mjs';
import { stageWriteRules, isControlledStageEvidence } from './stage-registry.mjs';
import { prepareInlineAction } from './inline-action-request.mjs';
import { parseActionInvocation } from './command-contracts.mjs';

const stages={
  requirement_analysis_agent:'analysis',
  test_point_agent:'test_points',
  test_case_agent:'test_cases',
  automation_execution_agent:'execution',
  android_test_agent:'execution',
  miniprogram_test_agent:'execution',
  desktop_test_agent:'execution',
  api_automation_agent:'api_execution',
  defect_analysis_agent:'defects',
  test_report_agent:'report'
};
// Platform executors share the execution stage but not its browser actions. Without
// their own action list they could reach browser_task/explore_url, and without any
// stage entry they could not write execution-task.json at all (unknown role → deny).
const platformActions={
  android_test_agent:['android_task'],
  miniprogram_test_agent:['miniprogram_task'],
  desktop_test_agent:['desktop_task']
};

// A denial whose message already carries the whole actionable instruction. Callers must not
// append the generic "correct the request" suffix: on a state-level block it points the model at
// the one thing that cannot work (rewording the request), which is what produced the retry storm.
class DenialReason extends Error {}

function parse(input) {
  return typeof input.arguments==='string'?JSON.parse(input.arguments):input.arguments;
}

function patchTargets(args) {
  const patch=String(args?.patch ?? args?.input ?? args ?? '');
  const paths=[...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to):\s*(.+?)\s*$/gm)].map(match=>match[1]);
  if(!paths.length) throw new Error('apply_patch targets are unreadable');
  return paths;
}

// Every guarded tool call re-derives the bound run_id from the child's own trace,
// which grows for the whole session. The engine-side cache (not writable through any
// child-permitted path) keeps per-file scan state so an append-only trace is read
// incrementally; an unchanged file is not re-read at all. Any doubt falls back to a
// full read, and a cache write failure never changes the verdict.
function promptRunIds(text) {
  return [...text.matchAll(/\brun_id=(run-[A-Za-z0-9-]+)\b/g)].map(match=>match[1]);
}
function currentRunId(root,agentRoot,agentId,sessionId) {
  const date=/^session-(\d{4}-\d{2}-\d{2})-/.exec(sessionId)?.[1];
  if(!date) throw new Error('invalid child session ID');
  const dir=resolve(agentRoot,agentId,'traces',date);
  const names=readdirSync(dir).filter(name=>name.startsWith(`${sessionId}_`) && name.endsWith('.jsonl')).sort();
  const cacheFile=dataPath(root,'output/hook-cache',agentId,`${sessionId}.json`);
  let cache=null;
  try { const value=JSON.parse(readFileSync(cacheFile,'utf8')); if(value?.version===1 && value.session_id===sessionId && value.files) cache=value; } catch {}
  const files={}, ids=new Set();
  for(const name of names) {
    const path=resolve(dir,name), stat=statSync(path), prior=cache?.files?.[name];
    let tail, fileIds;
    if(prior && prior.size===stat.size && prior.mtimeMs===stat.mtimeMs) {
      tail=prior.tail ?? ''; fileIds=prior.ids ?? [];
    } else {
      let text;
      if(prior && stat.size>prior.size && stat.mtimeMs!==prior.mtimeMs) {
        const fd=openSync(path,'r'), buffer=Buffer.alloc(stat.size-prior.size);
        try { readSync(fd,buffer,0,buffer.length,prior.size); } finally { closeSync(fd); }
        text=(prior.tail ?? '')+buffer.toString('utf8');
        fileIds=[...(prior.ids ?? [])];
      } else { text=readFileSync(path,'utf8'); fileIds=[]; }
      const lines=text.split(/\r?\n/);
      tail=lines.pop() ?? '';
      if(tail) {
        // A final line without a trailing newline is complete when it parses; only an
        // unparseable remainder is a line still being appended, rescanned on the next call.
        try { JSON.parse(tail); lines.push(tail); tail=''; } catch {}
      }
      const found=new Set(fileIds);
      for(const line of lines) {
        if(!line) continue;
        const row=JSON.parse(line);
        if(row.payload?.type==='text' && row.payload.role==='user') for(const id of promptRunIds(row.payload.text ?? '')) found.add(id);
      }
      fileIds=[...found];
    }
    files[name]={size:stat.size,mtimeMs:stat.mtimeMs,tail,ids:fileIds};
    for(const id of fileIds) ids.add(id);
  }
  try { mkdirSync(dirname(cacheFile),{recursive:true}); writeFileSync(cacheFile,JSON.stringify({version:1,session_id:sessionId,files})); } catch {}
  if(ids.size!==1) throw new Error('child prompt must identify exactly one run_id');
  return [...ids][0];
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
  const rules=stageWriteRules(stage);
  return rules.exact.includes(path.runRelative) || rules.directories.some(prefix=>path.runRelative.startsWith(prefix));
}

export function guardChildTool(root,input,{agentId,agentRoot}) {
  const sensitive=guardSensitiveRead(root,input);
  if(sensitive.decision==='deny') return sensitive;
  if(input.tool_name==='exec_command' && stages[agentId]) {
    try {
      const args=parse(input);
      if(isPermittedChildShell(args?.cmd)) {
        if(/project-action\.mjs/i.test(args.cmd)) parseActionInvocation(args.cmd);
        if(args.qa_request!==undefined) {
          const runId=currentRunId(root,agentRoot,agentId,input.session_id);
          const manifest=JSON.parse(readFileSync(dataPath(root,'output/runs',runId,'manifest.json'),'utf8'));
          const stage=stages[agentId];
          const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage===stage).at(-1);
          if(!dispatch?.['parent-session-id']) throw new DenialReason(`No retained dispatch for ${stage}; the controller must dispatch this stage before it can write anything`);
          const stageStatus=manifest.stages?.[stage]?.status;
          if(stageStatus==='awaiting_confirmation') throw new DenialReason(`${stage} is waiting for the user to confirm the delivered version. Do not retry this action: if the user asks for changes, the controller records the revision and this stage becomes revision_requested, which reopens writes`);
          if(stageStatus==='completed') throw new DenialReason(`${stage} was already confirmed and delivered. A delivered stage is not reopened by retrying: tell the controller the exact change the user asked for so it records a revision request, which turns this stage into revision_requested`);
          if(!['in_progress','revision_requested'].includes(stageStatus)) throw new DenialReason(`${stage} is ${stageStatus ?? 'unplanned'}; only an in-progress dispatch or a user-requested revision may write. Report this state to the controller instead of retrying`);
          const common=['read_source','run_status','validate_artifacts','extract_word','diagnose_task','run_stage_tool'];
          const own={api_execution:['api_task'],analysis:['api_task','generate_analysis','validate_analysis','diagnose_analysis','analysis_summary'],test_points:['api_task','draft_records','diagnose_test_points','export_test_points'],test_cases:['api_task','draft_records','diagnose_test_cases','export_test_cases'],execution:['browser_task','explore_url','prepare_execution_plan','validate_execution_prepare'],defects:['assess_evidence','normalize_defects'],report:['build_report_metrics','export_report']};
          const roleActions=platformActions[agentId] ?? own[stage];
          if(![...common,...roleActions].includes(args.qa_request.action) || (args.qa_request.stage!==undefined && args.qa_request.stage!==stage)) throw new DenialReason(`${args.qa_request.action} is not a ${stage} action. Allowed here: ${[...common,...roleActions].join(', ')}. To read one action's field rules run the CLI itself: node scripts/project-action.mjs catalog --action=<name> — catalog is a CLI subcommand, never a qa_request action`);
          if(args.qa_request.action==='api_task' && stage!=='api_execution' && args.qa_request.operation?.type!=='inspect_contract') throw new Error('Design roles may only inspect API contracts');
          prepareInlineAction(root,args,{runId,parentSession:dispatch['parent-session-id']});
        }
        return {};
      }
    } catch(error) {return {decision:'deny',reason:`QA shell redirect: This command was NOT executed. ${error.message}${error instanceof DenialReason?'':' Correct the structured request without user unlock.'}`};}
    const diagnoseAction={analysis:'diagnose_analysis',test_points:'diagnose_test_points',test_cases:'diagnose_test_cases'}[stages[agentId]] ?? 'diagnose_task';
    return {decision:'deny',reason:`QA shell redirect: This command was NOT executed. No shell pipelines, ls/grep/find or helper scripts. Inspect a single file with read_file at the supplied absolute path; see what a stage produced with run_status; read one action's field rules with node scripts/project-action.mjs catalog --action=<name>; confirm draft counts and integer money with ${diagnoseAction} after saving the draft and task summary. Use the structured project-action entry for supported work. Continue without user approval, and never repeat an unchanged command.`};
  }
  if(!['write_file','edit_file','apply_patch'].includes(input.tool_name)) return {};
  try {
    const stage=stages[agentId];
    if(!stage) throw new Error(`unknown professional role ${agentId}`);
    const runId=currentRunId(root,agentRoot,agentId,input.session_id);
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
      if(runPath && isControlledStageEvidence(stage,runPath)) {
        throw new Error('Controlled execution evidence is read-only to agents. Keep original results; correct only execution-task.json or action inputs. If the validator is incompatible, return the exact diagnostic to the controller without rewriting evidence or repeating product operations.');
      }
      if(!allowed(stage,path)) throw new Error(`${agentId} owns ${stage} outputs only. This write was NOT executed. Omit unrelated outputs and continue with this stage's registered artifacts; do not restart the stage or request a technical unlock. Rejected target: ${path.runRelative ?? path.workspaceRelative}`);
    }
    return {};
  } catch(error) {return {decision:'deny',reason:`QA stage boundary: ${error.message}`};}
}
