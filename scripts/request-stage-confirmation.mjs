import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPlanStage, getRunContext, recomputeRunStatus, writeJson } from "./orchestration-state.mjs";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const [runId, stage, ...artifactArgs] = process.argv.slice(2);
if (!runId || !stage) throw new Error("用法: node scripts/request-stage-confirmation.mjs <run_id> <stage> [artifact...]");
const { manifestPath, manifest } = getRunContext(root, project, runId);
const timestamp = new Date().toISOString();
manifest.confirmations ??= [];
if (manifest.confirmations.some((item) => item.stage === stage && item.status === "pending")) {
  throw new Error(`${stage} 阶段已有待处理的确认请求，禁止重复创建。`);
}
manifest.stages ??= {};
manifest.orchestration ??= { events: [] };
const stagePlan = getPlanStage(manifest, stage);
if (!stagePlan?.selected || stagePlan.confirmation === "none") throw new Error(`${stage} 阶段未配置人工确认。`);
const expectedStatus = stagePlan.confirmation === "before" ? "planned" : "completed";
const revisingBeforeExecution = stagePlan.confirmation === "before" && manifest.stages[stage]?.status === "revision_requested";
if (manifest.stages[stage]?.status !== expectedStatus && !revisingBeforeExecution) {
  throw new Error(`${stage} 阶段当前状态为 ${manifest.stages[stage]?.status ?? "未计划"}，不能在 ${stagePlan.confirmation} 时请求确认。`);
}
const confirmation = {
  id: `confirm-${stage}-${Date.now()}`,
  stage,
  status: "pending",
  requested_at: timestamp,
  artifacts: artifactArgs
};
manifest.confirmations.push(confirmation);
manifest.stages[stage] = { ...(manifest.stages[stage] ?? {}), status: "awaiting_confirmation", updated_at: timestamp };
manifest.status = recomputeRunStatus(manifest);
manifest.orchestration.resume_from = stage;
manifest.orchestration.events ??= [];
manifest.orchestration.events.push({ type: "confirmation_requested", at: timestamp, stage, confirmation_id: confirmation.id });
manifest.updated_at = timestamp;
writeJson(manifestPath, manifest);
console.log(JSON.stringify({ run_id: runId, confirmation }, null, 2));
