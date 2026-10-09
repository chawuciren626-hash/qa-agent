import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, validateExecutionPlan } from "./execution-plan.mjs";
import { runDirectory, validatePlanDesign } from './design-quality.mjs';

const root = resolve(import.meta.dirname, "..");
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
if (!runId) throw new Error("用法: node scripts/validate-execution-plan.mjs --run-id=<run_id>");
const path = resolve(runDirectory(root, runId), "execution/execution-plan.json");
if (!existsSync(path)) throw new Error(`缺少执行计划: ${path}`);
const plan = readJson(path);
const errors = [...validateExecutionPlan(plan), ...validatePlanDesign(root, runId, plan)];
console.log(JSON.stringify({ run_id: runId, status: errors.length ? "invalid" : "valid", errors }, null, 2));
process.exitCode = errors.length ? 2 : 0;
