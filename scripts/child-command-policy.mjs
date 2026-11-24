import {toolOutcome} from './trace-outcome.mjs';
import { isAbsolute, relative, resolve } from 'node:path';
import { stageWriteRules, isControlledStageEvidence } from './stage-registry.mjs';
import { isSafeArtifactAction } from './recovery-policy.mjs';

export function childCommandPolicy(dispatchId, version = 3) {
  if (version === 3) return `QA_COMMAND_POLICY_V3 ${dispatchId}: 仅交付已分配阶段，校验和导出使用结构化动作。安全输入与草稿纠错不设固定次数；依据已记录的recovery修正原因，stalled=true时改变方法或返回已有结果和限制，不原样循环。不得要求用户技术解锁。保留真实证据，未解决的错误不得宣称完成。禁止重放结果未知的产品操作、绕过凭据或扩大范围，不自行批准阶段或直接编辑manifest。`;
  if (version === 2) return `QA_COMMAND_POLICY_V2 ${dispatchId}: Deliver stage results to the controller; it follows the saved review mode. Use structured actions as the only validators and exporters; do not run ad hoc node -e, npm validation scripts or direct project scripts. Inspect files with file tools. Correct safe input or draft artifact errors only when the recorded recovery.retry_allowed is true, with at most two corrections. Preserve failure evidence. Do not retry execution, unknown interruptions, credentials or scope changes. Return unresolved issues to the controller; never approve stages or alter manifest directly.`;
  return `QA_COMMAND_POLICY_V1 ${dispatchId}: On any command failure, input rejection, timeout, interruption or unknown result, stop and report the original evidence. Automatic retries=0. No downstream dispatch, installation, manifest edits or silent artifact repair. Resume only after controller review and a new authorized dispatch.`;
}

function isControlledCommand(command) {
  // Reading or searching a script is not invoking the controlled entry point.
  const value=String(command ?? '').trim();
  if (/[;&|><`\r\n]|\$\(/.test(value)) return false;
  return /^(?:node(?:\.exe)?\s+)(?:["']?[^\s"']*[\\/])?project-(?:command|action)\.mjs(?:["']?)(?=\s|$)/i.test(value);
}

function isDirectBypass(command) {
  return /^\s*node(?:\.exe)?\s+(?:["']?[^\s"']*[\\/])?(?:generate-analysis-markdown|validate-artifacts|record-orchestration-event|resolve-stage-confirmation|select-test-cases|create-execution-plan)\.mjs(?:["']?)(?=\s|$)/i.test(String(command));
}

// Every shell call must use the controlled project entry point. The stage hook
// denies anything else before execution, so no other command can become
// evidence of delivery: there is no historical shell grammar left to re-litigate.
export function isPermittedChildShell(command) {
  return isControlledCommand(command);
}

// The qa-stage-boundary hook owns the deny reason text. Match only its stable
// bare prefix so a reworded reason (QA shell redirect, write target, catalog
// detour, ...) still counts as "denied before execution" and is not mistaken
// for a failed business command during handoff.
const STAGE_BOUNDARY_DENIAL = 'Tool call denied by the qa-stage-boundary hook:';

function wasRedirectedBeforeExecution(rows,index,response,callId) {
  if(toolOutcome(response.payload)!=='aborted' || !String(response.payload.output).startsWith(STAGE_BOUNDARY_DENIAL)) return false;
  const decisions=rows.slice(index+1,rows.indexOf(response)).filter(row=>row.type==='event_msg' && row.payload?.type==='approval_decision' && row.payload.tool_call_id===callId);
  return decisions.length===1 && decisions[0].payload.decision==='deny';
}

function parseToolArguments(row) {
  try { return typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments; }
  catch { throw new Error(`Child ${row.payload?.name ?? 'tool'} arguments unreadable`); }
}

function containedBy(parent, candidate) {
  const value=relative(resolve(parent),resolve(candidate));
  return value==='' || (!value.startsWith('..') && !isAbsolute(value));
}

function normalizeRunRelative(runDirectory, target, workspace) {
  const absolute=resolve(isAbsolute(target) ? target : resolve(workspace,target));
  if(!containedBy(runDirectory,absolute)) return null;
  return relative(resolve(runDirectory),absolute).replaceAll('\\','/');
}

function assertStageWriteTarget(target,{stage,runDirectory,workspace,actionRequestDirectory,scratchpadDirectory}) {
  if(typeof target!=='string' || !target.trim()) throw new Error('Child file write target unreadable');
  const absolute=resolve(isAbsolute(target) ? target : resolve(workspace,target));
  if(containedBy(actionRequestDirectory,absolute)) return;
  if(scratchpadDirectory && containedBy(scratchpadDirectory,absolute)) return;
  const path=normalizeRunRelative(runDirectory,absolute,workspace);
  if(path && isControlledStageEvidence(stage,path)) throw new Error(`Child write bypassed controlled execution evidence: ${target}`);
  const rules=stageWriteRules(stage);
  if(path && (rules.exact.includes(path) || rules.directories.some(directory=>path.startsWith(directory)))) return;
  throw new Error(`Child write bypassed ${stage} stage ownership: ${target}`);
}

function patchTargets(args) {
  const patch=String(args?.patch ?? args?.input ?? args ?? '');
  const paths=[...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to):\s*(.+?)\s*$/gm)].map(match=>match[1]);
  if(!paths.length) throw new Error('Child apply_patch targets unreadable');
  return paths;
}

function assertStageWrites(rows,options) {
  if(!options.stageWriteBoundary) return;
  const boundary=options.stageWriteBoundary;
  for(const [index,row] of rows.entries()) {
    if(row.payload?.type!=='tool_call' || !['write_file','edit_file','apply_patch'].includes(row.payload.name)) continue;
    if(options.allowRecovery && toolWasNotExecuted(rows,index)) continue;
    const args=parseToolArguments(row);
    const targets=row.payload.name==='apply_patch' ? patchTargets(args) : [args?.file_path];
    targets.forEach(target=>assertStageWriteTarget(target,boundary));
  }
}

export function toolWasNotExecuted(rows,index) {
  const call=rows[index].payload;
  const matches=rows.filter(row=>row.payload?.type==='tool_call' && row.payload.tool_call_id===call.tool_call_id);
  if(!call.tool_call_id || matches.length!==1) return false;
  const following=rows.slice(index+1);
  const outputs=following.filter(row=>row.payload?.type==='tool_call_output' && row.payload.tool_call_id===call.tool_call_id);
  if(outputs.length===1) {
    const output=outputs[0];
    const decisions=rows.slice(index+1,rows.indexOf(output)).filter(row=>row.type==='event_msg' && row.payload?.type==='approval_decision' && row.payload.tool_call_id===call.tool_call_id);
    return toolOutcome(output.payload)==='aborted' &&
      String(output.payload.output).startsWith(STAGE_BOUNDARY_DENIAL) &&
      decisions.length===1 && decisions[0].payload.decision==='deny';
  }
  if(outputs.length) return false;
  // The host rejects malformed streamed arguments before tool dispatch. Missing
  // output alone is NOT proof: require the exact native parsing failure event.
  try { parseToolArguments(rows[index]); return false; } catch {}
  const end=following.findIndex(row=>['request_begin','request_end'].includes(row.payload?.type));
  if(end<0) return false;
  const segment=following.slice(0,end+1);
  if(segment.some(row=>row.payload?.type==='hook' ||
    (row.payload?.type==='approval_decision' && row.payload.tool_call_id===call.tool_call_id))) return false;
  const terminal=segment.at(-1);
  return terminal.type==='event_msg' && terminal.payload.type==='request_end' &&
    terminal.payload.status==='retryable' && terminal.payload.error_code==='malformed' &&
    String(terminal.payload.error_message).startsWith('Invalid streamed tool call arguments from ') &&
    String(terminal.payload.error_message).includes(`for tool "${call.name}" (tool_call_id="${call.tool_call_id}",`);
}

function isCatalogLookup(command) {
  return /^\s*node(?:\.exe)?\s+(?:"[^"]*project-action\.mjs"|'[^']*project-action\.mjs'|\S*project-action\.mjs)\s+catalog(?:\s+--(?:action|stage)=[^\s;&|><`\r\n]+)?\s*$/i.test(String(command));
}


function entryModuleMissing(output) {
  const value = String(output ?? '');
  return /Error: Cannot find module/.test(value) && /code:\s*'MODULE_NOT_FOUND'/.test(value) &&
    /requireStack:\s*\[\s*\]/.test(value) && /(?:Function|Module)\.executeUserEntryPoint/.test(value);
}

function terminalCommandOutput(rows, index, initial, allowRecovery) {
  const marker = String(initial.payload.output ?? '').match(/\[process running with process_id (proc-[A-Za-z0-9-]+); use input_command to send input or poll for output\]\s*$/);
  if (!marker) return initial;
  const processId = marker[1];
  let terminal = null;
  for (let i = index + 1; i < rows.length; i++) {
    const call = rows[i];
    if (call.payload?.type !== 'tool_call' || call.payload.name !== 'input_command') continue;
    if (allowRecovery && toolWasNotExecuted(rows,i)) continue;
    let args;
    try { args = typeof call.payload.arguments === 'string' ? JSON.parse(call.payload.arguments) : call.payload.arguments; }
    catch { throw new Error('Child process poll arguments unreadable'); }
    if (args?.process_id !== processId) continue;
    const outputs = rows.slice(i + 1).filter(row => row.payload?.type === 'tool_call_output' && row.payload.tool_call_id === call.payload.tool_call_id);
    if (outputs.length !== 1) throw new Error('Child process poll has unknown terminal response');
    const output = outputs[0];
    if (String(output.payload.output ?? '').trim() === `[process still running with process_id ${processId}]` && toolOutcome(output.payload) === 'completed') continue;
    if (terminal) throw new Error('Child process has multiple terminal responses');
    terminal = output;
  }
  if (!terminal) throw new Error('Child process has no terminal response');
  return terminal;
}

// Some hosts detach a read-only catalog lookup and return its completion as a
// background notification. The poll then contains no catalog body. A catalog
// has no business side effects, so later structured action receipts remain the
// evidence for delivery; this exception must never apply to execute.
function backgroundCatalogWithoutOutput(rows, index, initial) {
  const match = String(initial.payload.output ?? '').match(/^\[command running in background with process_id (proc-[A-Za-z0-9-]+); its completion will arrive as a user message — no need to poll\. Use input_command to interact \(kill: true stops it\)\]$/);
  if (!match || toolOutcome(initial.payload) !== 'completed') return false;
  const polls = rows.slice(index + 1).filter(row => row.payload?.type === 'tool_call' && row.payload.name === 'input_command').filter(row => {
    try { const args = parseToolArguments(row); return args.process_id === match[1] && args.kill !== true; }
    catch { return false; }
  });
  if (polls.length !== 1) return false;
  const outputs = rows.slice(index + 1).filter(row => row.payload?.type === 'tool_call_output' && row.payload.tool_call_id === polls[0].payload.tool_call_id);
  return outputs.length === 1 && toolOutcome(outputs[0].payload) === 'completed' && String(outputs[0].payload.output ?? '').trim() === '[no output]';
}

// A correction is a recorded attempt, never a silent pass: the category decides
// whether the engine itself still considers the action correctable, and the
// receipt is what proves the attempt happened at all.
const CORRECTABLE = new Set(['input_correction','artifact_revision','read_correction','request_correction','handoff_correction']);
function recordedCorrection(result,{allowRecovery,allowUnresolvedRecovery,verifyRecovery}) {
  if(!allowRecovery || !result || !verifyRecovery(result)) return null;
  const recovery=result.recovery;
  if(!recovery) {
    // A request that never selected an action carries no key of its own.
    if(result.status!=='rejected' || result.exit_code!==2 || result.run_id!==null || result.action!==null) return null;
    if(result.task_key==='unbound:request:') return {category:'request_correction',key:'unbound:request:',action:null};
    return allowUnresolvedRecovery && result.classification==='task_paused' ? {category:'task_paused',key:result.task_key,action:null} : null;
  }
  // Receipts written before categories existed still describe a selected action.
  const category=recovery.category ?? (result.action ? 'input_correction' : null);
  if(!CORRECTABLE.has(category)) return null;
  const stopped=result.status==='timeout'
    ? recovery.category==='artifact_revision' && isSafeArtifactAction(result) &&
      result.result?.termination_confirmed===true && !['interrupted','cleanup_required'].includes(result.result.termination)
    : ['failed','rejected'].includes(result.status) && result.exit_code!==0;
  if(!stopped) return null;
  // 1) still correctable, 2) progress-based exhaustion, 3) a legacy exhausted
  // receipt kept alive only by the explicit unresolved-draft path.
  const correctable=recovery.retry_allowed===true;
  const stalled=recovery.retry_allowed===false && recovery.stalled===true && recovery.policy==='progress_based' &&
    Number.isInteger(recovery.failure_number) && recovery.failure_number>=3 && recovery.key===result.task_key &&
    (result.classification!=='correction_stalled' || result.status==='rejected' && result.exit_code===2);
  const legacy=allowUnresolvedRecovery && recovery.retry_allowed===false && Number.isInteger(recovery.failure_number) && recovery.failure_number>=3;
  if(!correctable && !stalled && !legacy) return null;
  return {category,key:recovery.key ?? result.task_key,action:result.action ?? null};
}

// A corrected read stays a run-relative path inside this run, or an engine doc.
function isSafeReadPath(path,boundary) {
  if(path.includes('\\') || path.split('/').some(part=>['','.','..'].includes(part))) return false;
  return /^(analysis|design|execution|defects|report)\//.test(path) ||
    Boolean(boundary.engineDirectory && /^docs\/[A-Za-z0-9_/-]+\.md$/.test(path));
}

// Only inspect structured tool calls/results, never model reasoning or prose claims.
export function assertChildCommands(rows, { allowRecovery = false, allowUnresolvedRecovery = false, requireControlledCommands = false, verifyRecovery = () => false, verifyPartialBrowserFailure = () => false, verifyExternalRecovery = () => false, stageWriteBoundary = null } = {}) {
  assertStageWrites(rows,{stageWriteBoundary,allowRecovery});
  const pending = new Set();
  const pendingReads = new Map();
  const pendingUnkeyed = new Set();
  let pendingCatalog = false;
  for (const [index, row] of rows.entries()) {
    if(allowRecovery && pendingReads.size && stageWriteBoundary && row.payload?.type==='tool_call' && row.payload.name==='read_file') {
      let args;try {args=parseToolArguments(row);} catch { /* A later valid native read may still correct this read-only detour. */ }
      const outputs=rows.slice(index+1).filter(item=>item.payload?.type==='tool_call_output' && item.payload.tool_call_id===row.payload.tool_call_id);
      const calls=rows.filter(item=>item.payload?.type==='tool_call' && item.payload.tool_call_id===row.payload.tool_call_id);
      if(typeof args?.file_path==='string' && row.payload.tool_call_id && calls.length===1 && outputs.length===1 && toolOutcome(outputs[0].payload)==='completed') {
        const path=normalizeRunRelative(stageWriteBoundary.runDirectory,args.file_path,stageWriteBoundary.workspace);
        for(const read of pendingReads.values()) if(read.scope==='engine'
          ? stageWriteBoundary.engineDirectory && isAbsolute(args.file_path) && resolve(args.file_path)===resolve(stageWriteBoundary.engineDirectory,read.path)
          : read.path===path) read.readAt=rows.indexOf(outputs[0]);
      }
    }
    if (row.payload?.type !== 'tool_call' || row.payload.name !== 'exec_command') continue;
    if (allowRecovery && toolWasNotExecuted(rows,index)) continue;
    let args;
    try { args = typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments; }
    catch { throw new Error('Child command arguments unreadable'); }
    const outputs = rows.slice(index + 1).filter(item => item.payload?.type === 'tool_call_output' && item.payload.tool_call_id === row.payload.tool_call_id);
    if (outputs.length !== 1) throw new Error('Child command has unknown terminal response; review required');
    if (allowRecovery && isCatalogLookup(args?.cmd) && backgroundCatalogWithoutOutput(rows,index,outputs[0])) continue;
    const response = terminalCommandOutput(rows, index, outputs[0], allowRecovery);
    if(allowRecovery && wasRedirectedBeforeExecution(rows,index,response,row.payload.tool_call_id)) continue;
    if (!isControlledCommand(args?.cmd)) {
      // A denied detour never ran; a recorded failure here has no compliant repair path.
      if (requireControlledCommands && isDirectBypass(args?.cmd)) throw new Error('Child bypassed the controlled project entry; file existence cannot prove compliant delivery');
      if (requireControlledCommands) throw new Error('Child used an uncontrolled shell command; stage delivery requires the project entry point');
      if (toolOutcome(response.payload) === 'fatal') throw new Error('Child command failed');
      continue;
    }
    const raw = response.payload.output;
    if (allowRecovery && isCatalogLookup(args?.cmd) &&
      (toolOutcome(response.payload) === 'fatal' || toolOutcome(response.payload) === 'completed' && /\[exit code: 1\]\s*$/.test(String(raw))) && entryModuleMissing(raw)) {
      pendingCatalog = true;
      continue;
    }
    // Catalog is read-only help, never evidence of a business action. AMSP may
    // archive its middle section; do not demand valid JSON from that preview.
    if (allowRecovery && isCatalogLookup(args?.cmd) && toolOutcome(response.payload)==='completed' &&
      /^\s*\{\s*"status"\s*:\s*"help"\s*,/.test(String(raw)) &&
      /\[output archived: [^\r\n]+\]\s*$/.test(String(raw)) && !/\[exit code: [^0\]]/.test(String(raw))) {
      pendingCatalog=false;
      continue;
    }
    let result;
    try {
      // PenguinHarness may prepend shell-profile warnings to the single JSON response.
      result = typeof raw === 'string' ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) : raw;
    } catch { throw new Error('Child runner response unreadable; review required'); }
    // One rule for every recorded correction: the action layer persisted a recovery
    // ledger entry and the receipt matches it. Its category is the contract; the error
    // prose is not, so a new correction kind never needs a new string comparison.
    const correction=recordedCorrection(result,{allowRecovery,allowUnresolvedRecovery,verifyRecovery});
    if(correction) {
      // A child cannot complete its own handoff: the native child return does not exist
      // yet. The rejected attempt changes no stage state; the parent still performs the
      // real handoff and validates the complete child trace afterward.
      if(correction.category==='handoff_correction' && correction.action==='handoff') continue;
      // A rejection recorded before an action was selected carries no task key;
      // only the stage validation can prove that the corrected attempt landed.
      if(!correction.key) { pendingUnkeyed.add(correction.category); continue; }
      // A read_source routing error is corrected with the native reader. Bind that exact
      // path to its persisted rejection and require the later stage validation.
      if(correction.category==='read_correction' && correction.action==='read_source' && stageWriteBoundary &&
        typeof result.read_path==='string' && isSafeReadPath(result.read_path,stageWriteBoundary)) {
        pendingReads.set(result.task_key,{path:result.read_path,scope:result.read_path.startsWith('docs/')?'engine':'run',run:result.run_id,readAt:null});
        continue;
      }
      pending.add(correction.key); continue;
    }
    // A verified partial browser delivery preserves failed commands; it never turns them into passes.
    if(allowRecovery && verifyPartialBrowserFailure(result,row)) continue;
    if (!result || toolOutcome(response.payload) === 'fatal' || !['completed', 'ready', 'help'].includes(result.status) || (result.exit_code !== undefined && result.exit_code !== 0)) throw new Error('Child command failed or was rejected; cannot complete this dispatch after retry');
    if (pendingCatalog && isCatalogLookup(args?.cmd) && result.status === 'help') pendingCatalog = false;
    if (allowRecovery && result.status === 'completed' && result.action_receipt && verifyRecovery(result)) {
      pending.delete(result.task_key); pending.delete('unbound:request:');
      const key = String(result.task_key ?? '');
      const validation = /^run-[A-Za-z0-9-]+:validate_artifacts:(?:analysis|test_points|test_cases|execution|api_execution|defects|report)(?:[a-f0-9-]{36})?$/.test(key) ||
        /^run-[A-Za-z0-9-]+:validate_analysis:(?:[a-f0-9-]{36})?$/.test(key);
      if(result.script==='validate-artifacts.mjs' && validation) pendingUnkeyed.clear();
      if(result.script==='validate-artifacts.mjs' && validation && stageWriteBoundary) {
        for(const [readKey,read] of pendingReads) {
          const prefix=`${read.run}:validate_artifacts:${stageWriteBoundary.stage}`;
          const suffix=key.slice(prefix.length);
          if(read.readAt!==null && read.readAt<index && key.startsWith(prefix) && (suffix==='' || /^[a-f0-9-]{36}$/.test(suffix))) pendingReads.delete(readKey);
        }
      }
    }
    const inProcess = result.execution_mode === 'in_process' && result.launches_child === false && typeof result.action_receipt === 'string';
    if (result.status === 'completed' && (result.exit_code !== 0 || (!inProcess && result.result?.termination_confirmed !== true))) throw new Error('Child process completion is unconfirmed');
  }
  for(const key of pending) if(verifyExternalRecovery(key)) pending.delete(key);
  if (pending.size && !allowUnresolvedRecovery) throw new Error('Recoverable errors were not resolved by a verified successful action');
  if(pendingReads.size && !allowUnresolvedRecovery) throw new Error('Source read correction requires a matching native read and verified stage validation');
  if (pendingUnkeyed.size) throw new Error('A recorded correction was not followed by verified artifact validation');
  if (pendingCatalog) throw new Error('Project action catalog lookup failure was not corrected');
}
