// A hook denial is recorded twice: the harness writes an `approval_decision` row
// (decision: 'deny') and a human-readable reason. The two copies answer different
// questions, so they are not interchangeable:
//
//   denialRecorded     — "was this call refused?" Either signal is enough. These
//                        callers must not miss a refusal: missing one makes a denied
//                        call look like a real invocation, or blocks a legitimate
//                        retry as a duplicate dispatch.
//   denialCorroborated — "is this the hook's own refusal?" Both signals must agree.
//                        These callers use the refusal as proof that nothing ran, so
//                        an output written without a recorded decision cannot qualify.
//
// Both take the canonical prefix from here, so a reworded reason breaks in one place
// instead of silently reclassifying every denial as an executed command.
export const STAGE_BOUNDARY_DENIAL = 'Tool call denied by the qa-stage-boundary hook';
export const DELEGATION_DENIAL = 'Tool call denied by the qa-delegation-guard hook';

export function isHookDenial(output, prefix) {
  return String(output ?? '').startsWith(prefix);
}

const decisionsFor = (rows, toolCallId) =>
  rows.filter(row => row?.payload?.type === 'approval_decision' && row.payload.tool_call_id === toolCallId);

const outputFor = (rows, toolCallId) =>
  rows.find(row => row?.payload?.type === 'tool_call_output' && row.payload.tool_call_id === toolCallId);

export function denialRecorded(rows, toolCallId, prefix) {
  if (!toolCallId) return false;
  const decisions = decisionsFor(rows, toolCallId);
  if (decisions.length) return decisions.some(row => row.payload.decision === 'deny');
  return isHookDenial(outputFor(rows, toolCallId)?.payload?.output, prefix);
}

export function denialCorroborated(rows, toolCallId, prefix) {
  if (!toolCallId) return false;
  const decisions = decisionsFor(rows, toolCallId);
  return decisions.length === 1 && decisions[0].payload.decision === 'deny' &&
    isHookDenial(outputFor(rows, toolCallId)?.payload?.output, prefix);
}

// Both guards can refuse a call, and every consumer below asks the same question of
// whichever one refused: `was it refused, and did nothing run?` Enumerating one prefix at a
// call site made a qa-delegation-guard refusal look like an executed command that returned
// unreadable output - a controller session with one such row could never close a handoff.
export const HOOK_DENIALS = [STAGE_BOUNDARY_DENIAL, DELEGATION_DENIAL];

export function isAnyHookDenial(output) {
  return HOOK_DENIALS.some(prefix => isHookDenial(output, prefix));
}

export function anyDenialRecorded(rows, toolCallId) {
  return HOOK_DENIALS.some(prefix => denialRecorded(rows, toolCallId, prefix));
}

export function anyDenialCorroborated(rows, toolCallId) {
  return HOOK_DENIALS.some(prefix => denialCorroborated(rows, toolCallId, prefix));
}
