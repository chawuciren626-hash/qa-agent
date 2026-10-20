import { dataPath } from './directory-context.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { writeJson } from './orchestration-state.mjs';
import { assertParentSession } from './stage-evidence.mjs';
import { classifyRecoverable, correctionLimit, recordCorrection, isSafeArtifactAction, safeStoppedOperation, stalledCorrection } from './recovery-policy.mjs';
import { assertUnlinked } from './skill-resources.mjs';
import { processAbsent, ownProcessIdentity, ownerHasExited } from './process-identity.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export class ControllerGateError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
function location(root, id) {
  if (!/^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(id ?? '')) throw new Error('Valid controller session required');
  return dataPath(root, 'output/controller-command-sessions', id, 'state.json');
}
export function readControllerSession(root, id) {
  const path = location(root, id);
  if (!existsSync(path)) return { status: 'not_started', session_id: id, sha256: null };
  const raw = readFileSync(path); const state = JSON.parse(raw);
  if (state.session_id !== id || !['ready', 'running', 'stopped'].includes(state.status) || !Array.isArray(state.events)) throw new Error('Invalid controller session state');
  return { ...state, sha256: digest(raw) };
}
function recoverControllerLock(root,id,lock) {
  let raw,owner;
  try {raw=readFileSync(lock,'utf8');} catch(error) {if(error.code==='ENOENT') return;throw error;}
  try {owner=JSON.parse(raw);} catch {return;}
  // Legacy live PIDs remain protected; identity permits detecting a replaced PID.
  if(owner?.version!==2 || owner.host!==hostname() || owner.session_id!==id ||
    !/^[a-f0-9-]{36}$/.test(owner.token ?? '') || !ownerHasExited(owner.pid,owner.process_identity)) return;
  const audit=resolve(lock,'..','lock-recovery');assertUnlinked(dataPath(root,'output'),audit);mkdirSync(audit,{recursive:true});
  let key=digest(raw),claimed=false;
  // Append an immutable claim chain if a recovery process itself exited mid-recovery.
  for(let depth=0;depth<16;depth++) {
    const claim=resolve(audit,`${key}.json`);assertUnlinked(audit,claim);
    try {
      writeFileSync(claim,JSON.stringify({at:new Date().toISOString(),previous_lock:owner,previous_sha256:digest(raw),
        predecessor:key,claimant:{host:hostname(),pid:process.pid,process_identity:ownProcessIdentity(),token:randomUUID()},
        product_actions_replayed:false}),{flag:'wx'});
      claimed=true;break;
    } catch(error) {
      if(error.code!=='EEXIST') throw error;
      let previous,claimRaw;
      try {claimRaw=readFileSync(claim,'utf8');previous=JSON.parse(claimRaw);} catch {throw error;}
      if(previous.previous_sha256!==digest(raw) || previous.claimant?.host!==hostname() ||
        !/^[a-f0-9-]{36}$/.test(previous.claimant.token ?? '') ||
        !ownerHasExited(previous.claimant.pid,previous.claimant.process_identity)) throw error;
      key=digest(claimRaw);
    }
  }
  if(!claimed) throw new ControllerGateError('Recovery claim history needs inspection; preserve all ownership records','session_running');
  if(readFileSync(lock,'utf8')!==raw) throw new ControllerGateError('Controller lock owner changed; preserve current lock','session_running');
  unlinkSync(lock);
}
function locked(root, id, operation) {
  const path = location(root, id);assertUnlinked(dataPath(root,'output'),path);mkdirSync(resolve(path, '..'), { recursive: true });
  const lock = `${path}.lock`;assertUnlinked(dataPath(root,'output'),lock);
  const owner=JSON.stringify({version:2,host:hostname(),session_id:id,pid:process.pid,process_identity:ownProcessIdentity(),token:randomUUID(),at:new Date().toISOString()});
  try {writeFileSync(lock,owner,{flag:'wx'});} catch(error) {
    if(error.code!=='EEXIST') throw error;
    recoverControllerLock(root,id,lock);writeFileSync(lock,owner,{flag:'wx'});
  }
  try { return operation(path); } finally {
    if(readFileSync(lock,'utf8')!==owner) throw new ControllerGateError('Controller lock ownership changed; preserve current lock','session_running');
    unlinkSync(lock);
  }
}
const wait = ms => new Promise(done=>setTimeout(done,ms));
export function controllerCommandIsLive(state) {
  if(state.status!=='running' || !Number.isInteger(state.owner_pid)) return false;
  return !ownerHasExited(state.owner_pid,state.owner_identity);
}
async function lockedAsync(root,id,operation) {
  const until=Date.now()+5000;
  while(true) {
    try {return locked(root,id,operation);}
    catch(error) {
      if(error.code!=='EEXIST' || Date.now()>=until) throw error;
      await wait(25);
    }
  }
}
function recoverValidationStop(root,state) {
  if(state.status!=='stopped' || state.failure?.status!=='failed' || state.failure.exit_code!==2) return false;
  if(state.events.some(e=>e.type==='validation_stop_recovered' && JSON.stringify(e.previous_failure)===JSON.stringify(state.failure))) return false;
  const latest=state.events.filter(e=>e.type==='command_failed').at(-1);
  if(JSON.stringify(latest?.failure)!==JSON.stringify(state.failure)) return false;
  try {
    const base=realpathSync(dataPath(root,'output'));
    const dir=realpathSync(state.failure.evidence_dir);
    const rel=relative(base,dir).replaceAll('\\','/');
    if(!/^(?:command-runs|runs\/run-[A-Za-z0-9-]+\/audit\/commands)\/[a-f0-9-]{36}$/.test(rel)) return false;
    const recordPath=resolve(dir,'command.json'),logPath=resolve(dir,'command.log');
    if(realpathSync(recordPath)!==recordPath || realpathSync(logPath)!==logPath) return false;
    const bytes=readFileSync(recordPath),command=JSON.parse(bytes);
    const logBytes=readFileSync(logPath),report=JSON.parse(logBytes.toString('utf8'));
    if(command.script!=='validate-artifacts.mjs' || command.status!=='failed' || command.result?.code!==2 || command.result?.termination_confirmed!==true || command.result.termination || command.result.signal) return false;
    if(report.status!=='blocked' || !Array.isArray(report.errors) || !report.errors.length || !/^run-[A-Za-z0-9-]+$/.test(report.run_id ?? '')) return false;
    state.events.push({type:'validation_stop_recovered',at:new Date().toISOString(),reason:'Verified read-only artifact validation was incorrectly treated as product execution; no product action retried',previous_failure:state.failure,evidence:{command_sha256:digest(bytes),log_sha256:digest(logBytes)},run_id:report.run_id});
    return true;
  } catch {return false;}
}
function recoverExitedController(root,state) {
  if(state.status!=='running' || !ownerHasExited(state.owner_pid,state.owner_identity)) return false;
  const prior={token:state.token,owner_pid:state.owner_pid,owner_identity:state.owner_identity,active_action:state.active_action,started_at:state.command_started_at};
  let evidenceDir=null;
  if(state.active_action==='browser_task' && /^run-[A-Za-z0-9-]+$/.test(state.active_run_id ?? '')) {
    const base=dataPath(root,'output/runs',state.active_run_id,'audit/commands');assertUnlinked(dataPath(root,'output'),base);
    if(existsSync(base)) {
      const matches=readdirSync(base).filter(name=>/^[a-f0-9-]{36}$/.test(name)).flatMap(name=>{
        const path=resolve(base,name,'command.json');assertUnlinked(base,path);
        try {const command=JSON.parse(readFileSync(path,'utf8'));return command.owner_pid===state.owner_pid && command.script==='browser-task.mjs' &&
          command.run_id===state.active_run_id && Date.parse(command.started_at)>=Date.parse(state.command_started_at)?[{dir:resolve(base,name),command}]:[];} catch {return [];}
      });
      if(matches.length===1 && processAbsent(matches[0].command.child_pid)) evidenceDir=matches[0].dir;
    }
  }
  const failure={status:'owner_exited',evidence_dir:evidenceDir,run_id:state.active_run_id ?? null,
    stage:state.active_stage ?? null,action:state.active_action ?? null};
  state.status='stopped';
  if(state.failure) (state.continuation_failures ??= []).push(failure);
  else state.failure=failure;
  state.events.push({type:'controller_owner_exited',at:new Date().toISOString(),previous_owner:prior,failure:state.failure,
    ...(state.failure!==failure?{continuation_failure:failure}:{}),product_actions_replayed:false});
  return true;
}
function permitsBrowserInspection(root,state,context) {
  if(state.continuation_failures?.length) return false;
  if(context?.action!=='browser_task' || !['health','snapshot','assert','finish','recover'].includes(context.browser_operation) ||
    !['timeout','failed','cleanup_required','owner_exited'].includes(state.failure?.status)) return false;
  try {
    const runId=context.run_id;
    if(!/^run-[A-Za-z0-9-]+$/.test(runId ?? '')) return false;
    const base=realpathSync(dataPath(root,'output/runs',runId,'audit/commands'));
    const dir=realpathSync(state.failure.evidence_dir),rel=relative(base,dir);
    if(!/^[a-f0-9-]{36}$/.test(rel)) return false;
    assertUnlinked(base,resolve(dir,'command.json'));
    const command=JSON.parse(readFileSync(resolve(dir,'command.json'),'utf8'));
    if(command.run_id!==runId || command.script!=='browser-task.mjs' || command.result?.termination==='interrupted' ||
      !processAbsent(command.child_pid)) return false;
    const event=state.events.filter(e=>['command_failed','controller_owner_exited','browser_failure_inspected','restricted_command_continued'].includes(e.type)).at(-1);
    return JSON.stringify(event?.failure ?? event?.previous_failure)===JSON.stringify(state.failure);
  } catch {return false;}
}
export function permitsArtifactContinuation(root,state,context) {
  if (!safeStoppedOperation(context) || !state.failure || typeof state.failure.status!=='string') return false;
  // Old states without termination evidence stay restricted. A receipt or an
  // absent child is required; an exited controller alone proves nothing.
  const failures=[state.failure,...(state.continuation_failures ?? [])];
  return failures.every(failure=>{
    if(!failure || typeof failure.status!=='string') return false;
    if(failure.termination_confirmed===true) return true;
    try {
      const base=realpathSync(dataPath(root,'output'));
      const dir=realpathSync(failure.evidence_dir);
      const rel=relative(base,dir).replaceAll('\\','/');
      if(!/^(?:command-runs|runs\/run-[A-Za-z0-9-]+\/audit\/commands)\/[a-f0-9-]{36}$/.test(rel)) return false;
      const path=resolve(dir,'command.json');assertUnlinked(base,path);
      const command=JSON.parse(readFileSync(path,'utf8'));
      if(command.result?.termination_confirmed===false) return false;
      return Number.isInteger(command.child_pid) ? processAbsent(command.child_pid) : command.result?.termination_confirmed===true;
    } catch {return false;}
  });
}
export function permitsIndependentRunContinuation(root,state,context) {
  if(!/^run-[A-Za-z0-9-]+$/.test(context?.run_id ?? '') || !state.failure) return false;
  const failures=[state.failure,...(state.continuation_failures ?? [])];
  return failures.every(failure=>/^run-[A-Za-z0-9-]+$/.test(failure?.run_id ?? '') && failure.run_id!==context.run_id) &&
    permitsArtifactContinuation(root,state,{action:'handoff'});
}
function assertCorrectionProgress(state,context) {
  const recovery=stalledCorrection(state,context);
  if(!recovery) return;
  const error=new ControllerGateError('Repeated failure has no recorded progress; inspect and repair artifacts or deliver verified partial results','correction_stalled');
  error.recovery=recovery;throw error;
}
function commandDirectories(root,context) {
  const bases=[dataPath(root,'output/command-runs')];
  if(/^run-[A-Za-z0-9-]+$/.test(context?.run_id ?? '')) bases.push(dataPath(root,'output/runs',context.run_id,'audit/commands'));
  return bases;
}
function unresolvedOwnedCommand(root,context,startedAt,priorCommands) {
  if(!priorCommands) throw new Error('Command inventory unavailable');
  const bases=commandDirectories(root,context);
  for(const base of bases) {
    if(!existsSync(base)) continue;
    assertUnlinked(dataPath(root,'output'),base);
    for(const name of readdirSync(base).filter(name=>/^[a-f0-9-]{36}$/.test(name))) {
      if(priorCommands.get(base)?.has(name) && statSync(resolve(base,name)).mtimeMs<Date.parse(startedAt)) continue;
      const path=resolve(base,name,'command.json');
      if(!existsSync(path)) continue;
      assertUnlinked(base,path);
      const command=JSON.parse(readFileSync(path,'utf8'));
      if(command.owner_pid!==process.pid || Date.parse(command.started_at)<Date.parse(startedAt)) continue;
      if(command.result?.termination_confirmed!==true && !processAbsent(command.child_pid)) return resolve(base,name);
    }
  }
  return null;
}
export async function withControllerSession(root, id, operation, { diagnostic = false, agentRoot, recoveryContext, queue = false, signal } = {}) {
  assertParentSession(root, 'run-command-session', id, agentRoot);
  // Read-only operations do not own the mutation token; only their failure journal is locked.
  if (recoveryContext?.readOnly) {
    const snapshot=readControllerSession(root,id);
    assertCorrectionProgress(snapshot,recoveryContext);
    try {
      const result = await operation();
      if (snapshot.correction_progress?.[recoveryContext.key]) await lockedAsync(root,id,path=>{
        const state=readControllerSession(root,id);delete state.sha256;
        if(state.correction_progress) delete state.correction_progress[recoveryContext.key];
        writeJson(path,state);
      });
      return result;
    }
    catch(error) {
      if (classifyRecoverable(error,null,recoveryContext)!=='read_correction' || snapshot.status==='stopped') throw error;
      await lockedAsync(root,id,path=>{
        const state=readControllerSession(root,id);delete state.sha256;
        state.version ??= 1;state.status=state.status==='not_started'?'ready':state.status;
        state.events ??= [];state.corrections ??= {};
        error.recovery=recordCorrection(state,'read_correction',recoveryContext,error,null);
        state.events.push({type:'diagnostic_failed',at:new Date().toISOString(),failure:{error:error.message},recovery:error.recovery});writeJson(path,state);
      });
      throw error;
    }
  }
  const token = randomUUID();let restrictedFailure;
  const acquire = () => lockedAsync(root, id, path => {
    const state = readControllerSession(root, id);
    // Older releases cleared the product latch after close/recover/review. Restore
    // it from the immutable audit before allowing another mutating operation.
    if(state.status==='ready' && !state.failure) {
      const prior=state.events?.filter(e=>['browser_failure_closed','browser_failure_recovered_partial','review_accepted','validation_stop_recovered'].includes(e.type) && e.previous_failure).at(-1);
      if(prior) {
        state.status='stopped';state.failure=prior.previous_failure;delete state.sha256;
        state.events.push({type:'legacy_product_restriction_restored',at:new Date().toISOString(),previous_failure:state.failure});
        writeJson(path,state);
      }
    }
    if(recoverExitedController(root,state)) {delete state.sha256;writeJson(path,state);}
    if(recoverValidationStop(root,state)) {delete state.sha256;writeJson(path,state);}
    if (state.status === 'running') throw new ControllerGateError('Controller command is running or interrupted; inspect before recovery', 'session_running');
    assertCorrectionProgress(state,recoveryContext);
    if (state.status === 'stopped') {
      if (diagnostic) return true;
      if(permitsBrowserInspection(root,state,recoveryContext) || permitsArtifactContinuation(root,state,recoveryContext) ||
        permitsIndependentRunContinuation(root,state,recoveryContext)) restrictedFailure=state.failure;
      else throw new ControllerGateError('Controller session stopped by unresolved execution or runtime failure; use safe diagnostics or verified browser inspection/partial finish, never replay uncertain writes or ask the user for unlock documents', 'session_stopped');
    }
    delete state.sha256;
    Object.assign(state, { version: 1, status: 'running', token, owner_pid: process.pid, owner_identity:ownProcessIdentity(), active_action:recoveryContext?.action ?? null, active_run_id:recoveryContext?.run_id ?? null, active_stage:recoveryContext?.action==='browser_task'?'execution':recoveryContext?.stage ?? null, command_started_at:new Date().toISOString(), events: state.events ?? [] });
    state.events.push({ type: 'command_started', token, at: new Date().toISOString() }); writeJson(path, state); return false;
  });
  let pausedDiagnostic;
  const waitUntil=Date.now()+180000;
  while(true) {
    if(signal?.aborted) throw new ControllerGateError('Queued action cancelled before execution','queue_cancelled');
    try {pausedDiagnostic=await acquire();break;}
    catch(error) {
      if(!queue || error.code!=='session_running' || !controllerCommandIsLive(readControllerSession(root,id)) || Date.now()>=waitUntil) throw error;
      await wait(100);
    }
  }
  // Diagnostics may observe a stopped session, but never clear its original failure.
  if (pausedDiagnostic) return operation();
  let result; let failure; let caught;let priorCommands;
  try {
    if(isSafeArtifactAction(recoveryContext)) priorCommands=new Map(commandDirectories(root,recoveryContext).map(base=>[base,new Set(existsSync(base)?readdirSync(base):[])]));
    result = await operation();
    if ((result.exit_code !== undefined && result.exit_code !== 0) || !['completed', 'ready', 'help'].includes(result.status)) failure = { status: result.status, exit_code: result.exit_code ?? 2, evidence_dir: result.evidence_dir ?? null,
      ...(result.result?.termination_confirmed===true?{termination_confirmed:true}:{}) };
  } catch (error) { caught = error; failure = { status: 'input_or_runner_error', error: error.message }; }
  let recovery;
  await lockedAsync(root, id, path => {
    const state = readControllerSession(root, id);
    if (state.token !== token || state.status !== 'running') throw new Error('Controller session changed during command');
    delete state.sha256;
    if(failure) Object.assign(failure,{run_id:state.active_run_id ?? null,stage:state.active_stage ?? null,action:state.active_action ?? null});
    let category = failure && classifyRecoverable(caught, result, recoveryContext);
    if(caught && category && isSafeArtifactAction(recoveryContext)) {
      try {
        const evidence=unresolvedOwnedCommand(root,recoveryContext,state.command_started_at,priorCommands);
        if(evidence) {category=null;failure.evidence_dir=evidence;}
      } catch {category=null;}
    }
    if (category) {
      recovery = recordCorrection(state,category,recoveryContext,caught,result);
      if(caught?.code==='attachment_import_required') recovery={...recovery,retry_allowed:false,next_action:'request_attachment_once',
        user_message:'该目录尚未导入当前会话。请通过附件按钮上传本次所需文件；已有材料能完成的部分会继续处理。',scope:'same_unimported_source_only'};
    }
    if(!failure && recoveryContext?.key && state.correction_progress) delete state.correction_progress[recoveryContext.key];
    state.status = failure && !category ? 'stopped' : 'ready';
    state.events.push({ type: failure ? 'command_failed' : 'command_completed', token, at: new Date().toISOString(), ...(failure ? { failure } : {}), ...(recovery ? { recovery } : {}) });
    if (failure && !category) state.failure = failure;
    if(restrictedFailure) {
      const closed=!failure && recoveryContext.browser_operation==='finish' && result?.data?.status==='closed';
      const recovered=!failure && recoveryContext.browser_operation==='recover' && result?.data?.status==='recovered_partial';
      state.status='stopped';
      state.events.push({type:closed?'browser_failure_closed':recovered?'browser_failure_recovered_partial':recoveryContext.action==='browser_task'?'browser_failure_inspected':'restricted_command_continued',at:new Date().toISOString(),
        run_id:state.active_run_id,stage:state.active_stage,action:state.active_action,
        operation:recoveryContext.browser_operation,previous_failure:restrictedFailure,product_actions_replayed:false});
      if(failure && !category) (state.continuation_failures ??= []).push(failure);
      state.failure=restrictedFailure;
    }
    writeJson(path, state);
  });
  if (caught) { if (recovery) caught.recovery = recovery; throw caught; }
  return recovery ? { ...result, recovery } : result;
}
export function reviewControllerSession(root, id, options, agentRoot) {
  assertParentSession(root, 'run-command-session', id, agentRoot);
  for (const key of ['expected-sha256','actor','reason','approval-ref','evidence']) if (!options[key]?.trim()) throw new Error(`Review requires ${key}`);
  const base = realpathSync(dataPath(root, 'output'));
  const evidence = realpathSync(dataPath(root, options.evidence)); const rel = relative(base, evidence);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || !statSync(evidence).isFile()) throw new Error('Review evidence must be an existing file inside project output');
  const bytes = readFileSync(evidence); if (!bytes.toString('utf8').trim()) throw new Error('Review evidence is empty');
  return locked(root, id, path => {
    const state = readControllerSession(root, id);
    const correctionKey = options['correction-key'];
    const budgetReview = correctionKey === 'input_correction' && state.status === 'ready' && (state.corrections?.[correctionKey] ?? 0) > correctionLimit;
    if (state.sha256 !== options['expected-sha256'] || (correctionKey ? !budgetReview : state.status !== 'stopped')) throw new Error('Review requires stopped state or an explicitly selected exhausted input budget and exact reviewed SHA256');
    delete state.sha256;
    state.events.push({ type: 'review_accepted', at: new Date().toISOString(), ...options, evidence_sha256: digest(bytes), previous_failure: state.failure, ...(budgetReview ? {previous_correction_count:state.corrections[correctionKey]} : {}) });
    if (budgetReview) delete state.corrections[correctionKey];
    writeJson(path, state);
    return { status: state.status, session_id: id, resumed_execution: false, sha256: digest(readFileSync(path)) };
  });
}
