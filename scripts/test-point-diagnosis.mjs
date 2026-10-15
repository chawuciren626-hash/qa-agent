import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { diagnoseRequirementLedger, inspectRequirementLedger, referencedRule, testPointCoverage } from './requirement-provenance.mjs';

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
  JSON.parse(readFileSync(new URL('../schemas/test_point.schema.json', import.meta.url), 'utf8'))
);
const text = value => typeof value === 'string' && value.trim().length > 0;

// Shared by draft diagnosis and delivery validation; no exports, state changes or approvals.
export function diagnoseTestPoints(runId, capture) {
  const errors = [];
  const add = message => { if (!errors.includes(message)) errors.push(message); };
  const cache = new Map();
  const read = path => {
    if (!cache.has(path)) cache.set(path, capture(path));
    return cache.get(path);
  };
  const analysis = diagnoseRequirementLedger(runId, read);
  analysis.errors.forEach(add);
  let rules;
  let ledger;
  try { ({ rules, ledger } = inspectRequirementLedger(runId, read)); }
  catch (error) { add(error.message); }
  let rows = [];
  try {
    const value = JSON.parse(read('design/test_points.json').toString('utf8'));
    if (!Array.isArray(value) && value?.run_id !== undefined && value.run_id !== runId) add('design/test_points.json: run_id mismatch');
    const keys = ['points', 'test_points'].filter(key => Array.isArray(value?.[key]));
    if (!Array.isArray(value) && keys.length !== 1) throw new Error('design/test_points.json: expected one supported collection');
    rows = Array.isArray(value) ? value : value[keys[0]];
    if (!rows.length) add('design/test_points.json: empty collection');
  } catch (error) { add(error.message); }
  const counts = new Map();
  for (const row of rows) if (text(row?.id)) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const covered = new Set();
  for (const [index, row] of rows.entries()) {
    const label = text(row?.id) ? row.id : `design/test_points.json[${index}]`;
    let valid = true;
    const fail = message => { valid = false; add(`${label}: ${message}`); };
    if (!validate(row)) for (const error of validate.errors) fail(`${error.instancePath || '/'} ${error.message}`);
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (!text(row.id)) fail('missing id');
    if (counts.get(row.id) > 1) fail('duplicate id');
    for (const field of ['module', 'feature', 'description', 'source']) if (!text(row[field])) fail(`empty ${field}`);
    if (!Array.isArray(row.coverage_type) || !row.coverage_type.length || !row.coverage_type.every(text)) fail('nonempty coverage_type required');
    if (text(row.source)) try { read(row.source); } catch (error) { fail(`source: ${error.message}`); }
    if (rules && Array.isArray(row.rule_ids)) {
      for (const id of row.rule_ids) try { referencedRule(rules, id); } catch (error) { fail(error.message); }
      if (valid) row.rule_ids.forEach(id => covered.add(id));
    }
  }
  const coverage = { required: [], supporting: [], optional: [], excluded: [], missing: [] };
  if (rules) for (const rule of rules.values()) {
    const role = testPointCoverage(rule);
    coverage[role].push(rule.id);
    if (role === 'required' && !covered.has(rule.id)) {
      coverage.missing.push(rule.id);
      add(`${rule.id}: requirement missing test point coverage`);
    }
  }
  return {
    status: errors.length ? 'needs_correction' : 'passed', errors, error_count: errors.length, coverage,
    coverage_counts: Object.fromEntries(Object.entries(coverage).map(([key, ids]) => [key, ids.length])),
    point_count: rows.length, rule_count: rules?.size ?? 0, coverage_evaluated: !!rules,
    approval_granted: false, exports_checked: false,
    scope: 'Draft JSON, rule references and explicit coverage classification only; no semantic approval, XMind validation or execution authorization',
    rows, ledger
  };
}
