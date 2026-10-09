import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertStageReady, getRunContext } from "./orchestration-state.mjs";
import { assertExecutionAuthorized } from './execution-authorization.mjs';
import { assertDependencyArtifacts } from './artifact-contracts.mjs';

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const [runId, stage, mode] = process.argv.slice(2);

if (!runId || !stage) {
  throw new Error("用法: node scripts/assert-stage-ready.mjs <run_id> <stage>");
}

const { manifest } = getRunContext(root, project, runId);
if (mode && (mode !== '--mode=prepare' || stage !== 'execution')) throw new Error('Only execution preparation mode is supported');
const readiness = structuredClone(manifest);
if (mode) readiness.orchestration.plan.stages.find(s => s.id === 'execution').confirmation = 'none';
const stagePlan = assertStageReady(readiness, stage);
assertDependencyArtifacts(root, runId, manifest, stage);
if (stage === 'execution' && !mode) assertExecutionAuthorized(root, runId);

console.log(JSON.stringify({ run_id: runId, stage, agent: stagePlan.agent, status: "ready" }));
