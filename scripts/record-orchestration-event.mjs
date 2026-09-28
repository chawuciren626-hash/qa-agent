import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const [runId, eventType, ...args] = process.argv.slice(2);
if (!runId || !eventType) throw new Error("用法: node scripts/record-orchestration-event.mjs <run_id> <event_type> [--key=value...]");
const options = Object.fromEntries(args.filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
  const [key, value] = arg.slice(2).split(/=(.*)/s);
  return [key, value];
}));
const manifestPath = resolve(root, project.run_root, runId, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`找不到运行清单: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.manifest_version ??= 2;
manifest.orchestration ??= { events: [], resume_from: "analysis" };
manifest.orchestration.events ??= [];
manifest.stages ??= {};
manifest.selected_agents ??= [];
manifest.selected_skills ??= [];
const timestamp = new Date().toISOString();
const event = { type: eventType, at: timestamp, ...options };
manifest.orchestration.events.push(event);
if (options.agent && !manifest.selected_agents.includes(options.agent)) manifest.selected_agents.push(options.agent);
for (const skill of (options.skills ?? "").split(",").filter(Boolean)) if (!manifest.selected_skills.includes(skill)) manifest.selected_skills.push(skill);
if (options.stage) {
  const stage = manifest.stages[options.stage] ?? {};
  stage.status = options.status ?? stage.status ?? "in_progress";
  stage.updated_at = timestamp;
  if (options.agent) stage.agent = options.agent;
  if (options.reason) stage.reason = options.reason;
  manifest.stages[options.stage] = stage;
  if (["failed", "blocked", "awaiting_confirmation"].includes(stage.status)) manifest.orchestration.resume_from = options.stage;
  if (stage.status === "completed") manifest.orchestration.resume_from = "next_stage";
}
if (options.status === "failed") manifest.status = "failed";
else if (options.status === "blocked") manifest.status = "blocked";
else if (manifest.status === "created") manifest.status = "in_progress";
manifest.updated_at = timestamp;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ run_id: runId, event, manifest: manifestPath }));
