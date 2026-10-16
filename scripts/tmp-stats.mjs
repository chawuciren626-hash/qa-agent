import XLSX from 'xlsx';

const filePath = 'E:/Codex/测试智能体/output/runs/run-2026-09-29-test-management/design/test_cases.xlsx';
const workbook = XLSX.readFile(filePath);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

const priorityCounts = {};
const typeCounts = {};
data.forEach(row => {
  const p = row['优先级'] || 'Unknown';
  const t = row['类型'] || 'Unknown';
  priorityCounts[p] = (priorityCounts[p] || 0) + 1;
  typeCounts[t] = (typeCounts[t] || 0) + 1;
});

console.log('Priority counts:', JSON.stringify(priorityCounts, null, 2));
console.log('Type counts:', JSON.stringify(typeCounts, null, 2));
