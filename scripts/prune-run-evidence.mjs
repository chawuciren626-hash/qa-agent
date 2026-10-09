import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runId = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9);
const apply = process.argv.includes("--apply");
if (!runId) throw new Error("用法: node scripts/prune-run-evidence.mjs --run-id=<run_id> [--apply]");
if (apply && existsSync(resolve(root, 'output/runs', runId, 'execution/attempts'))) throw new Error('Attempt archives exist; automatic evidence pruning is disabled to preserve historical references.');

// Historical runs created before the single-root convention may contain a copied
// top-level playwright directory. The canonical location is execution/playwright.
const duplicate = resolve(root, "output/runs", runId, "playwright");
if (!existsSync(duplicate)) {
  console.log(JSON.stringify({ run_id: runId, status: "nothing_to_prune" }));
} else if (!apply) {
  console.log(JSON.stringify({ run_id: runId, status: "dry_run", duplicate_directory: duplicate }));
} else {
  rmSync(duplicate, { recursive: true, force: true });
  console.log(JSON.stringify({ run_id: runId, status: "pruned", removed: duplicate }));
}
