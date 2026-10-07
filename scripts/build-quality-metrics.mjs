import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractCases } from "./execution-plan.mjs";

const root = resolve(import.meta.dirname, "..");
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
if (!runId) throw new Error("用法: node scripts/build-quality-metrics.mjs --run-id=<run_id>");
const governance = JSON.parse(readFileSync(resolve(root, "config/quality-governance.json"), "utf8"));
const runDir = resolve(root, "output/runs", runId);
const readOptional = (relative, fallback) => {
  const path = resolve(runDir, relative);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
};
const testCaseData = readOptional("design/test_cases.json", []);
const testCases = extractCases(testCaseData);
const results = readOptional("execution/test_results.json", { status: "not_executed", summary: {}, cases: [] });
const evidence = readOptional("quality/evidence-assessment.json", { summary: { failed_cases: 0, triage_ready: 0, insufficient: 0, confidence: {} } });
const defectData = readOptional("defects/defect-records.json", { records: [] });
const selection = readOptional("selection/test-selection.json", null);
const executionPlan = readOptional("execution/execution-plan.json", null);
const records = defectData.records ?? [];
const by = (items, key) => Object.fromEntries([...new Set(items.map(key))].map((value) => [value, items.filter((item) => key(item) === value).length]));
const summary = results.summary ?? {};
const totalExecuted = summary.total ?? 0;
const blocked = results.status === "blocked" || (summary.blocked ?? 0) > 0;
const reasons = [];
const required = ['execution/test_results.json', 'quality/evidence-assessment.json', 'defects/defect-records.json'];
const missingInputs = required.filter(path => !existsSync(resolve(runDir, path)));
if (missingInputs.length) reasons.push('missing_quality_inputs');
if (!totalExecuted) reasons.push('no_executed_cases');
const failedCases = (results.cases ?? []).filter(item => item.status === 'failed');
if (failedCases.some(item => !(evidence.assessments ?? []).some(assessment => assessment.case_id === item.case_id))) reasons.push('incomplete_evidence_assessment');
if (failedCases.some(item => !records.some(record => record.related_cases?.includes(item.case_id)))) reasons.push('untriaged_failures');
if (blocked) reasons.push("blocked_execution");
if ((evidence.summary?.insufficient ?? 0) > 0) reasons.push("insufficient_failed_evidence");
if (records.some((record) => record.lifecycle_status === "needs_review")) reasons.push("needs_review");
if (records.some((record) => record.category === "product_defect" && record.lifecycle_status === "draft")) reasons.push("draft_product_defect");
if (records.some((record) => (governance.quality_gate?.risk_on_severity ?? []).includes(record.severity))) reasons.push("high_severity_defect");
const blockReasons = governance.quality_gate?.block_on ?? [];
const reviewReasons = governance.quality_gate?.review_on ?? [];
const integrityBlocked = reasons.some(reason => ['missing_quality_inputs', 'no_executed_cases', 'incomplete_evidence_assessment'].includes(reason));
const gateStatus = integrityBlocked || reasons.some((reason) => blockReasons.includes(reason)) ? "blocked" : reasons.includes('untriaged_failures') || reasons.some((reason) => reviewReasons.includes(reason)) ? "review_required" : reasons.includes("high_severity_defect") ? "risk_present" : "informational";
const metrics = {
  run_id: runId,
  generated_at: new Date().toISOString(),
  design: {
    total_cases: testCases.length,
    traceable_cases: testCases.filter((testCase) => Boolean(testCase.related_test_point)).length,
    automation_feasible_cases: testCases.filter((testCase) => testCase.automation_feasible).length,
    asset_referenced_cases: testCases.filter((testCase) => (testCase.asset_refs ?? []).length > 0).length
  },
  selection: selection ? { profile: selection.profile, selected: selection.summary?.selected ?? 0, estimated_duration_ms: selection.summary?.estimated_duration_ms ?? 0 } : null,
  execution: {
    status: results.status,
    total: totalExecuted,
    passed: summary.passed ?? 0,
    failed: summary.failed ?? 0,
    skipped: summary.skipped ?? 0,
    blocked: summary.blocked ?? 0,
    pass_rate: totalExecuted ? Number((((summary.passed ?? 0) / totalExecuted) * 100).toFixed(2)) : null,
    plan_case_count: executionPlan?.cases?.length ?? 0,
    failure_categories: by((results.cases ?? []).filter((testCase) => testCase.status === "failed"), (testCase) => testCase.failure_category ?? "needs_review")
  },
  trust: {
    missing_inputs: missingInputs,
    evidence: evidence.summary ?? {},
    unclassified_failures: (results.cases ?? []).filter((testCase) => testCase.status === "failed" && !testCase.failure_category).length
  },
  defects: {
    total: records.length,
    categories: by(records, (record) => record.category),
    lifecycle: by(records, (record) => record.lifecycle_status),
    confidence: by(records, (record) => record.confidence),
    severity: by(records, (record) => record.severity)
  },
  quality_gate: { status: gateStatus, reasons }
};
const targetDir = resolve(runDir, "report");
mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, "quality-metrics.json");
writeFileSync(target, JSON.stringify(metrics, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, quality_gate: metrics.quality_gate, output: target }, null, 2));
