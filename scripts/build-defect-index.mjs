import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runsDir = resolve(root, "output/runs");
const index = new Map();
for (const entry of existsSync(runsDir) ? readdirSync(runsDir, { withFileTypes: true }) : []) {
  if (!entry.isDirectory()) continue;
  if (existsSync(resolve(runsDir, entry.name, 'inputs/fixture-origin.json')) || existsSync(resolve(runsDir, entry.name, 'inputs/acceptance.json'))) continue;
  const path = resolve(runsDir, entry.name, "defects/defect-records.json");
  if (!existsSync(path)) continue;
  const data = JSON.parse(readFileSync(path, "utf8"));
  for (const record of data.records ?? []) {
    const item = index.get(record.fingerprint) ?? { fingerprint: record.fingerprint, canonical_defect_id: record.defect_id, title: record.title, category: record.category, occurrences: [] };
    item.occurrences.push({ run_id: data.run_id, defect_id: record.defect_id, lifecycle_status: record.lifecycle_status, confidence: record.confidence, related_cases: record.related_cases });
    index.set(record.fingerprint, item);
  }
}
const defects = [...index.values()].map((item) => ({ ...item, occurrence_count: item.occurrences.length }));
const output = { generated_at: new Date().toISOString(), unique_defects: defects.length, repeated_defects: defects.filter((item) => item.occurrence_count > 1).length, defects };
const targetDir = resolve(root, "output/quality");
mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, "defect-index.json");
writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ unique_defects: output.unique_defects, repeated_defects: output.repeated_defects, output: target }, null, 2));
