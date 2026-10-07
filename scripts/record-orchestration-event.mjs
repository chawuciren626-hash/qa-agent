import { readFileSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { assertStageReady, getRunContext, recomputeRunStatus, writeJson } from "./orchestration-state.mjs";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const [runId, eventType, ...args] = process.argv.slice(2);
if (!runId || !eventType) throw new Error("用法: node scripts/record-orchestration-event.mjs <run_id> <event_type> [--key=value...]");
const options = Object.fromEntries(args.filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
  const [key, value] = arg.slice(2).split(/=(.*)/s);
  return [key, value];
}));
const allowedEvents = new Set(['dispatched', 'completed', 'failed', 'blocked']);
if (!allowedEvents.has(eventType)) throw new Error('Unsupported stage event; use confirmation scripts for approval and revision.');
if (!options.stage) throw new Error('Stage is required.');
const allowedOptions = new Set(['stage', 'agent', 'skills', 'artifacts', 'reason']);
for (const key of Object.keys(options)) {
  if (!allowedOptions.has(key)) throw new Error(`Unsupported event option: ${key}`);
}
const { manifestPath, manifest } = getRunContext(root, project, runId);
for (const artifact of (options.artifacts ?? '').split(',').filter(Boolean)) {
  const runDir = dirname(manifestPath);
  const target = resolve(runDir, artifact);
  const rel = relative(runDir, target);
  if (isAbsolute(artifact) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`Artifact must be a run-relative file: ${artifact}`);
  }
  if (!statSync(target).isFile()) throw new Error(`Artifact is not a file: ${artifact}`);
}
manifest.manifest_version ??= 3;
manifest.orchestration ??= { events: [], resume_from: null, plan: null };
manifest.orchestration.events ??= [];
manifest.stages ??= {};
manifest.selected_agents ??= [];
manifest.selected_skills ??= [];
const timestamp = new Date().toISOString();
const inferredStatus = {
  dispatched: "in_progress",
  completed: "completed",
  failed: "failed",
  blocked: "blocked"
}[eventType];

if (eventType === "dispatched" && options.stage) {
  const plannedStage = assertStageReady(manifest, options.stage);
  if (options.agent !== plannedStage.agent) {
    throw new Error(`阶段 ${options.stage} 必须派发给 ${plannedStage.agent}，实际为 ${options.agent ?? "未指定"}。`);
  }
  const actualSkills = (options.skills ?? "").split(",").filter(Boolean).sort();
  const plannedSkills = [...plannedStage.skills].sort();
  if (actualSkills.join(",") !== plannedSkills.join(",")) {
    throw new Error(`阶段 ${options.stage} 必须使用 Skill: ${plannedSkills.join(",")}。`);
  }
}
if (["completed", "failed", "blocked"].includes(eventType) && options.stage) {
  const current = manifest.stages[options.stage]?.status;
  if (current !== "in_progress") throw new Error(`阶段 ${options.stage} 当前状态为 ${current ?? "未计划"}，不能记录 ${eventType}。`);
}
const event = { type: eventType, at: timestamp, ...options };
manifest.orchestration.events.push(event);
if (options.agent && !manifest.selected_agents.includes(options.agent)) manifest.selected_agents.push(options.agent);
for (const skill of (options.skills ?? "").split(",").filter(Boolean)) if (!manifest.selected_skills.includes(skill)) manifest.selected_skills.push(skill);
for (const artifact of (options.artifacts ?? "").split(",").filter(Boolean)) {
  if (!manifest.artifacts.includes(artifact)) manifest.artifacts.push(artifact);
}
if (options.stage) {
  const stage = manifest.stages[options.stage] ?? {};
  stage.status = inferredStatus;
  stage.updated_at = timestamp;
  if (options.agent) stage.agent = options.agent;
  if (options.reason) stage.reason = options.reason;
  manifest.stages[options.stage] = stage;
  if (["failed", "blocked", "awaiting_confirmation"].includes(stage.status)) manifest.orchestration.resume_from = options.stage;
  if (stage.status === "completed") manifest.orchestration.resume_from = "next_stage";
}
manifest.status = recomputeRunStatus(manifest);
manifest.updated_at = timestamp;
writeJson(manifestPath, manifest);
console.log(JSON.stringify({ run_id: runId, event, manifest: manifestPath }));
