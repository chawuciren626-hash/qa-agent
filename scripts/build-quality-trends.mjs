import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const limit = Math.max(1, Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 20));
const runsDir = resolve(root, "output/runs");
const points = [];
for (const entry of existsSync(runsDir) ? readdirSync(runsDir, { withFileTypes: true }) : []) {
  if (!entry.isDirectory()) continue;
  if (existsSync(resolve(runsDir, entry.name, 'inputs/fixture-origin.json')) || existsSync(resolve(runsDir, entry.name, 'inputs/acceptance.json'))) continue;
  const path = resolve(runsDir, entry.name, "report/quality-metrics.json");
  if (!existsSync(path)) continue;
  const metrics = JSON.parse(readFileSync(path, "utf8"));
  points.push({ run_id: metrics.run_id, generated_at: metrics.generated_at, pass_rate: metrics.execution?.pass_rate, failed: metrics.execution?.failed, gate_status: metrics.quality_gate?.status, defects: metrics.defects?.total ?? 0 });
}
points.sort((a, b) => String(a.generated_at).localeCompare(String(b.generated_at)));
const output = { generated_at: new Date().toISOString(), runs: points.slice(-limit), summary: { total_runs: points.length } };
const targetDir = resolve(root, "output/quality");
mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, "quality-trends.json");
writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ total_runs: points.length, output: target }, null, 2));
