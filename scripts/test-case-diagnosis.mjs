import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { inspectDesign, readRunFile, runDirectory, inspectCaseData } from './design-quality.mjs';
import { extractCases } from './execution-plan.mjs';
import { diagnoseTestPoints } from './test-point-diagnosis.mjs';

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
  JSON.parse(readFileSync(new URL('../schemas/test_case.schema.json', import.meta.url), 'utf8'))
);

// Draft-only diagnosis: aggregate corrections before any export or formal validation budget.
export function diagnoseTestCases(root, runId) {
  const dir = runDirectory(root, runId);
  const errors = new Set();
  const add = value => errors.add(value);
  let rows = [];
  let points = [];
  try {
    const source = JSON.parse(readRunFile(dir, 'design/test_cases.json').data.toString('utf8'));
    if (!Array.isArray(source) && source.run_id !== undefined && source.run_id !== runId) add('design/test_cases.json: run_id mismatch');
    rows = extractCases(source);
    if (!rows.length) add('design/test_cases.json: empty collection');
  } catch (error) { add(`design/test_cases.json: ${error.message}`); }
  try {
    const pointResult = diagnoseTestPoints(runId, path => readRunFile(dir, path).data);
    pointResult.errors.forEach(add);
    points = pointResult.rows;
  } catch (error) { add(`test point baseline: ${error.message}`); }
  const pointMap = new Map(points.map(point => [point.id, point]));
  const ids = new Set();
  const covered = new Set();
  for (const [index, row] of rows.entries()) {
    const label = typeof row?.case_id === 'string' && row.case_id ? row.case_id : `design/test_cases.json[${index}]`;
    if (!validate(row)) for (const error of validate.errors) add(`${label}: ${error.instancePath || '/'} ${error.message}`);
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (ids.has(row.case_id)) add(`${label}: duplicate case_id`);
    ids.add(row.case_id);
    const point = pointMap.get(row.related_test_point);
    if (!point) add(`${label}: unknown related_test_point`);
    else {
      covered.add(point.id);
      for (const basis of row.design_contract?.basis ?? []) if (basis?.rule_id && !point.rule_ids?.includes(basis.rule_id)) add(`${label}: basis rule ${basis.rule_id} not covered by related test point`);
    }
  }
  for (const point of points) if (!covered.has(point.id)) add(`${point.id}: missing test case coverage`);
  if (rows.length) inspectDesign({ root, runId, source: resolve(dir, 'design/test_cases.json'), execution: false }).errors.forEach(add);
  const all = [...errors];
  return {
    status: all.length ? 'needs_correction' : 'passed', errors: all, error_count: all.length,
    case_count: rows.length, point_count: points.length, approval_granted: false, exports_checked: false,
    data_diagnostics: rows.filter(row=>row && typeof row==='object' && !Array.isArray(row)).map(inspectCaseData),
    scope: 'Draft JSON, schema, test-point linkage and design basis/data checks only; no Excel validation or execution authorization'
  };
}
