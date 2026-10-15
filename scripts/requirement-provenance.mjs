const text = value => typeof value === 'string' && value.trim().length > 0;
const requireValue = (condition, message) => { if (!condition) throw new Error(`Requirement provenance: ${message}`); };
const normative = new Set(['user_requirement', 'user_confirmation', 'specification']);
export const sourceKinds = ['user_requirement', 'user_confirmation', 'specification', 'implementation', 'observation', 'historical'];
export const ruleCategories = ['functional', 'constraint', 'context', 'environment', 'risk', 'clarification'];
const fields = (value, allowed, label) => {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected an object; allowed fields: ${allowed.join(', ')}`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  requireValue(!unknown.length, `${label}: unknown fields: ${unknown.join(', ')}; allowed fields: ${allowed.join(', ')}. Preserve substantive content in structured rules; do not silently drop it.`);
};

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
    requireValue(sourceKinds.includes(source.kind), `${source.id}: invalid source kind ${JSON.stringify(source.kind)}; allowed: ${sourceKinds.join(', ')}. API/OpenAPI requirement documents use specification, not api_document/openapi_spec.`);
    requireValue(text(source.path) && text(source.origin) && text(source.locator), 'source path, original origin and locator required');
    requireValue(source.path.startsWith('inputs/') && !source.path.includes('\\') && !source.path.split('/').some(part => ['', '.', '..'].includes(part)), 'source snapshots must be in inputs/, not generated analysis');
    sources.set(source.id, { ...source, content: capture(source.path).toString('utf8') });
  }
  const rules = new Map();
  for (const rule of ledger.rules) {
    fields(rule, ['id', 'statement', 'kind', 'scope', 'status', 'citations', 'reason', 'module', 'category'], 'rule');
    for (const key of ['reason', 'module']) if (rule[key] !== undefined) requireValue(text(rule[key]), `${rule.id}: ${key} must be nonempty text`);
    if (rule.category !== undefined) requireValue(ruleCategories.includes(rule.category), `${rule.id}: invalid category; allowed: ${ruleCategories.join(', ')}`);
    requireValue(rule && text(rule.id) && !rules.has(rule.id) && text(rule.statement), 'unique rule IDs and statements required');
    requireValue(['requirement', 'observation', 'assumption'].includes(rule.kind), `${rule.id}: invalid kind`);
    requireValue(['in_scope', 'out_of_scope'].includes(rule.scope), `${rule.id}: explicit scope required`);
    requireValue(['confirmed', 'pending', 'conflicted', 'rejected', 'observed'].includes(rule.status), `${rule.id}: invalid status`);
    requireValue(Array.isArray(rule.citations) && rule.citations.length > 0, `${rule.id}: citations required`);
    const cited = rule.citations.map((citation, index) => {
      fields(citation, ['source_id', 'quote'], 'citation');
      const source = sources.get(citation?.source_id);
      requireValue(source, `${rule.id}: citation[${index}]: unknown source_id; use an ID declared in sources`);
      requireValue(text(citation.quote) && source.content.includes(citation.quote), `${rule.id}: citation[${index}] in ${source.path}: source snapshot changed or quote missing; read_source and copy a continuous exact quote including original line endings. Put paraphrases in statement/reason. Do not change the source to fit the quote.`);
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
  requireValue(!['context', 'environment'].includes(rule.category), `${id}: context/environment is supporting information, not an expected behavior; testable acceptance constraints must be classified explicitly in analysis`);
  if (execution) requireValue(rule.status === 'confirmed', `${id}: unconfirmed rule cannot enter execution`);
  return rule;
}

export function testPointCoverage(rule) {
  if (rule.scope !== 'in_scope' || rule.status === 'rejected' || rule.kind === 'observation') return 'excluded';
  if (['context', 'environment'].includes(rule.category)) return 'supporting';
  if (rule.kind === 'requirement' || (rule.kind === 'assumption' && rule.status === 'confirmed')) return 'required';
  return 'optional';
}

// Diagnose the entire draft without Markdown or writes; strict publication still uses inspectRequirementLedger.
export function diagnoseRequirementLedger(runId, capture) {
  const errors=[];
  const add=message=>{if(!errors.includes(message)) errors.push(message);};
  const cached=new Map();
  const read=path=>{if(!cached.has(path)) cached.set(path,capture(path));return cached.get(path);};
  let ledger;
  try { ledger=JSON.parse(read('analysis/requirement-ledger.json').toString('utf8')); }
  catch(error) { return {status:'needs_correction',errors:[error.message],rule_count:0}; }
  try { inspectRequirementLedger(runId,read); } catch(error) {add(error.message);}
  const sources=new Map();
  for(const source of Array.isArray(ledger?.sources)?ledger.sources:[]) {
    if(!source || !text(source.path) || !source.path.startsWith('inputs/') || source.path.includes('\\') || source.path.split('/').some(p=>['','.','..'].includes(p))) continue;
    try { sources.set(source.id,read(source.path).toString('utf8')); } catch(error) {add(`${source.id}: ${error.message}`);}
  }
  const ids=new Set();
  for(const rule of Array.isArray(ledger?.rules)?ledger.rules:[]) {
    if(ids.has(rule?.id)) add(`${rule?.id}: duplicate rule ID`);
    ids.add(rule?.id);
    try {
      inspectRequirementLedger(runId,path=>path==='analysis/requirement-ledger.json'?Buffer.from(JSON.stringify({...ledger,rules:[rule]})):read(path));
    } catch(error) {
      if(!error.message.endsWith('at least one in-scope requirement required')) add(error.message);
    }
    if(!rule) continue;
    if((rule.status!=='confirmed' || rule.scope==='out_of_scope') && !text(rule.reason)) add(`${rule.id}: reason required for nonconfirmed or excluded rules`);
    for(const [index,citation] of (Array.isArray(rule.citations)?rule.citations:[]).entries()) {
      const source=sources.get(citation?.source_id);
      if(source===undefined) add(`${rule.id}: citation[${index}]: source unavailable`);
      else if(!text(citation?.quote) || !source.includes(citation.quote)) add(`${rule.id}: citation[${index}]: quote is not a continuous exact source substring; retrieve original lines with read_source, preserving CRLF/LF and punctuation`);
    }
  }
  return {status:errors.length?'needs_correction':'passed',errors,rule_count:Array.isArray(ledger?.rules)?ledger.rules.length:0,source_count:sources.size,markdown_required:false,approval_granted:false,scope:'Draft structure and exact citations only; no semantic approval or generation'};
}
