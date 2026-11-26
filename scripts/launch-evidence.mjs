import { toolOutcome } from './trace-outcome.mjs';

/**
 * Whether a `run_subagent` call never reached a child at all. The execution channel can
 * answer 500 before any session exists (seen on a live controller: three retries, the last
 * one refused as "this dispatch already has a child call" although no child was ever
 * registered), and a dispatch that never started must stay retryable. Only positive evidence
 * counts - the tool's own failure envelope, exactly one output, `fatal` status, and no child
 * registered before the next dispatch attempt - so a spawn that half-succeeded still blocks.
 *
 * Lives here rather than in delegation-guard because both the pre-launch guard and the
 * post-launch binding checks need it, and stage-evidence must not import the guard that
 * imports it. A call that never started is not a second binding: counting it made every
 * downstream action (handoff / resolve_child / preview_revision) refuse a dispatch whose
 * only real child had returned normally.
 */
export function launchNeverStarted(rows, index) {
  const call = rows[index].payload;
  const outputs = rows.slice(index + 1).filter(r => r.payload?.type === 'tool_call_output' && r.payload.tool_call_id === call.tool_call_id);
  if (outputs.length !== 1) return false;
  const output = outputs[0];
  if (toolOutcome(output.payload) !== 'fatal') return false;
  if (!/^\[run_subagent error:/.test(String(output.payload.output ?? '').trim())) return false;
  const after = rows.slice(rows.indexOf(output) + 1);
  const next = after.findIndex(r => r.payload?.type === 'tool_call' && r.payload.name === 'run_subagent');
  const segment = next < 0 ? after : after.slice(0, next);
  return !segment.some(r => r.payload?.type === 'subagent' || (r.payload?.type === 'session_meta' && (r.origin?.length ?? 0) > 0));
}
