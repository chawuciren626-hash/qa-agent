import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRunContext, selectedPlanStages } from "./orchestration-state.mjs";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const runId = process.argv[2];
if (!runId) throw new Error("用法: node scripts/show-run-plan.mjs <run_id>");
const { manifest } = getRunContext(root, project, runId);
console.log(JSON.stringify({
  run_id: runId,
  status: manifest.status,
  workflow: manifest.orchestration?.plan?.workflow_id ?? null,
  stages: selectedPlanStages(manifest).map((stage) => ({
    id: stage.id,
    agent: stage.agent,
    depends_on: stage.depends_on,
    confirmation: stage.confirmation,
    status: manifest.stages?.[stage.id]?.status
  }))
}, null, 2));
