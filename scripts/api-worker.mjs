import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apiRead, apiWrite } from './api-task.mjs';
import { apiHash } from './api-contract.mjs';
import { executeApiPlan, redactApi } from './api-engine.mjs';
import { protectedInputs } from './protected-inputs.mjs';
import { applicationDataRoot } from './application-data.mjs';
import { readSession } from './stage-evidence.mjs';
import { randomUUID } from 'node:crypto';
import { ownProcessIdentity } from './process-identity.mjs';

export async function runApiWorker(privateDir) {
  const statePath = resolve(privateDir, 'state.json'), state = apiRead(statePath), plan = apiRead(resolve(privateDir, 'plan.json'));
  const marker = resolve(privateDir, 'worker.lock');
  try { writeFileSync(marker, String(process.pid), { flag: 'wx' }); } catch { return; }
  let checkedAt=0,parentCancelled=false;
  const cancelled = () => {
    if(state.agent_root && Date.now()-checkedAt>1000) {
      checkedAt=Date.now();
      try {parentCancelled=readSession(state.agent_root,'test_agent',state.owner).some(r=>Date.parse(r.timestamp)>=Date.parse(state.started_at) && r.payload?.type==='request_end' && ['cancelled','interrupted'].includes(r.payload.status));}catch{}
    }
    if(parentCancelled)return true;
    if(existsSync(resolve(privateDir, 'cancel.json')) || existsSync(resolve(state.run_dir, 'execution/api/cancel.json'))) return true;
    try {const m=apiRead(resolve(state.run_dir,'manifest.json'));return m.stages?.api_execution?.dispatch_id!==state.dispatch_id || ['failed','blocked','cancelled'].includes(m.stages.api_execution.status);}catch{return true;}
  };
  const resourceRoot = resolve(applicationDataRoot(state.engine_root), 'api-resources'); mkdirSync(resourceRoot, { recursive: true });
  const resourcePaths=key=>[...new Set(plan.scope.map(s=>new URL(s.url).origin))].sort().map(origin=>resolve(resourceRoot,`${apiHash([origin,key])}.json`));
  const held = new Set(), receipts = state.receipts ?? {};
  const identity = { run_id: state.run_id, stage: state.stage, dispatch_id: state.dispatch_id, attempt_id: state.attempt_id };
  state.status = 'running'; state.pid = process.pid; state.process_identity=ownProcessIdentity(); state.started_at = new Date().toISOString(); apiWrite(statePath, state);
  const persistResults = (rows, terminal = false) => {
    const cases = plan.scenarios.map(s => {
      const row = rows.find(r => r.scenario_id === s.scenario_id) ?? { case_id: `api:${s.scenario_id}`, source_case_id: s.case_id, scenario_id: s.scenario_id, title: s.title ?? s.case_id, expected: s.expected, status: 'blocked', reason: 'not_executed', assertions: [], requests: [], layer: 'api', attempt: 1 };
      return { ...row, actual: row.reason ?? row.status, actual_result: row.reason ?? row.status, error_message: row.reason ?? '', failure_category: row.status === 'failed' ? 'assertion_mismatch' : row.status === 'passed' ? null : 'execution_incomplete', evidence_paths: (row.requests ?? []).map(id => `execution/api/evidence/${id}.json`), ...(row.status === 'unknown' ? { status: 'blocked', result_unknown: true } : {}) };
    });
    const summary = Object.fromEntries(['passed', 'failed', 'blocked', 'skipped'].map(key => [key, cases.filter(c => c.status === key).length])); summary.total = cases.length;
    const partial = !terminal || cases.some(c => c.status === 'blocked' || c.result_unknown);
    const result = { version: 1, ...identity, layer: 'api', status: partial ? 'partial' : 'completed', started_at: state.started_at, finished_at: terminal ? new Date().toISOString() : null, snapshot_at: new Date().toISOString(), design_sha256: state.source_sha256, cases, summary, unknown_resources:plan.scenarios.filter(s=>cases.some(c=>c.scenario_id===s.scenario_id && c.result_unknown)).flatMap(s=>s.resources ?? []), statistics: { business_cases: new Set(cases.map(c => c.source_case_id)).size, scenarios: cases.length, requests: Object.keys(receipts).length, assertions: cases.reduce((n, c) => n + (c.assertions?.length ?? 0), 0), unknown_requests: Object.values(receipts).filter(r => ['unknown', 'started'].includes(r.status)).length }, evidence: Object.values(receipts).map(r => ({ path: `execution/api/evidence/${r.request_id}.json`, sha256: apiHash(Buffer.from(JSON.stringify(publicReceipt(r), null, 2))) })) };
    apiWrite(resolve(state.run_dir, 'execution/api/test_results.json'), result);
    apiWrite(resolve(state.run_dir, 'execution/api/task.json'), { ...identity, outcome: partial ? 'partial' : 'completed', summary: `接口执行：${summary.passed}通过，${summary.failed}失败，${summary.blocked}未完成。`, questions: [], limitations: partial ? ['保留未执行或结果未知；未重放请求。'] : [], source_paths: state.source_paths ?? [state.source_path], evidence_paths: result.evidence.map(e => e.path) });
    apiWrite(resolve(state.run_dir, 'execution/api/data-ledger.json'), { ...identity, items: Object.values(receipts).filter(r => (!['GET', 'HEAD', 'OPTIONS'].includes(r.method)||r.side_effect)).map(r => ({ request_id: r.request_id, status: r.status === 'unknown' || r.status === 'started' ? 'create_uncertain' : 'write_observed', cleanup: r.cleanup_of ? (r.status==='passed'?'cleanup_response_observed':'cleanup_unconfirmed') : 'not_automatically_attempted',created_by:r.cleanup_of??null })) });
  };
  const publicReceipt = r => ({ ...r, extracted: undefined });
  let lastRows = [], authQueue=Promise.resolve(); const credentialRefs={};
  try {
    persistResults([]);
    const rows = await executeApiPlan(plan, {
      prior: receipts, cancelled,
      resolveSecret: ref => protectedInputs().get(state.owner, ref), saveSecret: value => protectedInputs().put(state.owner, value),
      waitForAuth:(key,stopped)=>{
        const pending=authQueue.then(async()=>{if(credentialRefs[key])return credentialRefs[key];
        const actionId=randomUUID(),card=resolve(state.run_dir,'execution/api/human-action.json');
        state.status='waiting_human';state.action_id=actionId;state.credential_key=key;apiWrite(statePath,state);
        apiWrite(card,{...identity,action_id:actionId,child_session:state.child_session,parent_session:state.owner,worker_pid:state.pid,process_identity:state.process_identity,kind:'access',channel:'api',status:'waiting_human',waiting_at:new Date().toISOString(),question:'请提供当前接口认证凭据；原任务等待中，已执行请求不会重发。'});
        while(!stopped()) {
          const reply=resolve(privateDir,`resume-${actionId}.json`);
          if(existsSync(reply)) {
            const ref=apiRead(reply).credentials?.[key];
            if(ref) {protectedInputs().get(state.owner,ref);state.status='running';delete state.action_id;delete state.credential_key;apiWrite(statePath,state);apiWrite(card,{...apiRead(card),status:'resumed'});credentialRefs[key]=ref;return ref;}
          }
          await new Promise(r=>setTimeout(r,200));
        }
        apiWrite(card,{...apiRead(card),status:'cancelled_or_expired'});throw new Error('authentication_wait_ended');
        });authQueue=pending.catch(()=>{});return pending;
      },
      saveReceipt: async r => { receipts[r.request_id] = { ...r, ...identity }; state.receipts = receipts; apiWrite(statePath, state); apiWrite(resolve(state.run_dir, `execution/api/evidence/${r.request_id}.json`), publicReceipt(receipts[r.request_id])); },
      saveProgress: entries => { lastRows = entries.map(([scenario_id, result]) => { const s = plan.scenarios.find(s => s.scenario_id === scenario_id); return { case_id: `api:${scenario_id}`, scenario_id, source_case_id: s.case_id, title: s.title ?? s.case_id, expected: s.expected, layer: 'api', attempt: 1, ...result }; }); persistResults(lastRows); },
      onResources: async (keys, stopped) => {
        const paths = [...new Set(keys)].sort().flatMap(resourcePaths);
        while (!stopped()) {
          const acquired = [];
          try { for (const path of paths) { writeFileSync(path, JSON.stringify(identity), { flag: 'wx' }); acquired.push(path); } acquired.forEach(p => held.add(p)); return true; }
          catch { acquired.forEach(p => unlinkSync(p)); await new Promise(r => setTimeout(r, 100)); }
        }
        return false;
      },
      releaseResources: async (keys, unknown) => {
        for (const path of keys.flatMap(resourcePaths)) { if (held.has(path)) { held.delete(path); if (!unknown) unlinkSync(path); } }
      }
    });
    state.status = cancelled() ? 'cancelled' : 'completed'; persistResults(rows, true);
  } catch { state.status = 'failed'; persistResults(lastRows, true); }
  state.finished_at = new Date().toISOString(); apiWrite(statePath, state);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runApiWorker(resolve(process.argv[2]));
