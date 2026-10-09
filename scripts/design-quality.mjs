import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createExecutionCases, extractCases } from './execution-plan.mjs';
import { inspectRequirementLedger, referencedRule } from './requirement-provenance.mjs';

export function runDirectory(root, runId) {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '')) throw new Error('Invalid run_id');
  return resolve(root, 'output/runs', runId);
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
        const lengths = {
          code_points: () => [...value].length,
          utf16: () => value.length,
          utf8_bytes: () => Buffer.byteLength(value, 'utf8'),
          graphemes: () => [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(value)].length
        };
        if (!Object.hasOwn(lengths, check.unit)) throw new Error('Explicit length unit required');
        if (!Number.isSafeInteger(check.expected) || check.expected < 0) throw new Error('Invalid expected length');
        const actual = lengths[check.unit]();
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
        if (sum !== integer(check.total_key)) throw new Error('Money sum does not equal declared total');
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
    const input = capture(resolve(root, source));
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
