// AMSP 0.2.17 writes tool_call_output.status; earlier traces used stop_reason.
// Read both versions without rewriting any historical trace. Conflicting fields fail closed.
export function toolOutcome(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  if (payload.status !== undefined && payload.stop_reason !== undefined && payload.status !== payload.stop_reason) return undefined;
  const value=payload.status ?? payload.stop_reason;
  return ['completed','aborted','fatal','retryable'].includes(value) ? value : undefined;
}
