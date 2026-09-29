import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRunContext, recomputeRunStatus, writeJson } from "./orchestration-state.mjs";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const workflow = JSON.parse(readFileSync(resolve(root, "config/orchestration-workflow.json"), "utf8"));
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
const requested = process.argv.find((arg) => arg.startsWith("--stages="))?.slice(9)?.split(",").filter(Boolean)
  ?? workflow.stages.map((stage) => stage.id);
if (!runId) throw new Error("用法: node scripts/plan-run.mjs --run-id=<run_id> [--stages=analysis,test_points,...]");
const definitions = new Map(workflow.stages.map((stage) => [stage.id, stage]));
const selected = new Set();
function selectWithDependencies(stageId) {
  const stage = definitions.get(stageId);
  if (!stage) throw new Error(`未知阶段: ${stageId}`);
  if (selected.has(stageId)) return;
  for (const dependency of stage.depends_on) selectWithDependencies(dependency);
  selected.add(stageId);
}
requested.forEach(selectWithDependencies);

const { manifestPath, manifest } = getRunContext(root, project, runId);
if (manifest.orchestration?.plan?.stages?.length) throw new Error("运行计划已存在，不能覆盖。请创建新的 run_id。 ");
const now = new Date().toISOString();
const planStages = workflow.stages.map((definition) => ({ ...definition, selected: selected.has(definition.id) }));
manifest.manifest_version = 3;
manifest.orchestration ??= { events: [] };
manifest.orchestration.plan = {
  workflow_id: workflow.workflow_id,
  workflow_version: workflow.workflow_version,
  planned_at: now,
  stages: planStages
};
manifest.stages ??= {};
for (const stage of planStages) {
  manifest.stages[stage.id] = {
    status: stage.selected ? "planned" : "skipped",
    updated_at: now,
    reason: stage.selected ? undefined : "未纳入本次任务计划"
  };
}
manifest.orchestration.resume_from = planStages.find((stage) => stage.selected)?.id ?? "completed";
manifest.orchestration.events ??= [];
manifest.orchestration.events.push({ type: "plan_created", at: now, stages: [...selected] });
manifest.status = recomputeRunStatus(manifest);
manifest.updated_at = now;
writeJson(manifestPath, manifest);
console.log(JSON.stringify({ run_id: runId, workflow: workflow.workflow_id, selected_stages: [...selected], status: manifest.status }, null, 2));
