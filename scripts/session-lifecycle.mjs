// Host request-lifecycle vocabulary, shared by every gate that asks whether a session
// ended. The events themselves are host event_msg rows; payload.type identifies them.
// Callers keep their own acceptance policy: a recovery gate may accept any terminal
// status, a completion gate only 'completed', a cancellation probe only the cancelled
// family. One vocabulary, many policies — never one policy silently reused everywhere.
export const REQUEST_LIFECYCLE = ['request_begin', 'request_end'];
export const CANCELLED_STATUSES = ['cancelled', 'interrupted'];

export function lastRequestLifecycle(rows) {
  return rows.filter(row => REQUEST_LIFECYCLE.includes(row.payload?.type)).at(-1) ?? null;
}

// null means the session is still active (last event is request_begin) or its
// termination is unknown (no lifecycle event at all). Both are "not ended".
export function requestEndStatus(rows) {
  const last = lastRequestLifecycle(rows);
  return last?.payload?.type === 'request_end' ? last.payload.status : null;
}

export function assertRequestEnded(rows, accepted, message) {
  const status = requestEndStatus(rows);
  if (status === null || !accepted.includes(status)) throw new Error(message);
  return status;
}