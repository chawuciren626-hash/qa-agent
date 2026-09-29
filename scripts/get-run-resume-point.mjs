import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRunContext, selectedPlanStages } from "./orchestration-state.mjs";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const runId = process.argv[2];
if (!runId) throw new Error("用法: node scripts/get-run-resume-point.mjs <run_id>");
const { manifest } = getRunContext(root, project, runId);
const stages = selectedPlanStages(manifest);
const resumeFrom = stages.find((stage) => !["completed", "skipped"].includes(manifest.stages?.[stage.id]?.status))?.id ?? "completed";
console.log(JSON.stringify({ run_id: runId, status: manifest.status, resume_from: resumeFrom, stages: manifest.stages ?? {} }, null, 2));
