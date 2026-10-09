import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertArtifactContract } from './artifact-contracts.mjs';
import { runDirectory } from './design-quality.mjs';

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const runId = process.argv[2];
if (!runId) throw new Error("用法: node scripts/publish-latest.mjs <run_id>");
runDirectory(root, runId);
const manifestPath = resolve(root, project.run_root, runId, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const reportCurrent = manifest.stages?.report?.status === 'completed';
if (reportCurrent) assertArtifactContract(root, runId, 'report');
writeFileSync(resolve(root, project.latest_index), JSON.stringify({
  run_id: runId,
  published_at: new Date().toISOString(),
  manifest: `runs/${runId}/manifest.json`,
  status: manifest.status,
  report_current: reportCurrent,
  artifacts: (manifest.artifacts ?? []).filter(path => reportCurrent || !path.startsWith('report/')),
  historical_report_artifacts: reportCurrent ? [] : (manifest.artifacts ?? []).filter(path => path.startsWith('report/'))
}, null, 2) + "\n");
console.log(`已发布最新运行索引: ${runId}`);
