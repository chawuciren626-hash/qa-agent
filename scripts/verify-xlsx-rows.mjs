import xlsx from "xlsx";
import { resolve } from "node:path";

const wb = xlsx.readFile(resolve("output/runs/run-acceptance-independent-20261007/design/test_cases.xlsx"));
const ws = wb.Sheets["测试用例"];
const data = xlsx.utils.sheet_to_json(ws, { header: 1 });
const rows = data.length - 1; // subtract header
console.log(`Excel rows: ${rows}`);
if (rows !== 24) {
  console.error("Row count mismatch: expected 24");
  process.exit(1);
}
