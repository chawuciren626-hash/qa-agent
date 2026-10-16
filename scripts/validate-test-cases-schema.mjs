import fs from "node:fs/promises";
import { resolve } from "node:path";

const cases = JSON.parse(await fs.readFile(resolve("output/runs/run-acceptance-independent-20261007/design/test_cases.json"), "utf8"));
const schema = JSON.parse(await fs.readFile(resolve("schemas/test_case.schema.json"), "utf8"));

const required = schema.required;
const props = schema.properties;
const enumChecks = {};

for (const [key, val] of Object.entries(props)) {
  if (val.enum) enumChecks[key] = val.enum;
}

const errors = [];
const seenIds = new Set();

for (const c of cases) {
  const id = c.case_id;
  if (seenIds.has(id)) errors.push(`${id}: duplicate case_id`);
  seenIds.add(id);

  for (const r of required) {
    if (!(r in c)) errors.push(`${id}: missing required field ${r}`);
  }

  for (const [key, en] of Object.entries(enumChecks)) {
    if (key in c && !en.includes(c[key])) errors.push(`${id}: ${key}=${c[key]} not in ${JSON.stringify(en)}`);
  }

  if ("preconditions" in c && !Array.isArray(c.preconditions)) errors.push(`${id}: preconditions not array`);
  if ("steps" in c && !Array.isArray(c.steps)) errors.push(`${id}: steps not array`);
  if ("test_data" in c && typeof c.test_data !== "object") errors.push(`${id}: test_data not object`);
  if ("execution_metadata" in c && typeof c.execution_metadata !== "object") errors.push(`${id}: execution_metadata not object`);
  if ("execution_contract" in c && typeof c.execution_contract !== "object") errors.push(`${id}: execution_contract not object`);
  if ("asset_refs" in c && !Array.isArray(c.asset_refs)) errors.push(`${id}: asset_refs not array`);

  if ("automation_feasible" in c && typeof c.automation_feasible !== "boolean") errors.push(`${id}: automation_feasible not boolean`);
  if ("execution_metadata" in c && c.execution_metadata) {
    if ("estimated_duration_ms" in c.execution_metadata && typeof c.execution_metadata.estimated_duration_ms !== "number") {
      errors.push(`${id}: estimated_duration_ms not number`);
    }
    if ("modules" in c.execution_metadata && !Array.isArray(c.execution_metadata.modules)) {
      errors.push(`${id}: modules not array`);
    }
  }
  if ("execution_contract" in c && c.execution_contract) {
    if ("data_isolation" in c.execution_contract && !["read_only", "isolated", "shared"].includes(c.execution_contract.data_isolation)) {
      errors.push(`${id}: data_isolation invalid`);
    }
    if ("cleanup_required" in c.execution_contract && typeof c.execution_contract.cleanup_required !== "boolean") {
      errors.push(`${id}: cleanup_required not boolean`);
    }
  }
}

if (errors.length) {
  console.error("Validation failed:");
  for (const e of errors) console.error(" ", e);
  process.exit(1);
} else {
  console.log(`Schema-like validation passed for ${cases.length} cases.`);
}
