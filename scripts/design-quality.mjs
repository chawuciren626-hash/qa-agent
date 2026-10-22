import { resourcePath } from './directory-context.mjs';
import { dataPath, assertRunContext } from './directory-context.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createExecutionCases, extractCases } from './execution-plan.mjs';
import { inspectRequirementLedger, referencedRule } from './requirement-provenance.mjs';
import { CommandUsageError } from './command-contracts.mjs';

export function assertConfirmedExecutionCases(rows) {
  const unresolved=rows.filter(row=>(row.design_contract?.basis??[]).some(r=>r.status!=='confirmed') || (row.design_contract?.assumptions??[]).some(r=>r.status!=='confirmed'));
  if(unresolved.length) throw new CommandUsageError(`Execution design needs correction before any product operation: ${unresolved.map(r=>r.case_id??r.id).join(', ')}. Unconfirmed business expectations cannot execute. Keep observable setup in preconditions/steps, not pending business assumptions; correct eligible drafts before dispatch without inventing approval.`);
}

export function assertExecutionDesignReady(dir,stage) {
  if(!existsSync(resolve(dir,'design/test_cases.json'))) return;
  const value=JSON.parse(readRunFile(dir,'design/test_cases.json').data),rows=extractCases(value);
  assertConfirmedExecutionCases(rows.filter(row=>stage==='api_execution'?row.execution_layer==='api'||row.api_scenario:row.execution_layer!=='api'));
}

export function runDirectory(root, runId) {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '')) throw new Error('Invalid run_id');
  const dir=dataPath(root, 'output/runs', runId);
  if(existsSync(resolve(dir,'manifest.json'))) assertRunContext(root,JSON.parse(readFileSync(resolve(dir,'manifest.json'),'utf8')));
  return dir;
}

function within(base, file) {
  const path = relative(base, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function readRunFile(runDir, file) {
  const path = resolve(runDir, file);
  if (!within(runDir, path) || !within(realpathSync(runDir), realpathSync(path))) {
    throw new Error('Artifact must belong to the current run');
  }
  if (!statSync(path).isFile()) throw new Error('Artifact must be a file');
  const data = readFileSync(path);
  if (!data.length) throw new Error('Artifact must not be empty');
  return { path: relative(runDir, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(data).digest('hex'), data };
}

const text = value => typeof value === 'string' && value.trim().length > 0;

export function textLengths(value) {
  return {
    code_points: [...value].length,
    utf16: value.length,
    utf8_bytes: Buffer.byteLength(value, 'utf8'),
    graphemes: [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(value)].length
  };
}

export function inspectCaseData(row) {
  const measurements=Object.entries(row.test_data ?? {}).filter(([,value])=>typeof value==='string')
    .map(([key,value])=>({key,...textLengths(value)}));
  const checks=row.design_contract?.data_checks;
  const preparation = [...(Array.isArray(row.preconditions) ? row.preconditions : []), ...(Array.isArray(row.steps) ? row.steps : [])]
    .filter(value => typeof value === 'string').join('\n');
  const referenced = new Set([...preparation.matchAll(/\btest_data\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]));
  // These are review cues, not a natural-language proof or a new delivery gate.
  const dataUsage = Object.entries(row.test_data ?? {}).map(([key, value]) => ({
    key, explicitly_referenced: referenced.has(key),
    preparation_check: value === '' ? 'Establish an empty value explicitly; do not assume the initial field is empty.'
      : value === null ? 'Distinguish explicit null from an omitted field and an empty string.'
      : 'Establish this input/state in preparation or steps; a data value alone does not apply it.'
  }));
  return {case_id:row.case_id,measurements,errors:[...checkDataReferences(row),...(checks===undefined?[]:checkData(row))],
    data_usage:dataUsage,
    semantic_review:{blocking:false,approval_required:false,
      note:'Agent review only: check preparation/steps against data, including negation and state resets. Explicit references do not prove consistency. Every expected clause needs current requirement support; omit inferred navigation, persistence, status codes or side effects unless specified. Do not ask the user to review technical fields.'}};
}

export function checkDataReferences(row) {
  const keys = new Set();
  for (const step of Array.isArray(row.steps) ? row.steps : []) {
    if (typeof step !== 'string') continue;
    for (const match of step.matchAll(/\btest_data\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(match[1]);
  }
  return [...keys].filter(key => !Object.hasOwn(row.test_data ?? {}, key))
    .map(key => `Step references missing test_data.${key}; correct the reference or supply the actual data, without user approval`);
}

export function checkData(testCase) {
  const errors = [];
  const checks = testCase.design_contract?.data_checks;
  if (!Array.isArray(checks)) return ['data_checks must be an array (empty only when no deterministic checks apply)'];
  const data = testCase.test_data ?? {};
  for (const check of checks) {
    try {
      if (!check || typeof check !== 'object') throw new Error('Invalid data check');
      if (check.kind === 'length') {
        if (!text(check.key) || !Object.hasOwn(data, check.key) || typeof data[check.key] !== 'string') throw new Error('length requires a string test_data key');
        const value = data[check.key];
        const lengths = textLengths(value);
        if (!Object.hasOwn(lengths, check.unit)) throw new Error('Explicit length unit required');
        if (!Number.isSafeInteger(check.expected) || check.expected < 0) throw new Error('Invalid expected length');
        const actual = lengths[check.unit];
        if (actual !== check.expected) throw new Error(`${check.key}: expected length ${check.expected}, actual ${actual} (${check.unit})`);
      } else if (check.kind === 'minor_unit_sum') {
        if (!text(check.currency) || !Array.isArray(check.terms) || !check.terms.length) throw new Error('Currency and sum terms required');
        const integer = key => {
          if (!text(key) || !Object.hasOwn(data, key) || !Number.isSafeInteger(data[key])) throw new Error('Money must use safe integer minor units');
          return BigInt(data[key]);
        };
        const keys = new Set();
        let sum = 0n;
        for (const term of check.terms) {
          if (!term || ![1, -1].includes(term.sign) || keys.has(term.key)) throw new Error('Unique signed sum terms required');
          keys.add(term.key);
          sum += integer(term.key) * BigInt(term.sign);
        }
        if (keys.has(check.total_key)) throw new Error('Total cannot also be a sum term');
        const declared=integer(check.total_key);
        if (sum !== declared) throw new Error(`Money sum does not equal declared total: calculated ${sum}, declared ${declared} (${check.currency} minor units)`);
      } else throw new Error('Unsupported data check');
    } catch (error) { errors.push(error.message); }
  }
  return errors;
}

export function inspectDesign({ root, runId, source, selectedIds, execution = true }) {
  const errors = [];
  const files = new Map();
  let selected = [];
  let provenanceSha256;
  const runDir = runDirectory(root, runId);
  const capture = file => {
    const value = readRunFile(runDir, file);
    files.set(value.path, { path: value.path, sha256: value.sha256 });
    return value;
  };
  try {
    const input = capture(resourcePath(root, source));
    const sourceData = JSON.parse(input.data.toString('utf8'));
    if (!Array.isArray(sourceData) && sourceData.run_id !== undefined && sourceData.run_id !== runId) throw new Error('Source run_id mismatch');
    const cases = extractCases(sourceData);
    const { rules, ledger } = inspectRequirementLedger(runId, file => capture(file).data);
    const { run_id: ledgerRun, ...identity } = ledger;
    provenanceSha256 = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const ids = new Set();
    for (const item of cases) {
      if (!item || !text(item.case_id) || ids.has(item.case_id)) throw new Error('Missing or duplicate case_id');
      ids.add(item.case_id);
    }
    if (selectedIds !== undefined && (!Array.isArray(selectedIds) || !selectedIds.length || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !ids.has(id)))) {
      throw new Error('Selection must contain unique existing case IDs');
    }
    selected = selectedIds === undefined ? cases.filter(c => !execution || c.automation_feasible === true) : cases.filter(c => selectedIds.includes(c.case_id));
    if (!selected.length) throw new Error('No cases to validate');
    for (const item of selected) {
      const fail = message => errors.push(`${item.case_id}: ${message}`);
      if (!text(item.title) || !text(item.expected)) fail('Title and expected result required');
      if (!Array.isArray(item.steps) || !item.steps.length || item.steps.some(step => !text(step))) fail('Concrete steps required');
      if (execution && item.automation_feasible !== true) fail('Selected case is not automation feasible');
      const contract = item.design_contract;
      if (!contract || !Array.isArray(contract.basis) || !contract.basis.length) fail('Nonempty design_contract.basis required');
      for (const basis of contract?.basis ?? []) {
        if (!basis || !text(basis.rule) || !text(basis.source) || !['confirmed', 'pending', 'conflicted'].includes(basis.status)) { fail('Invalid rule basis'); continue; }
        if (execution && basis.status !== 'confirmed') fail('Pending or conflicted rule cannot enter execution');
        try {
          const rule = referencedRule(rules, basis.rule_id, execution);
          if (basis.rule !== rule.statement || basis.status !== rule.status || !rule.source_paths.includes(basis.source)) throw new Error('Basis differs from ledger statement, status or source');
        } catch (error) { fail(error.message); }
        try { capture(basis.source); } catch (error) { fail(`Rule source: ${error.message}`); }
      }
      if (!Array.isArray(contract?.assumptions)) fail('Explicit assumptions array required');
      for (const assumption of contract?.assumptions ?? []) {
        if (!assumption || !text(assumption.statement) || !['pending', 'confirmed', 'rejected'].includes(assumption.status)) { fail('Invalid assumption'); continue; }
        if (execution && assumption.status !== 'confirmed') fail('Unconfirmed assumption cannot enter execution');
        if (assumption.status === 'confirmed') {
          try {
            if (!text(assumption.confirmation_ref)) throw new Error('Confirmation evidence required');
            capture(assumption.confirmation_ref);
            const rule = referencedRule(rules, assumption.rule_id, true);
            if (rule.kind !== 'assumption' || rule.statement !== assumption.statement || !rule.confirmation_paths.includes(assumption.confirmation_ref)) throw new Error('Confirmed assumption must match ledger and confirmation source');
          } catch (error) { fail(`Assumption: ${error.message}`); }
        }
      }
      checkDataReferences(item).forEach(fail);
      checkData(item).forEach(fail);
    }
  } catch (error) { errors.push(error.message); }
  return { version: 1, run_id: runId, status: errors.length ? 'blocked' : 'passed', provenance_sha256: provenanceSha256, case_ids: selected.map(c => c.case_id), files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), errors, cases: selected };
}

export function designReceipt(result) {
  const { cases, errors, ...receipt } = result;
  return receipt;
}

export function validatePlanDesign(root, runId, plan) {
  try {
    if (plan?.run_id !== runId || !Array.isArray(plan.cases)) throw new Error('Plan run or case list mismatch');
    if (plan.design_gate?.version !== 1 || plan.design_gate.status !== 'passed') throw new Error('Missing design gate; regenerate plan after reviewing cases');
    const result = inspectDesign({ root, runId, source: plan.source, selectedIds: plan.cases.map(c => c.case_id) });
    if (result.errors.length) return result.errors;
    if (JSON.stringify(designReceipt(result)) !== JSON.stringify(plan.design_gate)) throw new Error('Design inputs changed; regenerate and obtain approval for the new plan');
    if (JSON.stringify(createExecutionCases(result.cases)) !== JSON.stringify(plan.cases)) throw new Error('Plan cases differ from validated source');
    return [];
  } catch (error) { return [error.message]; }
}
