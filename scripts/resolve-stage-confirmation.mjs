import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const [runId, stage, decision, ...reasonParts] = process.argv.slice(2);
if (!runId || !stage || !["approved", "revision_requested", "rejected"].includes(decision)) {
  throw new Error("用法: node scripts/resolve-stage-confirmation.mjs <run_id> <stage> <approved|revision_requested|rejected> [reason]");
}
const manifestPath = resolve(root, project.run_root, runId, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`找不到运行清单: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const timestamp = new Date().toISOString();
const confirmation = [...(manifest.confirmations ?? [])].reverse().find((item) => item.stage === stage && item.status === "pending");
if (!confirmation) throw new Error(`找不到 ${stage} 阶段待处理的确认请求。`);
confirmation.status = decision;
confirmation.resolved_at = timestamp;
if (reasonParts.length) confirmation.reason = reasonParts.join(" ");
manifest.stages ??= {};
manifest.orchestration ??= { events: [] };
manifest.orchestration.events ??= [];
if (decision === "approved") {
  manifest.stages[stage] = { ...(manifest.stages[stage] ?? {}), status: "completed", updated_at: timestamp };
  manifest.status = "in_progress";
  manifest.orchestration.resume_from = "next_stage";
} else {
  manifest.stages[stage] = { ...(manifest.stages[stage] ?? {}), status: decision === "rejected" ? "blocked" : "revision_requested", updated_at: timestamp, reason: confirmation.reason ?? "" };
  manifest.status = decision === "rejected" ? "blocked" : "in_progress";
  manifest.orchestration.resume_from = stage;
}
manifest.orchestration.events.push({ type: "confirmation_resolved", at: timestamp, stage, decision, reason: confirmation.reason ?? "" });
manifest.updated_at = timestamp;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, stage, decision, resume_from: manifest.orchestration.resume_from }, null, 2));
