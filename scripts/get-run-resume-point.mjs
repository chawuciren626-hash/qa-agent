import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const runId = process.argv[2];
if (!runId) throw new Error("用法: node scripts/get-run-resume-point.mjs <run_id>");
const manifestPath = resolve(root, project.run_root, runId, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`找不到运行清单: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const order = ["analysis", "test_points", "test_cases", "execution", "defects", "report"];
const resumeFrom = order.find((stage) => manifest.stages?.[stage]?.status !== "completed") ?? "completed";
console.log(JSON.stringify({ run_id: runId, status: manifest.status, resume_from: resumeFrom, stages: manifest.stages ?? {} }, null, 2));
