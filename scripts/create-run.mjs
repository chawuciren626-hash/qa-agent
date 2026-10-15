import { dataPath, directoryContext, assertRunContext } from './directory-context.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9)
  ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (!/^run-[A-Za-z0-9-]+$/.test(runId)) throw new Error("run_id 格式无效。");

const runDir = dataPath(root, project.run_root, runId);
const folders = ["inputs", "analysis", "design", "execution/playwright", "defects", "report"];
for (const folder of folders) mkdirSync(resolve(runDir, folder), { recursive: true });

const manifestPath = resolve(runDir, "manifest.json");
if(existsSync(manifestPath)) assertRunContext(root,JSON.parse(readFileSync(manifestPath,'utf8')));
if (!existsSync(manifestPath)) {
  writeFileSync(manifestPath, JSON.stringify({
    manifest_version: 3,
    directory_context: directoryContext(root),
    run_id: runId,
    created_at: new Date().toISOString(),
    status: "created",
    selected_agents: [],
    selected_skills: [],
    asset_refs: [],
    stages: {},
    artifacts: [],
    orchestration: {
      events: [],
      resume_from: null,
      plan: null
    }
  }, null, 2) + "\n");
}
console.log(JSON.stringify({ run_id: runId, run_dir: runDir, manifest: manifestPath }));
