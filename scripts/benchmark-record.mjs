// This gate validates recorded evidence, not the quality of a model's answer.
export function checkBenchmarkRecord(record) {
  const errors = [];
  const fail = message => errors.push(message);
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  const runtimeKeys = ['agent_id', 'version', 'provider', 'model_id', 'thinking_level', 'state_sha256'];
  if (!record || typeof record !== 'object') return { passed: false, errors: ['record must be an object'] };
  if (!hash(record.revision_sha256)) fail('revision_sha256 required');
  const runtime = record.runtime ?? {};
  for (const key of runtimeKeys) {
    if (key === 'version') {
      if (!Number.isInteger(runtime[key]) || runtime[key] < 1) fail('positive integer version required');
    } else if (key === 'state_sha256' ? !hash(runtime[key]) : !nonempty(runtime[key])) {
      fail(`runtime.${key} required`);
    }
  }
  const expected = record.expected_cases;
  if (!Array.isArray(expected) || !expected.length || expected.some(id => !nonempty(id)) || new Set(expected).size !== expected.length) {
    fail('expected_cases must be a nonempty unique ID array');
  }
  const cases = record.cases;
  if (!Array.isArray(cases) || !cases.length) return { passed: false, errors: [...errors, 'cases required'] };
  const ids = new Set();
  const sessions = new Set();
  let sum = 0;
  for (const item of cases) {
    if (!item || typeof item !== 'object') { fail('case must be an object'); continue; }
    const id = item.case_id;
    if (!nonempty(id) || ids.has(id)) fail('missing or duplicate case_id');
    ids.add(id);
    if (item.status !== 'scored') fail(`${id}: invalid or failed execution cannot be a score`);
    if (item.run !== 1) fail(`${id}: exactly one run required`);
    if (!nonempty(item.session_id) || sessions.has(item.session_id)) fail(`${id}: unique session_id required`);
    sessions.add(item.session_id);
    if (item.revision_sha256 !== record.revision_sha256) fail(`${id}: revision changed`);
    for (const key of runtimeKeys) {
      if (item.runtime?.[key] !== runtime[key]) fail(`${id}: runtime.${key} changed`);
    }
    if (!item.review || item.review.status !== 'approved' || !nonempty(item.review.reviewer) || !nonempty(item.review.evidence_ref)) {
      fail(`${id}: independent semantic review required`);
    }
    if (!Array.isArray(item.items) || !item.items.length) { fail(`${id}: scoring items required`); continue; }
    const itemIds = new Set();
    let maximum = 0;
    let awarded = 0;
    for (const dimension of item.items) {
      if (!dimension || typeof dimension !== 'object') { fail(`${id}: malformed scoring item`); continue; }
      if (!nonempty(dimension.id) || itemIds.has(dimension.id)) fail(`${id}: duplicate or missing scoring item ID`);
      itemIds.add(dimension.id);
      if (!Number.isFinite(dimension.max_score) || dimension.max_score <= 0) fail(`${id}: invalid maximum`);
      if (!Number.isFinite(dimension.score) || dimension.score < 0 || dimension.score > dimension.max_score) fail(`${id}: invalid item score`);
      if (!nonempty(dimension.evidence_ref)) fail(`${id}: scoring evidence required`);
      maximum += dimension.max_score;
      awarded += dimension.score;
    }
    if (Math.abs(maximum - 100) > 1e-8 || !Number.isFinite(maximum)) fail(`${id}: maximum must total 100`);
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 100 || Math.abs(item.score - awarded) > 1e-8) fail(`${id}: score does not equal item sum`);
    sum += item.score;
  }
  if (Array.isArray(expected) && (cases.length !== expected.length || expected.some(id => !ids.has(id)))) fail('case matrix incomplete or unexpected cases');
  const calculated = Math.round(sum / cases.length * 100) / 100;
  if (!Number.isFinite(record.score) || !Number.isFinite(calculated) || Math.abs(record.score - calculated) > 1e-8) fail('average does not match case scores');
  return { passed: errors.length === 0, calculated_score: Number.isFinite(calculated) ? calculated : null, errors };
}
