import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const runId = process.argv[2];
if (!runId) throw new Error("用法: node scripts/publish-latest.mjs <run_id>");
const manifestPath = resolve(root, project.run_root, runId, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
writeFileSync(resolve(root, project.latest_index), JSON.stringify({
  run_id: runId,
  published_at: new Date().toISOString(),
  manifest: `runs/${runId}/manifest.json`,
  artifacts: manifest.artifacts
}, null, 2) + "\n");
console.log(`已发布最新运行索引: ${runId}`);
