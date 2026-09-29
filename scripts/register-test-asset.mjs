import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { catalogPath, readCatalog, validateCatalog } from "./test-asset-catalog.mjs";

const root = resolve(import.meta.dirname, "..");
const candidateFile = process.argv.find((arg) => arg.startsWith("--candidate="))?.slice(12);
const apply = process.argv.includes("--apply");
if (!candidateFile) throw new Error("用法: node scripts/register-test-asset.mjs --candidate=<asset.json> [--apply]");
const candidatePath = resolve(root, candidateFile);
if (!existsSync(candidatePath)) throw new Error(`找不到候选资产文件: ${candidatePath}`);
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
const candidateErrors = validateCatalog({ catalog_version: 2, assets: [candidate] });
if (candidateErrors.length) throw new Error(candidateErrors.join("\n"));
if (candidate.status !== "verified") throw new Error("只能登记已人工验证的 verified 资产。");
const target = catalogPath(root);
const catalog = readCatalog(target);
if (catalog.assets.some((asset) => asset.id === candidate.id)) throw new Error(`资产已存在: ${candidate.id}`);
if (!apply) {
  console.log(JSON.stringify({ status: "dry_run", candidate: candidate.id, target }, null, 2));
  process.exit();
}
catalog.assets.push(candidate);
const errors = validateCatalog(catalog);
if (errors.length) throw new Error(errors.join("\n"));
writeFileSync(target, JSON.stringify(catalog, null, 2) + "\n");
console.log(JSON.stringify({ status: "registered", asset: candidate.id, target }, null, 2));
