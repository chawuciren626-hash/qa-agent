import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from 'node:crypto';
import { getRunContext, selectedPlanStages } from "./orchestration-state.mjs";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const runId = process.argv[2];
if (!runId) throw new Error("用法: node scripts/get-run-resume-point.mjs <run_id>");
const { manifest, manifestPath } = getRunContext(root, project, runId);
const stages = selectedPlanStages(manifest);
const resumeFrom = stages.find((stage) => !["completed", "skipped"].includes(manifest.stages?.[stage.id]?.status))?.id ?? "completed";
const digest = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
const dispatch = manifest.orchestration?.events?.filter(event => event.stage === resumeFrom && event.type === 'dispatched').at(-1);
console.log(JSON.stringify({ run_id: runId, status: manifest.status, resume_from: resumeFrom, manifest_sha256: digest, recovery_requires: ['blocked', 'failed'].includes(manifest.stages?.[resumeFrom]?.status) ? (dispatch?.dispatch_id ? 'explicit_review_and_recover_stage' : 'legacy_dispatch_create_new_run') : null, stages: manifest.stages ?? {} }, null, 2));
