// One vocabulary for "which run_subagent call attempted this dispatch". The binding
// count (matchingDispatchCalls), the handle lookup (recordedChildHandle), the returned
// child resolution (findParentDispatch) and the pre-launch duplicate guard all ask the
// same identity question; only their acceptance policies differ, and those stay at the
// call sites. Identity here is agent + run token + dispatch token in the prompt — the
// full policy text is an additional anchor each caller applies when it needs one.
import { launchNeverStarted } from './launch-evidence.mjs';
import { isDenialOutput } from './hook-denial.mjs';
import { toolWasNotExecuted } from './child-command-policy.mjs';

export function parseCallArgs(row) {
  try { return typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments; }
  catch { return null; }
}

export function promptTokens(prompt) {
  return String(prompt ?? '').split(/[^A-Za-z0-9-]+/);
}

export function callTargetsDispatch(args, { runId, agent, dispatchId }) {
  if (!args || args.agent_id !== agent || typeof args.prompt !== 'string') return false;
  const tokens = promptTokens(args.prompt);
  return tokens.includes(runId) && (!dispatchId || tokens.includes(dispatchId));
}

// Positive proof that a call never ran: the host's native malformed-argument refusal,
// a channel 500 before any child existed, or any host denial output (user, policy or
// hook). A call that DID run is never excluded by this — a failed launch envelope with
// a registered child, or a plain failure receipt, still counts as an attempt.
export function neverAttempted(rows, index) {
  if (toolWasNotExecuted(rows, index)) return true;
  if (launchNeverStarted(rows, index)) return true;
  const id = rows[index].payload?.tool_call_id;
  return Boolean(id) && rows.some(row => row.payload?.type === 'tool_call_output' && row.payload.tool_call_id === id && isDenialOutput(row.payload.output));
}

// The debugging black hole this family used to have: a call bound by tokens but whose
// prompt lacks the registered policy text passed the binding count and then failed the
// returned-child resolution with a generic "no matching response". Name that case.
export function dispatchPolicyMismatch(attempt, dispatch) {
  if (!attempt || !dispatch.child_command_policy) return false;
  const args = parseCallArgs(attempt);
  return Boolean(args) && typeof args.prompt === 'string' && !args.prompt.includes(dispatch.child_command_policy);
}