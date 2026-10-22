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

function isSuccessfulLiteralCount(command, response) {
  if(response.stop_reason!=='completed') return false;
  // Recognize only a literal-only grammar and its exact output; never evaluate code.
  const outer=/^\s*node(?:\.exe)?\s+-e\s+"([^"\\`$%\r\n]+)"\s*$/.exec(String(command));
  if(!outer || outer[1].length>12000) return false;
  const declaration=/^\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^'"\\`$%\r\n]*)'\s*;\s*/.exec(outer[1]);
  if(!declaration || ['console','process','global','globalThis','require','module','exports'].includes(declaration[1])) return false;
  let rest=outer[1].slice(declaration[0].length);const expected=[];
  while(rest) {
    const print=/^console\.log\(\s*([A-Za-z_][A-Za-z0-9_]*)(\.length)?\s*\)\s*;?\s*/.exec(rest);
    if(!print || print[1]!==declaration[1] || expected.length>=4) return false;
    expected.push(print[2]?String(declaration[2].length):declaration[2]);rest=rest.slice(print[0].length);
  }
  return expected.length>0 && String(response.output).replaceAll('\r\n','\n')===expected.join('\n')+'\n';
}

function isSafeInspection(command) {
  const value = String(command ?? '').trim();
  if (/`|\$\(|[\r\n]/.test(value)) return false;
  if (/^find\s+["'][a-z]:[\\/][^"']+["'](?:\s+-maxdepth\s+\d+)?\s+-type\s+f(?:\s+2>\/dev\/null)?(?:\s*\|\s*(?:head\s+-\d+|sort))?$/i.test(value)) return true;
  return /^(?:dir|ls|Get-ChildItem|Get-Content|Select-String)(?=\s|$)/i.test(value) &&
    !/[;&>`\r\n]|\$\(/.test(value) &&
    value.split('|').slice(1).every(segment => /^\s*(?:Select-Object|Out-String|Format-Table)(?:\s|$)/i.test(segment));
}

function isReadOnlyFind(command) {
  const value=String(command ?? '').trim();
  const sections=value.split('|');
  if(sections.length>2 || (sections.length===2 && !/^\s*(?:head\s+-\d{1,4}|sort)\s*$/i.test(sections[1]))) return false;
  const primary=sections[0].replace(/\s+2>\/dev\/null\s*$/i,'').trim();
  if(!/^find\s+(?:output\/runs\/[A-Za-z0-9_./-]+|\/[a-z](?:\/[^\s;&|><`\r\n]+)?|"[a-z]:[\\/][^"\r\n]+"|'[a-z]:[\\/][^'\r\n]+'|[a-z]:[\\/][^\s;&|><`\r\n]+)(?:\s+.+)?$/i.test(primary)) return false;
  return !/[;&><`\r\n]|\$\(|\s-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)(?:\s|$)/i.test(primary);
}

function isRecoverableReadOnlyShellDetour(command) {
  const value=String(command ?? '').trim();
  if (/`|\$\(|[\r\n]/.test(value)) return false;
  if (/^node(?:\.exe)?\s+(?:["']?[^\s"']*[\\/])?project-action\.mjs(?:["']?)\s+catalog\s*\|\s*grep\s+-A\s+\d{1,3}\s+(?:'[^';&|><`\r\n]+'|"[^";&|><`\r\n]+")$/i.test(value)) return true;
  if (/^pwd\s*&&\s*ls\s+-la\s+output\/action-requests\/?\s+2>\/dev\/null\s*\|\|\s*echo\s+(?:'[^';&|><`\r\n]+'|"[^";&|><`\r\n]+")$/i.test(value)) return true;
  if (/^ls\s+-[A-Za-z]+\s+(?:"[^";&|><`\r\n]+"|'[^';&|><`\r\n]+'|[^\s;&|><`\r\n]+)\s+2>\/dev\/null(?:\s*\|\|\s*echo\s+(?:'[^';&|><`\r\n]+'|"[^";&|><`\r\n]+"))?$/i.test(value)) return true;
  if (/^rg\s+/i.test(value)) {
    const shellSyntax=value.replace(/'[^'\r\n]*'|"[^"\r\n]*"/g,'');
    if (!/[;&|><`\r\n]|\$\(/.test(shellSyntax) && !/--pre(?:[\s='"]|$)/i.test(value.replace(/["']/g,''))) return true;
  }
  if(isReadOnlyFind(value)) return true;
  const compound=value.split(/\s*&&\s*/);
  if(compound.length>=2 && compound.length<=4 && compound.every(isSafeInspection)) return true;
  return compound.length===2 && isSafeInspection(compound[0]) && isReadOnlyFind(compound[1]);
}

export function isPermittedChildShell(command) {
  // New tool calls use native file tools for inspection; historical traces retain
  // their existing read-only compatibility checks below.
  return isControlledCommand(command);
}

function wasRedirectedBeforeExecution(rows,index,response,callId) {
  if(response.payload.stop_reason!=='aborted' || !String(response.payload.output).startsWith('Tool call denied by the qa-stage-boundary hook: QA shell redirect:')) return false;
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
    return output.payload.stop_reason==='aborted' &&
      String(output.payload.output).startsWith('Tool call denied by the qa-stage-boundary hook: QA stage boundary:') &&
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

function normalizedInspectionPath(path) {
  return path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
}

function inspectedPath(command) {
  const path=String(command ?? '').match(/["']([a-z]:[\\/][^"']+)["']/i)?.[1];
  return path ? normalizedInspectionPath(path) : null;
}

function isSingleFileRead(command) {
  // Native file reads can replace a single content read, not listings or searches.
  return /^\s*Get-Content\s+(?:(?:-LiteralPath|-Path)\s+)?(?:"[a-z]:[\\/][^"*?\[\]]+"|'[a-z]:[\\/][^'*?\[\]]+')(?:\s+(?:-Raw|-(?:TotalCount|Tail)\s+\d+|-Encoding\s+[A-Za-z0-9-]+))*\s*$/i.test(String(command));
}

function isCatalogLookup(command) {
  return /^\s*node(?:\.exe)?\s+(?:"[^"]*project-action\.mjs"|'[^']*project-action\.mjs'|\S*project-action\.mjs)\s+catalog\s*$/i.test(String(command));
}

function isHarmlessShellProbe(command, output) {
  const value = String(command ?? '').trim();
  if (!/command not found/.test(String(output ?? ''))) return false;
  if (isSafeInspection(value)) return true;
  if (/^pwsh -NoProfile -Command "Get-ChildItem -LiteralPath '[a-z]:[^'";&`]+?' -Recurse \| Select-Object FullName,Length"$/i.test(value)) return true;
  if (/^printf 'DOCX: '; head -c 4 [a-z]:[^\s;|]+ \| od -An -tx1; printf 'PDF: '; head -c 8 [a-z]:[^\s;|]+ \| od -An -tx1$/i.test(value)) return true;
  return /^xxd -l 8 [a-z]:[^\s;|]+; xxd -l 8 [a-z]:[^\s;|]+$/i.test(value);
}

function isSuccessfulReportHeaderInspection(command, output) {
  const value = String(command ?? '').trim();
  if (!/^python - <<'PY'\r?\nfrom pathlib import Path\r?\nfor name in \['test_report\.docx','test_report\.pdf'\]:\r?\n\s+p = Path\('[a-z]:[^']+\/report'\)\/name\r?\n\s+data = p\.read_bytes\(\)\[:8\]\r?\n\s+print\(name, data\.hex\(\)\)\r?\nPY$/i.test(value)) return false;
  const result = String(output ?? '');
  return /test_report\.docx 504b0304[0-9a-f]{8}/i.test(result) && /test_report\.pdf 25504446[0-9a-f]{8}/i.test(result);
}

function entryModuleMissing(output) {
  const value = String(output ?? '');
  return /Error: Cannot find module/.test(value) && /code:\s*'MODULE_NOT_FOUND'/.test(value) &&
    /requireStack:\s*\[\s*\]/.test(value) && /Function\.executeUserEntryPoint/.test(value);
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
    if (String(output.payload.output ?? '').trim() === `[process still running with process_id ${processId}]` && output.payload.stop_reason === 'completed') continue;
    if (terminal) throw new Error('Child process has multiple terminal responses');
    terminal = output;
  }
  if (!terminal) throw new Error('Child process has no terminal response');
  return terminal;
}

// Only inspect structured tool calls/results, never model reasoning or prose claims.
export function assertChildCommands(rows, { allowRecovery = false, allowUnresolvedRecovery = false, requireControlledCommands = false, verifyRecovery = () => false, verifyPartialBrowserFailure = () => false, stageWriteBoundary = null } = {}) {
  assertStageWrites(rows,{stageWriteBoundary,allowRecovery});
  const pending = new Set();
  const pendingReads = new Map();
  let pendingInspection = null;
  let pendingCatalog = false;
  let pendingShellProbes = 0;
  for (const [index, row] of rows.entries()) {
    if(allowRecovery && (pendingInspection || pendingReads.size && stageWriteBoundary) && row.payload?.type==='tool_call' && row.payload.name==='read_file') {
      let args;try {args=parseToolArguments(row);} catch { /* A later valid native read may still correct this read-only detour. */ }
      const outputs=rows.slice(index+1).filter(item=>item.payload?.type==='tool_call_output' && item.payload.tool_call_id===row.payload.tool_call_id);
      const calls=rows.filter(item=>item.payload?.type==='tool_call' && item.payload.tool_call_id===row.payload.tool_call_id);
      if(typeof args?.file_path==='string' && row.payload.tool_call_id && calls.length===1 && outputs.length===1 && outputs[0].payload.stop_reason==='completed') {
        const target=/^[a-z]:[\\/]/i.test(args.file_path) || isAbsolute(args.file_path) ? args.file_path : stageWriteBoundary && resolve(stageWriteBoundary.workspace,args.file_path);
        if(pendingInspection?.nativeRead && index>pendingInspection.failedAt && target && normalizedInspectionPath(target)===pendingInspection.path) pendingInspection=null;
        if(!stageWriteBoundary) continue;
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
    const response = terminalCommandOutput(rows, index, outputs[0], allowRecovery);
    if(allowRecovery && wasRedirectedBeforeExecution(rows,index,response,row.payload.tool_call_id)) continue;
    if (!isControlledCommand(args?.cmd)) {
      if(allowRecovery && isSuccessfulLiteralCount(args?.cmd,response.payload)) continue;
      if (requireControlledCommands && isDirectBypass(args?.cmd)) throw new Error('Child bypassed the controlled project entry; file existence cannot prove compliant delivery');
      const recoverableDetour=allowRecovery && !isSafeInspection(args?.cmd) && isRecoverableReadOnlyShellDetour(args?.cmd);
      if (requireControlledCommands && !isSafeInspection(args?.cmd) && !isSuccessfulReportHeaderInspection(args?.cmd,response.payload.output) && !recoverableDetour) throw new Error('Child used an uncontrolled shell command; stage delivery requires the project entry point');
      if (recoverableDetour && response.payload.stop_reason === 'fatal') pendingShellProbes++;
      if (response.payload.stop_reason === 'fatal') {
        const path = inspectedPath(args?.cmd);
        if (recoverableDetour) {}
        else if (allowRecovery && isSafeInspection(args?.cmd) && isSingleFileRead(args?.cmd) && path && !pendingInspection) pendingInspection = {path,nativeRead:true,failedAt:rows.indexOf(response)};
        else if (allowRecovery && isHarmlessShellProbe(args?.cmd, response.payload.output)) pendingShellProbes++;
        else if (!allowRecovery || !isSafeInspection(args?.cmd) || !path || pendingInspection) throw new Error('Child command failed');
        else pendingInspection = {path,nativeRead:isSingleFileRead(args?.cmd),failedAt:rows.indexOf(response)};
      } else if (pendingInspection && isSafeInspection(args?.cmd) && inspectedPath(args?.cmd) === pendingInspection.path && response.payload.stop_reason === 'completed') pendingInspection = null;
      if (allowRecovery && response.payload.stop_reason === 'completed' && isSuccessfulReportHeaderInspection(args?.cmd, response.payload.output)) pendingShellProbes = 0;
      continue;
    }
    const raw = response.payload.output;
    if (allowRecovery && isCatalogLookup(args?.cmd) && response.payload.stop_reason === 'fatal' && entryModuleMissing(raw)) {
      pendingCatalog = true;
      continue;
    }
    let result;
    try {
      // PenguinHarness may prepend shell-profile warnings to the single JSON response.
      result = typeof raw === 'string' ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) : raw;
    } catch { throw new Error('Child runner response unreadable; review required'); }
    // A malformed/missing request never selected or executed a business action. A later
    // verified valid request may resolve that transport issue without resetting its budget.
    if(allowRecovery && result?.status==='rejected' && result.classification==='task_paused' && result.exit_code===2 && result.run_id===null && result.action===null && result.task_key==='unbound:request:' && result.recovery==null && verifyRecovery(result)) {
      pending.add('unbound:request:'); continue;
    }
    // Exhausting malformed-request correction does not turn a later, distinct valid
    // request into a failed business action; no action was selected or launched.
    if(allowRecovery && result?.status==='rejected' && result.classification==='input_rejected' && result.exit_code===2 && result.run_id===null && result.action===null && result.recovery?.category==='request_correction' && result.recovery.retry_allowed===false && result.recovery.failure_number>=3 && verifyRecovery(result)) {
      pending.add(result.task_key); continue;
    }
    // Independent report tasks reject lifecycle-only metrics before launch. Treat the
    // corrected path as complete only after the report artifacts pass verification.
    if(allowRecovery && result?.status==='rejected' && result.classification==='input_rejected' && result.action==='build_report_metrics' && result.error==='Lifecycle metrics/normalization are not prerequisites for independent tasks' && result.recovery?.retry_allowed===true && verifyRecovery(result)) {
      pendingShellProbes++; continue;
    }
    // A child cannot complete its own handoff because the native child return does
    // not exist yet. The rejected attempt changes no stage state; the parent still
    // performs the real handoff and validates the complete child trace afterward.
    if(allowRecovery && result?.status==='rejected' && result.classification==='input_rejected' && result.action==='handoff' && result.recovery?.category==='handoff_correction' && /^Stage handoff not ready: No unique returned child for this dispatch;/.test(String(result.error ?? '')) && verifyRecovery(result)) {
      continue;
    }
    // A read_source routing error may be corrected with the native reader. Bind the
    // exact path to its persisted rejection and require subsequent stage validation.
    if(allowRecovery && stageWriteBoundary && result?.status==='rejected' && result.classification==='input_rejected' && result.action==='read_source' && result.error==='Source must be a run-relative inputs path' && result.recovery?.category==='read_correction' && result.recovery.retry_allowed===true && typeof result.read_path==='string' && (/^(analysis|design|execution|defects|report)\//.test(result.read_path) || stageWriteBoundary.engineDirectory && /^docs\/[A-Za-z0-9_/-]+\.md$/.test(result.read_path)) && !result.read_path.includes('\\') && !result.read_path.split('/').some(part=>['','.','..'].includes(part)) && verifyRecovery(result)) {
      pendingReads.set(result.task_key,{path:result.read_path,scope:result.read_path.startsWith('docs/')?'engine':'run',run:result.run_id,readAt:null});continue;
    }
    const safeArtifactTimeout=result?.status==='timeout' && result.recovery?.category==='artifact_revision' &&
      isSafeArtifactAction(result) && result.result?.termination_confirmed===true &&
      !['interrupted','cleanup_required'].includes(result.result.termination);
    const correctionStatus=['failed','rejected'].includes(result?.status) || safeArtifactTimeout;
    // Stalling forbids unchanged retries, but does not invalidate a later verified correction.
    if(allowRecovery && correctionStatus && result.exit_code!==0 &&
      ['input_correction','artifact_revision','read_correction','request_correction','handoff_correction'].includes(result.recovery?.category) &&
      result.recovery.policy==='progress_based' && result.recovery.stalled===true && result.recovery.retry_allowed===false &&
      Number.isInteger(result.recovery.failure_number) && result.recovery.failure_number>=3 &&
      typeof result.task_key==='string' && result.task_key.length>0 && result.recovery.key===result.task_key &&
      (result.classification!=='correction_stalled' || result.status==='rejected' && result.exit_code===2) && verifyRecovery(result)) {
      pending.add(result.task_key); continue;
    }
    // A returned draft may be archived, never completed, after verified exhaustion.
    // Native tools label ordinary nonzero exits fatal too; only a matching persisted safe receipt can qualify.
    if(allowRecovery && allowUnresolvedRecovery && result && verifyRecovery(result) &&
      ((['input_correction','artifact_revision','read_correction','request_correction'].includes(result.recovery?.category) && Number.isInteger(result.recovery.failure_number) && result.recovery.failure_number>=3 && result.recovery.retry_allowed===false && correctionStatus) ||
       (result.status==='rejected' && result.classification==='task_paused' && result.recovery==null && result.exit_code===2))) {
      pending.add(result.task_key); continue;
    }
    if (allowRecovery && result?.exit_code !== 0 && correctionStatus && result?.recovery?.retry_allowed === true && ['input_correction','artifact_revision','read_correction','request_correction'].includes(result.recovery.category) && ((result.recovery.policy==='progress_based' && Number.isInteger(result.recovery.failure_number) && result.recovery.failure_number>0) || [1,2].includes(result.recovery.failure_number)) && verifyRecovery(result)) { pending.add(result.recovery.key); continue; }
    // A verified partial browser delivery preserves failed commands; it never turns them into passes.
    if(allowRecovery && verifyPartialBrowserFailure(result,row)) continue;
    if (!result || response.payload.stop_reason === 'fatal' || !['completed', 'ready', 'help'].includes(result.status) || (result.exit_code !== undefined && result.exit_code !== 0)) throw new Error('Child command failed or was rejected; cannot complete this dispatch after retry');
    if (pendingCatalog && isCatalogLookup(args?.cmd) && result.status === 'help') pendingCatalog = false;
    if (allowRecovery && result.status === 'completed' && result.action_receipt && verifyRecovery(result)) {
      pending.delete(result.task_key); pending.delete('input_correction'); pending.delete('unbound:request:');
      const key = String(result.task_key ?? '');
      const validation = /^run-[A-Za-z0-9-]+:validate_artifacts:(?:analysis|test_points|test_cases|execution|api_execution|defects|report)(?:[a-f0-9-]{36})?$/.test(key) ||
        /^run-[A-Za-z0-9-]+:validate_analysis:(?:[a-f0-9-]{36})?$/.test(key);
      if (result.script === 'validate-artifacts.mjs' && validation) pendingShellProbes = 0;
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
  if (pending.size && !allowUnresolvedRecovery) throw new Error('Recoverable errors were not resolved by a verified successful action');
  if(pendingReads.size && !allowUnresolvedRecovery) throw new Error('Source read correction requires a matching native read and verified stage validation');
  if (pendingInspection) throw new Error('Read-only inspection failure was not corrected');
  if (pendingShellProbes) throw new Error('Shell inspection failures were not followed by verified artifact validation');
  if (pendingCatalog) throw new Error('Project action catalog lookup failure was not corrected');
}
