import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { applicationDataRoot, assertPlainPath } from './application-data.mjs';
import { readRunFile, runDirectory, assertConfirmedExecutionCases, assertExecutionDesignReady } from './design-quality.mjs';
import { inspectApiContract, apiHash } from './api-contract.mjs';
import { validateApiCases } from './api-engine.mjs';
import { executionSummary } from './execution-summary.mjs';
import { CommandUsageError } from './command-contracts.mjs';
import { request as playwrightRequest } from '@playwright/test';
import { apiTarget } from './api-engine.mjs';
import { protectedInputs } from './protected-inputs.mjs';
import { ownerHasExited } from './process-identity.mjs';
import { captureApiSnapshot } from './api-snapshot.mjs';

export function apiWrite(path, value) {
  assertPlainPath(path); mkdirSync(resolve(path, '..'), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); renameSync(temp, path);
}
export const apiRead = path => JSON.parse(readFileSync(assertPlainPath(path), 'utf8'));
export const apiPrivateDirectory = (root, owner, runId, dispatchId) => assertPlainPath(resolve(applicationDataRoot(root), 'api-tasks', apiHash([owner, runId, dispatchId])));
export function validateApiOperation(op) {
  if (!op || !['inspect_contract', 'prepare', 'start', 'status', 'resume', 'cancel', 'collect'].includes(op.type)) throw new Error('api_task operation must be inspect_contract|prepare|start|status|resume|cancel|collect');
  const fields = { inspect_contract: ['source_path', 'url', 'operations'], prepare: ['cases_path', 'contract_path'], start: [], status: [], resume: ['credentials'], cancel: [], collect: ['partial'] }[op.type];
  if (Object.keys(op).some(k => !['type', ...fields].includes(k))) throw new Error('Unknown API operation field');
  if(op.partial!==undefined && typeof op.partial!=='boolean')throw new Error('collect partial must be boolean');
}
function sourceFile(dir, path) {
  if (typeof path !== 'string' || !(/^(inputs|analysis|design)\//.test(path) || path==='execution/api/scenario-draft.json') || path.includes('\\') || path.split('/').some(p => ['', '.', '..'].includes(p))) throw new Error('Use a current run inputs/, analysis/, design/ source or API scenario adaptation draft');
  return readRunFile(dir, path);
}
function assertCitations(dir, plan, nativeMessages) {
  const verify = reference => {
    const bytes = sourceFile(dir, reference.source_path).data.toString('utf8');
    if (!reference.quote || !bytes.includes(reference.quote)) throw new Error('API source quote does not match immutable input');
    return bytes;
  };
  for (const scope of plan.scope) {
    verify(scope);
    if (!scope.quote.includes(scope.url)) throw new Error('API scope URL must appear in cited source');
  }
  for (const scenario of plan.scenarios) scenario.source_refs.forEach(verify);
  if (!nativeMessages.some(t => /测试|执行|\btest|\bexecute/i.test(t) && !/不要执行|不执行|只生成|只设计|do not execute/i.test(t))) throw new Error('Current native user request must authorize testing');
  if (plan.write_authorization) {
    verify(plan.write_authorization);
    const quote=plan.write_authorization.quote;
    if (!nativeMessages.some(t => t.trim()===quote.trim())) throw new Error('Write authorization must preserve the complete native user message, including restrictions');
    const patterns={POST:/创建|新增|写入|POST|CRUD|create/i,PUT:/修改|更新|PUT|CRUD|update/i,PATCH:/修改|更新|PATCH|CRUD|update/i,DELETE:/删除|DELETE|CRUD/i};
    for(const step of plan.scenarios.flatMap(s=>s.steps).filter(s=>patterns[s.method] || s.side_effect)) {
      const pattern=patterns[step.method]??/副作用|写入|CRUD/i;
      if(!pattern.test(quote) || quote.split(/[，,;；。\n]/).some(clause=>/禁止|不要|不得|不允许|do not|don't/i.test(clause) && (pattern.test(clause)||/写操作|写入|修改任何|任何变更|any writes/i.test(clause)))) throw new Error('Native user message does not authorize this write method');
    }
  }
}
export async function apiTask(root, runId, owner, op, { nativeMessages = [] } = {}) {
  try {
    validateApiOperation(op);
    const dir = runDirectory(root, runId), manifest = apiRead(resolve(dir, 'manifest.json'));
    if (op.type === 'inspect_contract') {
      let sourcePath=op.source_path;
      if(op.url) {
        const cited=sourceFile(dir,sourcePath).data.toString('utf8');
        if(!cited.includes(op.url)) throw new Error('Document URL must appear in current archived source');
        apiTarget(op.url,[{url:op.url}]);
        const cached=resolve(dir,'inputs',`api-contract-${apiHash(op.url)}.json`);
        if(!existsSync(cached)) {
          const context=await playwrightRequest.newContext({ignoreHTTPSErrors:false});
          try {
            const response=await context.get(op.url,{timeout:15000,maxRedirects:0,maxRetries:0});
            if(!response.ok() || Number(response.headers()['content-length']??0)>4*1024*1024) throw new Error('API document unavailable or oversized');
            const bytes=await response.body();inspectApiContract(bytes);
            // The URL cache is run-local and immutable; a new version is a new explicit input.
            writeFileSync(assertPlainPath(cached),bytes,{flag:'wx'});
          } finally {await context.dispose();}
        }
        sourcePath=`inputs/api-contract-${apiHash(op.url)}.json`;
      }
      const file = sourceFile(dir, sourcePath);
      return inspectApiContract(file.data, { operations: op.operations ?? [], source_path: sourcePath });
    }
    const dispatch = manifest.orchestration?.events?.filter(e => e.type === 'dispatched' && e.stage === 'api_execution').at(-1);
    if (dispatch?.['parent-session-id'] !== owner || !dispatch.dispatch_id || manifest.stages?.api_execution?.status !== 'in_progress') throw new Error('Current owned API dispatch required');
    const privateDir = apiPrivateDirectory(root, owner, runId, dispatch.dispatch_id), statePath = resolve(privateDir, 'state.json');
    mkdirSync(privateDir, { recursive: true });
    if (op.type === 'prepare') {
      assertExecutionDesignReady(dir,'api_execution');
      const file = sourceFile(dir, op.cases_path), input = protectedInputs().protect(owner,JSON.parse(file.data));
      assertConfirmedExecutionCases(input.scenarios??input.cases??input.test_cases??input);
      // Existing design rows keep normal Excel fields; api_scenario is the executable extension.
      const plan = input.scenarios ? input : { ...input.api_plan, version: 1, scenarios: (input.cases ?? input.test_cases ?? input).filter(c => c.execution_layer === 'api' || c.api_scenario).map(c => ({ ...c.api_scenario, case_id: c.case_id ?? c.id, expected: c.expected, title: c.title })) };
      validateApiCases(plan); assertCitations(dir, plan, nativeMessages);
      if(op.cases_path==='execution/api/scenario-draft.json') for(const scenario of plan.scenarios) {
        const ref=scenario.case_source;
        if(!ref || ref.source_path===op.cases_path) throw new Error('Adapted scenarios must identify original design cases');
        const original=JSON.parse(sourceFile(dir,ref.source_path).data),rows=Array.isArray(original)?original:original.cases??original.test_cases??original.scenarios;
        const row=rows?.find(c=>(c.case_id??c.id)===scenario.case_id);
        if(!row || row.expected!==scenario.expected) throw new Error('Adaptation must preserve the original source case ID and exact expected result');
        assertConfirmedExecutionCases([row]);
      }
      if(manifest.orchestration?.plan?.execution_branches?.includes('execution')) {
        const keys=manifest.stages.api_execution.resource_keys ?? [];
        for(const scenario of plan.scenarios) if(scenario.steps.some(s=>!['GET','HEAD','OPTIONS'].includes(s.method) || s.side_effect)) {
          if((scenario.resources??[]).some(key=>!keys.includes(key))) throw new Error('Mixed UI/API writes must declare scenario resource keys on dispatch');
        }
      }
      const planHash = apiHash(plan);
      if (existsSync(statePath)) { const prior = apiRead(statePath); if (prior.plan_sha256 !== planHash) throw new Error('Prepared API design is immutable; use a new explicit revision, not a replay'); return publicState(prior); }
      const sourcePaths=[...new Set(plan.scenarios.flatMap(s=>s.case_source?[s.case_source.source_path]:s.source_refs.map(r=>r.source_path)))];
      const binding = { run_id: runId, stage: 'api_execution', dispatch_id: dispatch.dispatch_id, attempt_id: randomUUID(), owner, child_session:process.env.PENGUIN_SESSION_ID ?? null, agent_root:process.env.PENGUIN_AGENT_ROOT ?? null, run_dir: dir, private_dir: privateDir, engine_root: root, source_path: op.cases_path, source_paths:sourcePaths, source_sha256: file.sha256, plan_sha256: planHash };
      const contract = op.contract_path ? inspectApiContract(sourceFile(dir, op.contract_path).data, { source_path: op.contract_path }) : { limitations: ['No machine-readable contract supplied; only explicit design expectations are checked'] };
      apiWrite(resolve(dir, 'execution/api/contract.json'), contract);
      apiWrite(resolve(dir, 'execution/api/cases.json'), { ...binding, owner: undefined, agent_root:undefined, private_dir: undefined, engine_root: undefined, run_dir: undefined, plan });
      apiWrite(resolve(privateDir, 'plan.json'), plan);
      apiWrite(statePath, { ...binding, status: 'prepared', prepared_at: new Date().toISOString(), pid: null, receipts: {} });
      return publicState(apiRead(statePath));
    }
    if (!existsSync(statePath)) throw new Error('API task has not been prepared');
    let state = apiRead(statePath);
    if (readRunFile(dir, state.source_path).sha256 !== state.source_sha256) throw new Error('Design source changed after prepare');
    if (op.type === 'cancel') { apiWrite(resolve(privateDir, 'cancel.json'), { at: new Date().toISOString() }); return { ...publicState(state), cancellation_requested: true }; }
    if(op.type==='resume' && op.credentials) {
      if(state.status!=='waiting_human') throw new Error('No API authentication wait is active');
      if(!op.credentials || typeof op.credentials!=='object' || Array.isArray(op.credentials) || Object.keys(op.credentials).length>10) throw new Error('Use named task credential references');
      for(const [key,ref] of Object.entries(op.credentials)) {
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(key)) throw new Error('Invalid credential key');
        protectedInputs().get(owner,ref);
      }
      apiWrite(resolve(privateDir,`resume-${state.action_id}.json`),{credentials:op.credentials,at:new Date().toISOString()});
      return {...publicState(state),continuation_requested:true,replayed:false};
    }
    if (op.type === 'start' || op.type === 'resume') {
      if (state.status !== 'prepared') return { ...publicState(state), replayed: false, note: 'Existing attempt retained; no request or worker restarted' };
      // The exclusive launch marker survives crashes. An uncertain spawn is never repeated.
      const launch = resolve(privateDir, 'launch.json');
      try { writeFileSync(launch, JSON.stringify({ at: new Date().toISOString() }), { flag: 'wx' }); } catch { return { ...publicState(state), status: 'launch_uncertain', replayed: false }; }
      state.status = 'starting'; apiWrite(statePath, state);
      const worker = spawn(process.execPath, [resolve(import.meta.dirname, 'api-worker.mjs'), privateDir], { cwd: root, env: { ...process.env }, windowsHide: true, detached: true, stdio: 'ignore' });
      await new Promise((ok, fail) => { worker.once('spawn', ok); worker.once('error', fail); }); worker.unref();
      apiWrite(launch,{pid:worker.pid,at:new Date().toISOString()});
      return { ...publicState(state), worker_pid: worker.pid, note: 'Worker started; use status/collect. No network wait holds the controller queue.' };
    }
    if (['starting', 'running','waiting_human'].includes(state.status)) {
      const pid=state.pid ?? (existsSync(resolve(privateDir,'launch.json'))?apiRead(resolve(privateDir,'launch.json')).pid:null);
      if(pid && ownerHasExited(pid,state.process_identity)) state = { ...state, status: 'interrupted', worker_lost: true };
    }
    if (op.type === 'collect') {
      if (!['completed', 'cancelled', 'interrupted', 'failed'].includes(state.status) && !op.partial) throw new Error('API worker is active; use collect partial=true for a timestamped snapshot');
      if(state.worker_lost) recoverApiResults(dir,state,apiRead(resolve(privateDir,'plan.json')));
      if(op.partial===true) return {...publicState(state),snapshot:true,...await captureApiSnapshot(root,state)};
      apiWrite(resolve(dir,'quality/execution-summary.json'),executionSummary(dir,manifest,{partial:true}));
      return { ...publicState(state), result_path: 'execution/api/test_results.json', task_path: 'execution/api/task.json', snapshot: !['completed', 'cancelled'].includes(state.status) };
    }
    return publicState(state);
  } catch (error) { throw new CommandUsageError(error.message); }
}
function recoverApiResults(dir,state,plan) {
  const identity={run_id:state.run_id,stage:'api_execution',dispatch_id:state.dispatch_id,attempt_id:state.attempt_id};
  const verified=new Map(),evidence=[];
  for(const [id,privateReceipt] of Object.entries(state.receipts ?? {})) {
    try {const file=readRunFile(dir,`execution/api/evidence/${id}.json`),receipt=JSON.parse(file.data);if(receipt.dispatch_id!==state.dispatch_id || receipt.attempt_id!==state.attempt_id || receipt.request_sha256!==privateReceipt.request_sha256)continue;verified.set(id,receipt);evidence.push({path:file.path,sha256:file.sha256});}catch{}
  }
  const cases=plan.scenarios.map(s=>{
    const receipts=s.steps.map(step=>verified.get(step.request_id)),unknown=receipts.some(r=>r && ['started','unknown'].includes(r.status) && (!['GET','HEAD','OPTIONS'].includes(r.method)||r.side_effect));
    const status=receipts.length && receipts.every(r=>r?.status==='passed')?'passed':receipts.some(r=>r?.status==='failed')?'failed':'blocked';
    return {case_id:`api:${s.scenario_id}`,source_case_id:s.case_id,scenario_id:s.scenario_id,title:s.title??s.case_id,expected:s.expected,status,layer:'api',attempt:1,result_unknown:unknown,actual_result:'Worker exited; recovered only recorded receipts, no request replay',assertions:receipts.flatMap(r=>r?.assertions??[]),evidence_paths:receipts.filter(Boolean).map(r=>`execution/api/evidence/${r.request_id}.json`)};
  });
  const result={...identity,layer:'api',result_origin:'recovered_api',status:'partial',started_at:state.started_at??state.prepared_at,finished_at:new Date().toISOString(),execution_finished_at:null,worker_termination:'observed_absent',cases,evidence,summary:{total:cases.length,...Object.fromEntries(['passed','failed','blocked','skipped'].map(s=>[s,cases.filter(c=>c.status===s).length]))},unknown_resources:plan.scenarios.filter(s=>cases.find(c=>c.scenario_id===s.scenario_id)?.result_unknown).flatMap(s=>s.resources??[])};
  apiWrite(resolve(dir,'execution/api/test_results.json'),result);
  apiWrite(resolve(dir,'execution/api/task.json'),{...identity,outcome:'partial',summary:'接口 worker 已退出，仅从原回执恢复部分结果；没有重发请求。',source_paths:state.source_paths??[state.source_path],questions:[],limitations:['Worker 未正常终结；未完成与未知结果保留。']});
}
function publicState(s) {
  return { run_id: s.run_id, stage: s.stage, dispatch_id: s.dispatch_id, attempt_id: s.attempt_id, status: s.status, started_at: s.started_at, finished_at: s.finished_at, plan_sha256: s.plan_sha256, worker_lost: s.worker_lost ?? false, ...(s.status==='waiting_human'?{credential_key:s.credential_key,action_id:s.action_id,question:'请提供当前接口所需认证，原任务和已执行请求已保留。'}:{}) };
}
