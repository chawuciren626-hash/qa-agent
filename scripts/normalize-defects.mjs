import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLatestExecution } from './execution-attempts.mjs';
import { registerObservations } from './defect-lifecycle.mjs';

const root = resolve(import.meta.dirname, "..");
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
if (!runId) throw new Error("用法: node scripts/normalize-defects.mjs --run-id=<run_id>");
const runDir = resolve(root, "output/runs", runId);
const bugsPath = resolve(runDir, "defects/bugs.json");
if (!existsSync(bugsPath)) throw new Error(`缺少缺陷分析产物: ${bugsPath}`);
const source = JSON.parse(readFileSync(bugsPath, "utf8"));
const resultPath = resolve(runDir, 'execution/test_results.json');
let results = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
const statePath = resolve(runDir, 'execution/execution-state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
if (state?.version === 2) results = loadLatestExecution(root, runId).results;
if (state?.version === 2 && (Array.isArray(source) || source.run_id !== runId || source.invocation_id !== state.invocation_id)) throw new Error('Bug analysis must explicitly reference the current run and invocation_id');
const items = Array.isArray(source) ? source : source.bugs ?? [];
if (state?.version === 2 && results.status === 'blocked' && items.length) throw new Error('Blocked attempt cannot reuse historical bug records');
const assessmentPath = resolve(runDir, 'quality/evidence-assessment.json');
const assessments = existsSync(assessmentPath) ? JSON.parse(readFileSync(assessmentPath, 'utf8')).assessments ?? [] : [];
if (state?.version === 2 && (!existsSync(assessmentPath) || JSON.parse(readFileSync(assessmentPath, 'utf8')).invocation_id !== state.invocation_id)) throw new Error('Evidence assessment is stale; regenerate it for the current attempt');
const firstByFingerprint = new Map();
const usedIds = new Set();
const records = items.map((item, index) => {
  const category = item.classification ?? item.category ?? "needs_review";
  const cases = item.related_cases ?? (item.related_case ? [item.related_case] : item.case_id ? [item.case_id] : []);
  const evidence = item.evidence_refs ?? item.evidence_paths ?? item.evidence?.paths ?? [];
  const levels = ['low', 'medium', 'strong'];
  const confidence = cases.length ? levels[Math.min(...cases.map(id => Math.max(0, levels.indexOf(assessments.find(entry => entry.case_id === id)?.evidence_confidence))))] : 'low';
  const title = item.title ?? item.summary ?? "未命名问题";
  const scopeId = typeof source.scope_id === 'string' && source.scope_id.trim() ? source.scope_id.trim() : runId;
  const fingerprint = createHash("sha256").update(JSON.stringify({ scope_id: scopeId, category, cases: [...new Set(cases)].sort(), title: title.trim().toLowerCase(), expected: item.expected_result ?? "", actual: item.actual_result ?? item.failure_summary ?? "" })).digest("hex").slice(0, 16);
  const baseId = item.bug_id ?? `DEF-${fingerprint.toUpperCase()}`;
  let defectId = baseId;
  let suffix = index + 1;
  while (usedIds.has(defectId)) defectId = `${baseId}-${suffix++}`;
  usedIds.add(defectId);
  const duplicateOf = firstByFingerprint.get(fingerprint) ?? null;
  if (!duplicateOf) firstByFingerprint.set(fingerprint, defectId);
  return {
    defect_id: defectId,
    fingerprint,
    scope_id: scopeId,
    category,
    lifecycle_status: confidence === 'low' || item.needs_review || category === 'needs_review' ? 'needs_review' : 'draft',
    confidence,
    severity: item.severity ?? "unknown",
    priority: item.priority ?? "unknown",
    title,
    related_cases: cases,
    evidence_refs: evidence,
    expected_result: item.expected_result ?? "",
    actual_result: item.actual_result ?? item.failure_summary ?? "",
    analysis: item.analysis ?? item.recommended_action ?? "",
    duplicate_of: duplicateOf
  };
});
const summary = Object.fromEntries(["product_defect", "script_issue", "environment_issue", "test_data_issue", "needs_review"].map((category) => [category, records.filter((item) => item.category === category).length]));
const output = { run_id: runId, invocation_id: results?.invocation_id, generated_at: new Date().toISOString(), records, summary };
if (state?.version === 2) registerObservations(root, runId, output);
const targetDir = resolve(runDir, "defects");
mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, "defect-records.json");
writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, records: records.length, output: target }, null, 2));
