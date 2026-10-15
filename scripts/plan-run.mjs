import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRunContext, recomputeRunStatus, writeJson, withRunLock } from "./orchestration-state.mjs";
import { workflowDefinition } from './stage-registry.mjs';

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const workflow = workflowDefinition();
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
const requested = process.argv.find((arg) => arg.startsWith("--stages="))?.slice(9)?.split(",").filter(Boolean)
  ?? workflow.stages.map((stage) => stage.id);
const reviewMode = process.argv.find((arg) => arg.startsWith('--review-mode='))?.slice(14) ?? 'staged';
// The legacy CLI keeps its saved lifecycle behavior; the structured user entry defaults to task.
const workflowMode = process.argv.find(arg=>arg.startsWith('--workflow-mode='))?.slice(16) ?? 'lifecycle';
const sourceMode = process.argv.find(arg=>arg.startsWith('--source-mode='))?.slice(14) ?? 'provided_materials';
if (!['provided_materials','live_product'].includes(sourceMode) || (sourceMode==='live_product' && workflowMode!=='task')) throw new Error('Invalid source mode for this workflow');
if (!['task','lifecycle'].includes(workflowMode)) throw new Error('workflow-mode must be task or lifecycle');
if (!['auto','staged'].includes(reviewMode)) throw new Error('review-mode must be auto or staged');
if (!runId) throw new Error("用法: node scripts/plan-run.mjs --run-id=<run_id> [--stages=analysis,test_points,...]");
const definitions = new Map(workflow.stages.map((stage) => [stage.id, stage]));
const selected = new Set();
function selectWithDependencies(stageId) {
  const stage = definitions.get(stageId);
  if (!stage) throw new Error(`未知阶段: ${stageId}`);
  if (selected.has(stageId)) return;
  if (workflowMode === 'lifecycle') for (const dependency of stage.depends_on) selectWithDependencies(dependency);
  selected.add(stageId);
}
requested.forEach(selectWithDependencies);
if (sourceMode==='live_product') selected.add('execution');

withRunLock(root, project, runId, () => {
const { manifestPath, manifest } = getRunContext(root, project, runId);
if (manifest.orchestration?.plan?.stages?.length) throw new Error("运行计划已存在，不能覆盖。同一任务继续后续阶段请使用 extend_plan；不要重建运行或重置已完成阶段。");
const now = new Date().toISOString();
const planStages = workflow.stages.map((definition) => ({ ...definition, depends_on: workflowMode==='task'?[]:definition.depends_on, confirmation: workflowMode==='task'?(reviewMode==='staged'?'after':'none'):reviewMode === 'auto' && definition.confirmation === 'after' ? 'none' : definition.confirmation, selected: selected.has(definition.id) }));
if (sourceMode==='live_product') {
  for (const stage of planStages) if (stage.id!=='execution') stage.depends_on=['execution'];
  planStages.sort((a,b)=>Number(b.id==='execution')-Number(a.id==='execution'));
}
manifest.manifest_version = 3;
manifest.orchestration ??= { events: [] };
manifest.orchestration.plan = {
  workflow_id: workflow.workflow_id,
  workflow_version: workflow.workflow_version,
  workflow_mode: workflowMode,
  source_mode: sourceMode,
  review_mode: reviewMode,
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
});
