// One lazily-built index per parsed trace array. Per-call predicates (outputs for a
// tool_call_id, denial decisions, duplicate-call counts) used to rescan the whole
// trace each time, making a long child session O(n²) per handoff. The index assumes
// the rows array is not mutated after the first indexed call; re-parse instead.
const cache = new WeakMap();

export function traceIndex(rows) {
  let index = cache.get(rows);
  if (index) return index;
  const calls = new Map(), outputs = new Map(), decisions = new Map();
  for (const [position, row] of rows.entries()) {
    const type = row?.payload?.type;
    const id = row?.payload?.tool_call_id;
    if (!id) continue;
    const map = type === 'tool_call' ? calls : type === 'tool_call_output' ? outputs : type === 'approval_decision' ? decisions : null;
    if (!map) continue;
    const list = map.get(id);
    if (list) list.push({ row, position });
    else map.set(id, [{ row, position }]);
  }
  index = { calls, outputs, decisions };
  cache.set(rows, index);
  return index;
}

export function outputsAfter(rows, position, toolCallId) {
  return (traceIndex(rows).outputs.get(toolCallId) ?? []).filter(entry => entry.position > position);
}