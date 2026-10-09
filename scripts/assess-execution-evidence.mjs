import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadLatestExecution } from './execution-attempts.mjs';

const root = resolve(import.meta.dirname, "..");
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
if (!runId) throw new Error("用法: node scripts/assess-execution-evidence.mjs --run-id=<run_id>");
const policy = JSON.parse(readFileSync(resolve(root, "config/quality-governance.json"), "utf8"));
const minimumEvidence = policy.confidence ?? {};
const runDir = resolve(root, "output/runs", runId);
const resultsPath = resolve(runDir, "execution/test_results.json");
if (!existsSync(resultsPath)) throw new Error(`缺少执行结果: ${resultsPath}`);
const { results } = loadLatestExecution(root, runId);
const assessments = (results.cases ?? []).filter((testCase) => testCase.status === "failed").map((testCase) => {
  const refs = [...new Set((testCase.evidence_paths ?? []).map(item => isAbsolute(item) ? resolve(item) : resolve(runDir, item)))];
  const existing = refs.filter(item => {
    try { const stat = statSync(item); return stat.isFile() && stat.size > 0; } catch { return false; }
  });
  const hasError = Boolean(testCase.error_message?.trim());
  const confidence = hasError && existing.length >= (minimumEvidence.strong?.minimum_evidence_refs ?? 3)
    ? "strong"
    : hasError && existing.length >= (minimumEvidence.medium?.minimum_evidence_refs ?? 2)
      ? "medium"
      : "low";
  return {
    case_id: testCase.case_id,
    has_error_message: hasError,
    evidence_refs: refs,
    existing_evidence_refs: existing,
    evidence_confidence: confidence,
    triage_ready: confidence !== "low"
  };
});
const summary = {
  failed_cases: assessments.length,
  triage_ready: assessments.filter((item) => item.triage_ready).length,
  insufficient: assessments.filter((item) => !item.triage_ready).length,
  confidence: Object.fromEntries(["low", "medium", "strong"].map((level) => [level, assessments.filter((item) => item.evidence_confidence === level).length]))
};
const output = { run_id: runId, invocation_id: results.invocation_id, generated_at: new Date().toISOString(), raw_result: "execution/test_results.json", assessments, summary };
const targetDir = resolve(runDir, "quality");
mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, "evidence-assessment.json");
writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, ...summary, output: target }, null, 2));
