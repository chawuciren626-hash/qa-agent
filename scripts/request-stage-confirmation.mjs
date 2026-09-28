import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const [runId, stage, ...artifactArgs] = process.argv.slice(2);
if (!runId || !stage) throw new Error("用法: node scripts/request-stage-confirmation.mjs <run_id> <stage> [artifact...]");
const manifestPath = resolve(root, project.run_root, runId, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`找不到运行清单: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const timestamp = new Date().toISOString();
manifest.confirmations ??= [];
manifest.stages ??= {};
manifest.orchestration ??= { events: [] };
const confirmation = {
  id: `confirm-${stage}-${Date.now()}`,
  stage,
  status: "pending",
  requested_at: timestamp,
  artifacts: artifactArgs
};
manifest.confirmations.push(confirmation);
manifest.stages[stage] = { ...(manifest.stages[stage] ?? {}), status: "awaiting_confirmation", updated_at: timestamp };
manifest.status = "awaiting_confirmation";
manifest.orchestration.resume_from = stage;
manifest.orchestration.events ??= [];
manifest.orchestration.events.push({ type: "confirmation_requested", at: timestamp, stage, confirmation_id: confirmation.id });
manifest.updated_at = timestamp;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, confirmation }, null, 2));
