const text = value => typeof value === 'string' && value.trim().length > 0;
const requireValue = (condition, message) => { if (!condition) throw new Error(`Requirement provenance: ${message}`); };
const normative = new Set(['user_requirement', 'user_confirmation', 'specification']);
const fields = (value, allowed, label) => requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), `${label}: unknown fields; all analysis content must be structured`);

// capture must enforce run-local paths and include every read in the caller's receipt.
export function inspectRequirementLedger(runId, capture) {
  const ledger = JSON.parse(capture('analysis/requirement-ledger.json').toString('utf8'));
  fields(ledger, ['version', 'run_id', 'sources', 'rules'], 'ledger');
  requireValue(ledger.version === 1 && ledger.run_id === runId, 'version or run_id mismatch');
  requireValue(Array.isArray(ledger.sources) && ledger.sources.length > 0, 'sources required');
  requireValue(Array.isArray(ledger.rules) && ledger.rules.length > 0, 'rules required');
  const sources = new Map();
  for (const source of ledger.sources) {
    fields(source, ['id', 'kind', 'path', 'origin', 'locator'], 'source');
    requireValue(source && text(source.id) && !sources.has(source.id), 'unique source IDs required');
    requireValue(['user_requirement', 'user_confirmation', 'specification', 'implementation', 'observation', 'historical'].includes(source.kind), 'invalid source kind');
    requireValue(text(source.path) && text(source.origin) && text(source.locator), 'source path, original origin and locator required');
    requireValue(source.path.startsWith('inputs/') && !source.path.includes('\\') && !source.path.split('/').some(part => ['', '.', '..'].includes(part)), 'source snapshots must be in inputs/, not generated analysis');
    sources.set(source.id, { ...source, content: capture(source.path).toString('utf8') });
  }
  const rules = new Map();
  for (const rule of ledger.rules) {
    fields(rule, ['id', 'statement', 'kind', 'scope', 'status', 'citations', 'reason', 'module', 'category'], 'rule');
    for (const key of ['reason', 'module']) if (rule[key] !== undefined) requireValue(text(rule[key]), `${rule.id}: ${key} must be nonempty text`);
    if (rule.category !== undefined) requireValue(['functional', 'constraint', 'context', 'environment', 'risk', 'clarification'].includes(rule.category), `${rule.id}: invalid category`);
    requireValue(rule && text(rule.id) && !rules.has(rule.id) && text(rule.statement), 'unique rule IDs and statements required');
    requireValue(['requirement', 'observation', 'assumption'].includes(rule.kind), `${rule.id}: invalid kind`);
    requireValue(['in_scope', 'out_of_scope'].includes(rule.scope), `${rule.id}: explicit scope required`);
    requireValue(['confirmed', 'pending', 'conflicted', 'rejected', 'observed'].includes(rule.status), `${rule.id}: invalid status`);
    requireValue(Array.isArray(rule.citations) && rule.citations.length > 0, `${rule.id}: citations required`);
    const cited = rule.citations.map(citation => {
      fields(citation, ['source_id', 'quote'], 'citation');
      const source = sources.get(citation?.source_id);
      requireValue(source && text(citation.quote) && source.content.includes(citation.quote), `${rule.id}: source snapshot changed or quote missing`);
      return source;
    });
    if (rule.kind === 'observation') requireValue(rule.status === 'observed', `${rule.id}: implementation observations cannot be confirmed rules`);
    else requireValue(rule.status !== 'observed', `${rule.id}: observed is reserved for observations`);
    if (rule.kind === 'requirement') requireValue(cited.some(source => normative.has(source.kind)), `${rule.id}: requirement needs a normative source, not implementation or history`);
    if (rule.kind === 'assumption' && rule.status === 'confirmed') requireValue(cited.some(source => source.kind === 'user_confirmation'), `${rule.id}: assumption requires explicit user confirmation source`);
    if (rule.status !== 'confirmed' || rule.scope === 'out_of_scope') requireValue(text(rule.reason), `${rule.id}: reason required for nonconfirmed or excluded rules`);
    rules.set(rule.id, { ...rule, source_paths: cited.map(source => source.path), confirmation_paths: cited.filter(source => source.kind === 'user_confirmation').map(source => source.path) });
  }
  requireValue([...rules.values()].some(rule => rule.kind === 'requirement' && rule.scope === 'in_scope'), 'at least one in-scope requirement required');
  return { ledger, rules };
}

export function referencedRule(rules, id, execution = false) {
  const rule = rules.get(id);
  requireValue(rule, `unknown rule_id ${id}`);
  requireValue(rule.kind !== 'observation' && rule.scope === 'in_scope' && rule.status !== 'rejected', `${id}: observation, rejected or out-of-scope rule cannot define expected behavior`);
  if (execution) requireValue(rule.status === 'confirmed', `${id}: unconfirmed rule cannot enter execution`);
  return rule;
}
