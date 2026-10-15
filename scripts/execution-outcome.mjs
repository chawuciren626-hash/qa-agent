import { dataPath } from './directory-context.mjs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLatestExecution, verifyAttempt } from './execution-attempts.mjs';

export function sealedExecutionOutcome(root, runId) {
  const { state, results } = loadLatestExecution(root, runId);
  if (state?.version !== 2 || state.run_id !== runId || !['completed', 'failed', 'blocked'].includes(state.status)) throw new Error('A sealed terminal execution outcome is required');
  const attempt = verifyAttempt(root, runId, state.invocation_id);
  if (state.processes_stopped !== true || attempt.processes_stopped !== true || existsSync(dataPath(root, 'output/runs', runId, 'execution/execution.lock.json'))) throw new Error('Execution process cleanup is not confirmed');
  if (results.run_id !== runId || results.invocation_id !== state.invocation_id) throw new Error('Execution outcome identity mismatch');
  return { state, results, attempt };
}

// Only the named runner's own sealed invocation may convert a domain failure to a handled command.
export function handledExecutionCommand(root, runId, commandId, processResult) {
  if (!processResult.termination_confirmed || processResult.termination || processResult.error) return null;
  try {
    const { state, results, attempt } = sealedExecutionOutcome(root, runId);
    if (attempt.command_id !== commandId || state.command_id !== commandId || !commandId) return null;
    const expectedCode = state.status === 'completed' ? 0 : state.status === 'failed' ? 1 : 2;
    if (processResult.code !== expectedCode) return null;
    return {
      run_id: runId, invocation_id: state.invocation_id,
      status: state.status, attempt_status: attempt.status,
      disposition: state.status === 'blocked' ? 'report_only' : 'analyze_results',
      summary: results.summary, reason: state.block_reason || null,
      completion_artifacts: [state.status === 'blocked' ? 'execution/execution-blocked.json' : 'execution/test_results.json'],
      retry_authorized: false, product_verdict: 'not_determined'
    };
  } catch { return null; }
}
