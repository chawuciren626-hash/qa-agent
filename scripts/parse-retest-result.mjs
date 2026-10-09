import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runArg = process.argv.find((arg) => arg.startsWith("--run-id="));
const runId = runArg?.slice(9) ?? "run-" + new Date().toISOString().replace(/[:.]/g, "-");
const output = runArg ? resolve(root, "output/runs", runId, "execution") : resolve(root, "output");
const source = resolve(output, "playwright/playwright-results.json");
const target = resolve(output, "test_results_retest.json");
if (!existsSync(source)) throw new Error("缺少 Playwright 原始结果文件: " + source);

const raw = JSON.parse(readFileSync(source, "utf8"));
const cases = [];
function walk(suite) {
  for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
    const result = test.results?.at(-1) ?? {};
    const status = result.status === "passed" ? "passed" : result.status === "skipped" ? "skipped" : "failed";
    const caseId = spec.title.match(/\bTC-[A-Z0-9-]+\b/)?.[0] ?? spec.title;
    const attachments = (result.attachments ?? []).map((attachment) => attachment.path).filter(Boolean);
    cases.push({ case_id: caseId, status, duration_ms: result.duration ?? 0, error_message: result.error?.message ?? "", failure_category: status === "failed" ? "needs_review" : "none", evidence_paths: attachments });
  }
  for (const child of suite.suites ?? []) walk(child);
}
for (const suite of raw.suites ?? []) walk(suite);
const summary = { total: cases.length, passed: cases.filter(x => x.status === "passed").length, failed: cases.filter(x => x.status === "failed").length, skipped: cases.filter(x => x.status === "skipped").length, blocked: 0 };
writeFileSync(target, JSON.stringify({ run_id: runId, status: summary.failed || summary.total === 0 ? "failed" : "completed", started_at: raw.stats?.startTime ?? new Date().toISOString(), finished_at: new Date().toISOString(), summary, cases }, null, 2) + "\n");
console.log(`已生成 ${target}。`);
