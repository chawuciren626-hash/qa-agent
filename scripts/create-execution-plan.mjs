import { resourcePath } from './directory-context.mjs';
import { dataPath } from './directory-context.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createExecutionCases, extractCases, validateExecutionPlan } from "./execution-plan.mjs";
import { inspectDesign, designReceipt, readRunFile, runDirectory } from './design-quality.mjs';

const root = resolve(import.meta.dirname, "..");
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
const sourceArg = process.argv.find((arg) => arg.startsWith("--cases="))?.slice(8);
const selectionArg = process.argv.find((arg) => arg.startsWith("--selection="))?.slice(12);
const environmentConfig = process.argv.find(arg => arg.startsWith('--environment-config='))?.slice(21) ?? 'config/test-env.json';
const testDir = process.argv.find(arg => arg.startsWith('--test-dir='))?.slice(11) ?? 'tests/generated';
if (!runId || !sourceArg) throw new Error("用法: node scripts/create-execution-plan.mjs --run-id=<run_id> --cases=<test_cases.json>");
const runDir = runDirectory(root, runId);
const sourcePath = resourcePath(root, sourceArg);
if (!existsSync(sourcePath)) throw new Error(`找不到测试用例文件: ${sourcePath}`);
const environment = JSON.parse(readFileSync(resourcePath(root, environmentConfig), "utf8"));
const selection = selectionArg ? JSON.parse(readRunFile(runDir, resourcePath(root, selectionArg)).data.toString('utf8')) : null;
if (selection && selection.run_id !== runId) throw new Error("选择结果的 run_id 与执行计划不一致。");
const allCases = extractCases(JSON.parse(readRunFile(runDir, sourcePath).data.toString('utf8')));
const requestedIds = selection ? (selection.selected ?? []).map(item => item.case_id) : allCases.map(item => item.case_id);
if (!requestedIds.length || new Set(requestedIds).size !== requestedIds.length || new Set(allCases.map(c => c.case_id)).size !== allCases.length || requestedIds.some(id => !allCases.some(c => c.case_id === id))) throw new Error('Invalid or missing selected case IDs');
const requested = allCases.filter(c => requestedIds.includes(c.case_id));
if (requested.some(c => typeof c.automation_feasible !== 'boolean')) throw new Error('automation_feasible must be explicit');
const manualPending = requested.filter(c => !c.automation_feasible).map(c => ({ case_id: c.case_id, title: c.title, status: 'pending_manual', reason: 'Not eligible for automated execution' }));
const selectedIds = requested.filter(c => c.automation_feasible).map(c => c.case_id);
if (!selectedIds.length) throw new Error('Selection contains only manual cases; no automated execution plan can be created. See selection/test-selection.json.');
const checked = inspectDesign({ root, runId, source: sourceArg, selectedIds });
if (checked.errors.length) throw new Error(checked.errors.join('\n'));
const cases = createExecutionCases(checked.cases);
const allParallelSafe = cases.every((testCase) => ["read_only", "isolated"].includes(testCase.execution_contract.data_isolation));
const configuredWorkers = Math.max(1, Number(environment.execution?.max_workers ?? 1));
const plan = {
  run_id: runId,
  generated_at: new Date().toISOString(),
  source: sourceArg.replace(/\\/g, "/"),
  environment_config: environmentConfig,
  selection: selection ? { profile: selection.profile, source: selectionArg.replace(/\\/g, "/"), summary: selection.summary } : null,
  cases,
  manual_pending: manualPending,
  design_gate: designReceipt(checked),
  execution_policy: {
    test_dir: testDir,
    workers: allParallelSafe ? configuredWorkers : 1,
    global_timeout_ms: environment.execution?.global_timeout_ms ?? 900000,
    preflight_timeout_ms: environment.execution?.preflight_timeout_ms ?? 60000,
    requires_environment_preflight: true,
    evidence: { screenshot: "only-on-failure", trace: "retain-on-failure", video: "off" }
  }
};
const errors = validateExecutionPlan(plan);
if (errors.length) throw new Error(errors.join("\n"));
const targetDir = dataPath(root, "output/runs", runId, "execution");
mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, "execution-plan.json");
writeFileSync(target, JSON.stringify(plan, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, total_cases: cases.length, workers: plan.execution_policy.workers, plan: target }, null, 2));
