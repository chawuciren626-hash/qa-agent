import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { catalogPath, readCatalog } from "./test-asset-catalog.mjs";
import { getRunContext, withRunLock, writeJson } from "./orchestration-state.mjs";

const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "config/project.json"), "utf8"));
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
const ids = process.argv.find((arg) => arg.startsWith("--assets="))?.slice(9)?.split(",").filter(Boolean) ?? [];
if (!runId || !ids.length) throw new Error("用法: node scripts/record-run-assets.mjs --run-id=<run_id> --assets=<asset_id,asset_id>");
const catalog = readCatalog(catalogPath(root));
withRunLock(root, project, runId, () => {
const { manifestPath, manifest } = getRunContext(root, project, runId);
manifest.asset_refs ??= [];
for (const id of ids) {
  const asset = catalog.assets.find((item) => item.id === id);
  if (!asset) throw new Error(`未找到测试资产: ${id}`);
  if (asset.status !== "verified") throw new Error(`只能在正式运行中引用 verified 资产: ${id}`);
  if (!manifest.asset_refs.some((reference) => reference.id === id && reference.version === asset.version)) {
    manifest.asset_refs.push({ id, version: asset.version, kind: asset.kind, recorded_at: new Date().toISOString() });
  }
}
manifest.updated_at = new Date().toISOString();
writeJson(manifestPath, manifest);
console.log(JSON.stringify({ run_id: runId, asset_refs: manifest.asset_refs }, null, 2));
});
