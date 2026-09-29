import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPlanStage, getRunContext, recomputeRunStatus, writeJson } from "./orchestration-state.mjs";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const [runId, stage, decision, ...reasonParts] = process.argv.slice(2);
if (!runId || !stage || !["approved", "revision_requested", "rejected"].includes(decision)) {
  throw new Error("用法: node scripts/resolve-stage-confirmation.mjs <run_id> <stage> <approved|revision_requested|rejected> [reason]");
}
const { manifestPath, manifest } = getRunContext(root, project, runId);
const timestamp = new Date().toISOString();
const confirmation = [...(manifest.confirmations ?? [])].reverse().find((item) => item.stage === stage && item.status === "pending");
if (!confirmation) throw new Error(`找不到 ${stage} 阶段待处理的确认请求。`);
confirmation.status = decision;
confirmation.resolved_at = timestamp;
if (reasonParts.length) confirmation.reason = reasonParts.join(" ");
manifest.stages ??= {};
manifest.orchestration ??= { events: [] };
manifest.orchestration.events ??= [];
const stagePlan = getPlanStage(manifest, stage);
if (!stagePlan?.selected) throw new Error(`阶段未在本次运行计划中启用: ${stage}`);
if (decision === "approved") {
  const nextStatus = stagePlan.confirmation === "before" ? "planned" : "completed";
  manifest.stages[stage] = { ...(manifest.stages[stage] ?? {}), status: nextStatus, updated_at: timestamp };
  manifest.orchestration.resume_from = stagePlan.confirmation === "before" ? stage : "next_stage";
} else {
  manifest.stages[stage] = { ...(manifest.stages[stage] ?? {}), status: decision === "rejected" ? "blocked" : "revision_requested", updated_at: timestamp, reason: confirmation.reason ?? "" };
  manifest.orchestration.resume_from = stage;
}
manifest.orchestration.events.push({ type: "confirmation_resolved", at: timestamp, stage, decision, reason: confirmation.reason ?? "" });
manifest.status = recomputeRunStatus(manifest);
manifest.updated_at = timestamp;
writeJson(manifestPath, manifest);
console.log(JSON.stringify({ run_id: runId, stage, decision, resume_from: manifest.orchestration.resume_from }, null, 2));
