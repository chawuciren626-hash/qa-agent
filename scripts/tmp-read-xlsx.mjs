import XLSX from 'xlsx';

const filePath = 'E:/Codex/测试智能体/output/runs/run-2026-09-29-test-management/design/test_cases.xlsx';
const workbook = XLSX.readFile(filePath);
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];

// Use sheet_to_json with defval to preserve structure
const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: '' });

console.log(`Sheet: ${sheetName}`);
console.log(`Total cases: ${jsonData.length}`);
console.log(`Columns: ${Object.keys(jsonData[0] || {}).join(', ')}`);
console.log('\n--- First 3 cases ---');
jsonData.slice(0, 3).forEach((row, i) => {
  console.log(JSON.stringify(row, null, 2));
});

console.log('\n--- Last 2 cases ---');
jsonData.slice(-2).forEach((row, i) => {
  console.log(JSON.stringify(row, null, 2));
});

const typeCounts = {};
const autoCounts = { true: 0, false: 0 };
jsonData.forEach(row => {
  const t = row['类型'] || row['type'] || 'Unknown';
  typeCounts[t] = (typeCounts[t] || 0) + 1;
  const a = row['可自动化'] || row['automation_feasible'];
  if (String(a).toLowerCase() === 'true' || a === '是') autoCounts.true++;
  else autoCounts.false++;
});

console.log('\n--- Case counts by type ---');
Object.entries(typeCounts).forEach(([k, v]) => console.log(`${k}: ${v}`));
console.log('\n--- Automation feasibility ---');
console.log(`Automatable: ${autoCounts.true}`);
console.log(`Not automatable: ${autoCounts.false}`);

console.log('\n--- All case IDs, titles, priorities, types ---');
jsonData.forEach(row => {
  const id = row['用例 ID'] || row['case_id'] || '';
  const title = row['用例标题'] || row['title'] || '';
  const priority = row['优先级'] || row['priority'] || '';
  const type = row['类型'] || row['type'] || '';
  const auto = row['可自动化'] || row['automation_feasible'] || '';
  console.log(`${id}\t${priority}\t${type}\t${auto}\t${title}`);
});
