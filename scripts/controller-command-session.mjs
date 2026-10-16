import { dataPath } from './directory-context.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeJson } from './orchestration-state.mjs';
import { assertParentSession } from './stage-evidence.mjs';
import { classifyRecoverable, correctionLimit, recordCorrection } from './recovery-policy.mjs';

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
function locked(root, id, operation) {
  const path = location(root, id); mkdirSync(resolve(path, '..'), { recursive: true });
  const lock = `${path}.lock`; writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  try { return operation(path); } finally { unlinkSync(lock); }
}
const wait = ms => new Promise(done=>setTimeout(done,ms));
export function controllerCommandIsLive(state) {
  if(state.status!=='running' || !Number.isInteger(state.owner_pid)) return false;
  try {process.kill(state.owner_pid,0);return true;} catch {return false;}
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
    state.status='ready';delete state.failure;
    return true;
  } catch {return false;}
}
export async function withControllerSession(root, id, operation, { diagnostic = false, agentRoot, recoveryContext, queue = false, signal } = {}) {
  assertParentSession(root, 'run-command-session', id, agentRoot);
  // Read-only operations do not own the mutation token; only their failure journal is locked.
  if (recoveryContext?.readOnly) {
    const snapshot=readControllerSession(root,id);
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
  const token = randomUUID();
  const acquire = () => lockedAsync(root, id, path => {
    const state = readControllerSession(root, id);
    if(recoverValidationStop(root,state)) {delete state.sha256;writeJson(path,state);}
    if (state.status === 'running') throw new ControllerGateError('Controller command is running or interrupted; inspect before recovery', 'session_running');
    if (state.status === 'stopped') {
      if (diagnostic) return true;
      throw new ControllerGateError('Controller session stopped by unresolved execution or runtime failure; system maintenance must inspect evidence. Do not ask the user for unlock documents or repeat approval requests', 'session_stopped');
    }
    delete state.sha256;
    Object.assign(state, { version: 1, status: 'running', token, owner_pid: process.pid, active_action:recoveryContext?.action ?? null, command_started_at:new Date().toISOString(), events: state.events ?? [] });
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
  let result; let failure; let caught;
  try {
    result = await operation();
    if ((result.exit_code !== undefined && result.exit_code !== 0) || !['completed', 'ready', 'help'].includes(result.status)) failure = { status: result.status, exit_code: result.exit_code ?? 2, evidence_dir: result.evidence_dir ?? null };
  } catch (error) { caught = error; failure = { status: 'input_or_runner_error', error: error.message }; }
  let recovery;
  await lockedAsync(root, id, path => {
    const state = readControllerSession(root, id);
    if (state.token !== token || state.status !== 'running') throw new Error('Controller session changed during command');
    delete state.sha256;
    const category = failure && classifyRecoverable(caught, result, recoveryContext);
    if (category) {
      recovery = recordCorrection(state,category,recoveryContext,caught,result);
      if(caught?.code==='attachment_import_required') recovery={...recovery,retry_allowed:false,next_action:'request_attachment_once',
        user_message:'该目录尚未导入当前会话。请通过附件按钮上传本次所需文件；已有材料能完成的部分会继续处理。',scope:'same_unimported_source_only'};
    }
    if(!failure && recoveryContext?.key && state.correction_progress) delete state.correction_progress[recoveryContext.key];
    state.status = failure && !category ? 'stopped' : 'ready';
    state.events.push({ type: failure ? 'command_failed' : 'command_completed', token, at: new Date().toISOString(), ...(failure ? { failure } : {}), ...(recovery ? { recovery } : {}) });
    if (failure && !category) state.failure = failure;
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
    delete state.sha256; state.status = 'ready';
    state.events.push({ type: 'review_accepted', at: new Date().toISOString(), ...options, evidence_sha256: digest(bytes), previous_failure: state.failure, ...(budgetReview ? {previous_correction_count:state.corrections[correctionKey]} : {}) });
    if (budgetReview) delete state.corrections[correctionKey];
    delete state.failure; writeJson(path, state);
    return { status: 'ready', session_id: id, resumed_execution: false, sha256: digest(readFileSync(path)) };
  });
}
