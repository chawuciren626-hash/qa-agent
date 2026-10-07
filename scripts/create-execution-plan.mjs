import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createExecutionCases, extractCases, readJson, validateExecutionPlan } from "./execution-plan.mjs";

const root = resolve(import.meta.dirname, "..");
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
const sourceArg = process.argv.find((arg) => arg.startsWith("--cases="))?.slice(8);
const selectionArg = process.argv.find((arg) => arg.startsWith("--selection="))?.slice(12);
const environmentConfig = process.argv.find(arg => arg.startsWith('--environment-config='))?.slice(21) ?? 'config/test-env.json';
const testDir = process.argv.find(arg => arg.startsWith('--test-dir='))?.slice(11) ?? 'tests/generated';
if (!runId || !sourceArg) throw new Error("用法: node scripts/create-execution-plan.mjs --run-id=<run_id> --cases=<test_cases.json>");
const sourcePath = resolve(root, sourceArg);
if (!existsSync(sourcePath)) throw new Error(`找不到测试用例文件: ${sourcePath}`);
const environment = JSON.parse(readFileSync(resolve(root, environmentConfig), "utf8"));
const allCases = extractCases(readJson(sourcePath));
const selection = selectionArg ? readJson(resolve(root, selectionArg)) : null;
if (selection && selection.run_id !== runId) throw new Error("选择结果的 run_id 与执行计划不一致。");
const selectedIds = selection ? new Set((selection.selected ?? []).map((item) => item.case_id)) : null;
const cases = createExecutionCases(selectedIds ? allCases.filter((testCase) => selectedIds.has(testCase.case_id)) : allCases);
const allParallelSafe = cases.every((testCase) => ["read_only", "isolated"].includes(testCase.execution_contract.data_isolation));
const configuredWorkers = Math.max(1, Number(environment.execution?.max_workers ?? 1));
const plan = {
  run_id: runId,
  generated_at: new Date().toISOString(),
  source: sourceArg.replace(/\\/g, "/"),
  environment_config: environmentConfig,
  selection: selection ? { profile: selection.profile, source: selectionArg.replace(/\\/g, "/"), summary: selection.summary } : null,
  cases,
  execution_policy: {
    test_dir: testDir,
    workers: allParallelSafe ? configuredWorkers : 1,
    requires_environment_preflight: true,
    evidence: { screenshot: "only-on-failure", trace: "retain-on-failure", video: "off" }
  }
};
const errors = validateExecutionPlan(plan);
if (errors.length) throw new Error(errors.join("\n"));
const targetDir = resolve(root, "output/runs", runId, "execution");
mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, "execution-plan.json");
writeFileSync(target, JSON.stringify(plan, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, total_cases: cases.length, workers: plan.execution_policy.workers, plan: target }, null, 2));
