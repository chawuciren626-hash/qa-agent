import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertStageReady, getRunContext } from "./orchestration-state.mjs";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const [runId, stage] = process.argv.slice(2);

if (!runId || !stage) {
  throw new Error("用法: node scripts/assert-stage-ready.mjs <run_id> <stage>");
}

const { manifest } = getRunContext(root, project, runId);
const stagePlan = assertStageReady(manifest, stage);

console.log(JSON.stringify({ run_id: runId, stage, agent: stagePlan.agent, status: "ready" }));
