import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const [runId, stage, status, ...artifactArgs] = process.argv.slice(2);
if (!runId || !stage || !status) throw new Error("用法: node scripts/update-run-manifest.mjs <run_id> <stage> <status> [relativeArtifact...]");
const manifestPath = resolve(root, project.run_root, runId, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`找不到运行清单: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.updated_at = new Date().toISOString();
manifest.status = status === "failed" ? "failed" : manifest.status;
if (status === "validation") manifest.status = "validation";
manifest.stages[stage] = { status, updated_at: manifest.updated_at };
for (const path of artifactArgs) if (!manifest.artifacts.includes(path)) manifest.artifacts.push(path);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`已更新 ${runId} 的 ${stage} 阶段。`);
