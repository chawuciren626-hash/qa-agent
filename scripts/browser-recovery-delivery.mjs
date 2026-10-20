import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readRunFile } from './design-quality.mjs';
import { writeJson } from './orchestration-state.mjs';
import { recoverBrowserResults } from './browser-result-recovery.mjs';
import { browserLifecycle, browserCoverage } from './browser-lifecycle.mjs';
import { ownerHasExited } from './process-identity.mjs';

const read = (dir,path) => JSON.parse(readRunFile(dir,path).data);

export function publishRecoveredBrowserResults(dir, commandId) {
  if(!/^[a-f0-9-]{36}$/.test(commandId ?? '')) throw new Error('Recovery requires controlled command identity');
  if(realpathSync(resolve(dir,'execution'))!==resolve(dir,'execution')) throw new Error('Redirected execution directory');
  const state=read(dir,'execution/browser-state.json'),manifest=read(dir,'manifest.json');
  const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage==='execution').at(-1);
  if(state.run_id!==manifest.run_id || state.dispatch_id!==dispatch?.dispatch_id) throw new Error('Recovery belongs to another execution dispatch');
  if(existsSync(resolve(dir,'execution/browser-private.json'))) {
    const connection=read(dir,'execution/browser-private.json');
    if(!ownerHasExited(connection.pid,connection.process_identity)) return {status:'recovery_not_ready',operation_started:false,next_action:'health_then_inspect_or_finish_existing_browser_no_product_retry'};
  } else if(!['expired','closed'].includes(state.status)) {
    return {status:'recovery_not_ready',operation_started:false,next_action:'worker_termination_not_established_preserve_evidence'};
  }
  const results=recoverBrowserResults(dir);
  // Keep older deliveries byte-equivalent; optional diagnostics are not migrations.
  if(existsSync(resolve(dir,'execution/test_results.json')) && !Object.hasOwn(read(dir,'execution/test_results.json'),'browser_performance_summary')) delete results.browser_performance_summary;
  // Never replace a live finish or silently rewrite changed recovery inputs.
  if(existsSync(resolve(dir,'execution/test_results.json')) && !isDeepStrictEqual(read(dir,'execution/test_results.json'),results)) throw new Error('Existing results differ; preserve original delivery');
  if(existsSync(resolve(dir,'execution/exploration.json')) && read(dir,'execution/exploration.json').mode!=='recovered_browser') throw new Error('Existing live exploration must be preserved');
  const source=readRunFile(dir,state.source_path);
  if(source.sha256!==state.source_sha256) throw new Error('Original browser input changed');
  const coverage=browserLifecycle(manifest)?browserCoverage(dir,manifest,results):null;
  const paths=['execution/test_results.json','execution/browser-recovery.json'];
  writeJson(resolve(dir,paths[0]),results,{mode:0o600});
  writeJson(resolve(dir,paths[1]),results.recovery,{mode:0o600});
  if(coverage) {writeJson(resolve(dir,'execution/browser-coverage.json'),coverage);paths.push('execution/browser-coverage.json');}
  const observation={version:1,run_id:state.run_id,invocation_id:state.invocation_id,dispatch_id:state.dispatch_id,
    mode:'recovered_browser',result_origin:'recovered',status:'partial',partial:true,
    finished_at:null,browser_closed:'unknown',command_id:commandId,
    source_path:state.source_path,source_sha256:state.source_sha256,
    limitations:['Execution ended without a verified normal finish. Recovered assertions are partial; uncertain operations and untested scope remain unresolved. No product operations or cleanup were replayed.'],
    unknown_operations:results.unknown_operations,recovery_problems:results.recovery.problems,
    evidence:paths.map(path=>{const file=readRunFile(dir,path);return {path,sha256:file.sha256};})};
  writeJson(resolve(dir,'execution/exploration.json'),observation,{mode:0o600});
  return {status:'recovered_partial',partial:true,result_origin:'recovered',summary:results.summary,
    unknown_operations:results.unknown_operations.length,recovery_problems:results.recovery.problems.length,
    artifacts:['execution/exploration.json',...paths],exploration_sha256:readRunFile(dir,'execution/exploration.json').sha256,
    next_action:'handoff_partial_execution_then_requested_defects_and_report_no_product_retry'};
}

export function verifyRecoveredBrowserResults(dir, results) {
  const recomputed=recoverBrowserResults(dir);
  if(!Object.hasOwn(results,'browser_performance_summary')) delete recomputed.browser_performance_summary;
  if(!isDeepStrictEqual(results,recomputed)) throw new Error('Recovered results differ from source receipts');
  return results;
}
