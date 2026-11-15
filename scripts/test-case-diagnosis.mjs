import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { inspectDesign, readRunFile, runDirectory, inspectCaseData } from './design-quality.mjs';
import { extractCases } from './execution-plan.mjs';
import { diagnoseTestPoints } from './test-point-diagnosis.mjs';
import { inspectExpectationBasis, collectSourceTexts } from './expectation-basis.mjs';

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

  /**
   * 预期依据诊断。复用 `expectation-basis.mjs` 里已经跑在执行期的那套判定，
   * 不另造一份——两套判定并存的话，用例阶段说「依据齐全」、执行阶段说「依据不成立」，
   * 谁都不知道该信哪个。
   *
   * 可引用的来源只到 `inputs/`：拿 `analysis/` 下自己刚写的产物当依据，等于自证。
   * 二进制（docx/xlsx 原件）不进来——引用应当指向提取后的文本，否则 quote 无从比对。
   */
  const sourceTexts = collectSourceTexts(dir);
  const expectationDiagnostics = rows
    .filter(row => row && typeof row === 'object' && !Array.isArray(row))
    .map(row => inspectExpectationBasis(row, sourceTexts));
  for (const item of expectationDiagnostics) item.errors.forEach(error => add(`${item.case_id}: ${error}`));
  const all = [...errors];
  return {
    status: all.length ? 'needs_correction' : 'passed', errors: all, error_count: all.length,
    case_count: rows.length, point_count: points.length, approval_granted: false, exports_checked: false,
    data_diagnostics: rows.filter(row=>row && typeof row==='object' && !Array.isArray(row)).map(inspectCaseData),
    // 预期依据：`not_recorded` 只给 warnings，不进 errors——旧用例要能继续跑，只是不能算「已核验」。
    expectation_diagnostics: expectationDiagnostics,
    expectation_summary: {
      recorded: expectationDiagnostics.filter(item => item.status !== 'not_recorded').length,
      source_located: expectationDiagnostics.filter(item => item.status === 'source_located').length,
      needs_correction: expectationDiagnostics.filter(item => item.status === 'needs_correction').length,
      not_recorded: expectationDiagnostics.filter(item => item.status === 'not_recorded').length,
    },
    scope: 'Draft JSON, schema, test-point linkage, design basis/data checks and expected-basis provenance only; semantic support, Excel validation and execution authorization are out of scope'
  };
}
