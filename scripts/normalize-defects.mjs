import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
if (!runId) throw new Error("用法: node scripts/normalize-defects.mjs --run-id=<run_id>");
const runDir = resolve(root, "output/runs", runId);
const bugsPath = resolve(runDir, "defects/bugs.json");
if (!existsSync(bugsPath)) throw new Error(`缺少缺陷分析产物: ${bugsPath}`);
const source = JSON.parse(readFileSync(bugsPath, "utf8"));
const items = Array.isArray(source) ? source : source.bugs ?? [];
const firstByFingerprint = new Map();
const records = items.map((item) => {
  const category = item.classification ?? item.category ?? "needs_review";
  const cases = item.related_cases ?? (item.related_case ? [item.related_case] : item.case_id ? [item.case_id] : []);
  const evidence = item.evidence_refs ?? item.evidence_paths ?? item.evidence?.paths ?? [];
  const confidence = evidence.length >= 3 ? "strong" : evidence.length >= 2 ? "medium" : "low";
  const title = item.title ?? item.summary ?? "未命名问题";
  const fingerprint = createHash("sha256").update(JSON.stringify({ category, title: title.trim().toLowerCase(), expected: item.expected_result ?? "" })).digest("hex").slice(0, 16);
  const defectId = item.bug_id ?? `DEF-${fingerprint.toUpperCase()}`;
  const duplicateOf = firstByFingerprint.get(fingerprint) ?? null;
  if (!duplicateOf) firstByFingerprint.set(fingerprint, defectId);
  return {
    defect_id: defectId,
    fingerprint,
    category,
    lifecycle_status: item.lifecycle_status ?? (item.needs_review || category === "needs_review" ? "needs_review" : "draft"),
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
const output = { run_id: runId, generated_at: new Date().toISOString(), records, summary };
const targetDir = resolve(runDir, "defects");
mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, "defect-records.json");
writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, records: records.length, output: target }, null, 2));
