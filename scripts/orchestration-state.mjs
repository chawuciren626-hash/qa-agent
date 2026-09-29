import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const stageStatuses = new Set([
  "planned", "in_progress", "completed", "awaiting_confirmation",
  "revision_requested", "blocked", "failed", "skipped"
]);

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function getRunContext(root, project, runId) {
  const manifestPath = resolve(root, project.run_root, runId, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`找不到运行清单: ${manifestPath}`);
  return { manifestPath, manifest: readJson(manifestPath) };
}

export function getPlanStage(manifest, stageId) {
  return manifest.orchestration?.plan?.stages?.find((stage) => stage.id === stageId);
}

export function selectedPlanStages(manifest) {
  return manifest.orchestration?.plan?.stages?.filter((stage) => stage.selected) ?? [];
}

export function hasApprovedConfirmation(manifest, stageId) {
  return (manifest.confirmations ?? []).some((item) => item.stage === stageId && item.status === "approved");
}

export function hasPendingConfirmation(manifest, stageId) {
  return (manifest.confirmations ?? []).some((item) => item.stage === stageId && item.status === "pending");
}

export function recomputeRunStatus(manifest) {
  const stages = selectedPlanStages(manifest);
  if (!stages.length) return manifest.status ?? "created";
  const states = stages.map((stage) => manifest.stages?.[stage.id]?.status ?? "planned");
  if (states.includes("failed")) return "failed";
  if (states.includes("blocked")) return "blocked";
  if (states.includes("awaiting_confirmation")) return "awaiting_confirmation";
  if (states.every((status) => ["completed", "skipped"].includes(status))) return "completed";
  return "in_progress";
}

export function assertStageReady(manifest, stageId) {
  const stage = getPlanStage(manifest, stageId);
  if (!stage?.selected) throw new Error(`阶段未在本次运行计划中启用: ${stageId}`);
  const state = manifest.stages?.[stageId]?.status ?? "planned";
  if (!["planned", "revision_requested"].includes(state)) {
    throw new Error(`阶段 ${stageId} 当前状态为 ${state}，不能派发。`);
  }
  const unfinished = (stage.depends_on ?? []).filter((dependency) =>
    !["completed", "skipped"].includes(manifest.stages?.[dependency]?.status));
  if (unfinished.length) throw new Error(`阶段 ${stageId} 的前置阶段未完成: ${unfinished.join(", ")}`);
  const unapprovedDependencies = (stage.depends_on ?? []).filter((dependency) => {
    const dependencyPlan = getPlanStage(manifest, dependency);
    return dependencyPlan?.confirmation === "after" && !hasApprovedConfirmation(manifest, dependency);
  });
  if (unapprovedDependencies.length) {
    throw new Error(`阶段 ${stageId} 的前置阶段尚未批准: ${unapprovedDependencies.join(", ")}`);
  }
  if (stage.confirmation === "before" && !hasApprovedConfirmation(manifest, stageId)) {
    throw new Error(`阶段 ${stageId} 需要执行前人工批准。`);
  }
  return stage;
}
