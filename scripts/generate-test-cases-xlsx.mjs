import fs from "node:fs/promises";
import { resolve } from "node:path";
import xlsx from "xlsx";
import { extractCases } from './execution-plan.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("用法: node scripts/generate-test-cases-xlsx.mjs <test_cases.json> <test_cases.xlsx>");

const cases = extractCases(JSON.parse(await fs.readFile(resolve(input), "utf8")));

const headers = ["用例 ID", "用例标题", "优先级", "类型", "前置条件", "测试数据", "测试步骤", "预期结果", "可自动化", "关联测试点"];
const rows = cases.map((item) => [
  item.case_id ?? "",
  item.title ?? "",
  item.priority ?? "",
  item.type ?? "",
  (item.preconditions ?? []).join("\n"),
  JSON.stringify(item.test_data ?? {}),
  (item.steps ?? []).map((step, index) => `${index + 1}. ${step}`).join("\n"),
  item.expected ?? "",
  item.automation_feasible ? "是" : "否",
  item.related_test_point ?? "",
]);

const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);

// 设置列宽
worksheet["!cols"] = [
  { wch: 15 }, { wch: 28 }, { wch: 10 }, { wch: 14 }, { wch: 30 },
  { wch: 30 }, { wch: 44 }, { wch: 44 }, { wch: 12 }, { wch: 18 },
];

const workbook = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(workbook, worksheet, "测试用例");

await fs.mkdir(resolve(output, ".."), { recursive: true });
xlsx.writeFile(workbook, resolve(output));
console.log(`已生成 Excel 用例文件: ${resolve(output)}`);
