import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve, extname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Workbook, Topic, Zipper } = require("xmind");

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("用法: node scripts/generate-test-points-xmind.mjs <test_points.md> <test_points.xmind>");

const source = readFileSync(resolve(input), "utf8");
const branches = [];
const modules = new Map();
const ids = new Set();
function addPoint(id, moduleName, scenario, description) {
  if (![id, moduleName, scenario, description].every(value => typeof value === 'string' && value.trim()) || ids.has(id)) throw new Error(`测试点字段缺失或编号重复: ${id}`);
  ids.add(id);
  if (!modules.has(moduleName)) {
    const branch = { title: moduleName, children: [], scenarios: new Map() };
    modules.set(moduleName, branch);
    branches.push(branch);
  }
  const branch = modules.get(moduleName);
  if (!branch.scenarios.has(scenario)) {
    const child = { title: scenario, children: [] };
    branch.scenarios.set(scenario, child);
    branch.children.push(child);
  }
  branch.scenarios.get(scenario).children.push({ title: description.replace(/^TP-[\w-]+\s*[:：、.\-]?\s*/, '') });
}
let rootTitle;
if (extname(input).toLowerCase() === '.json') {
  const data = JSON.parse(source);
  const points = Array.isArray(data) ? data : data.points ?? data.test_points;
  if (!Array.isArray(points)) throw new Error('Expected test point array or points/test_points envelope');
  for (const point of points) addPoint(point.id, point.module, point.feature, point.description);
  rootTitle = data.title || '测试点';
} else {
  let headers;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) headers = undefined;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim().replace(/\\\|/g, '|'));
    if (cells.includes('模块') && (cells.includes('描述') || cells.includes('测试点'))) { headers = cells; continue; }
    if (!/^TP-/.test(cells[0] ?? '')) continue;
    if (!headers || cells.length !== headers.length) throw new Error(`测试点表格格式错误: ${cells[0]}`);
    const row = Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
    addPoint(cells[0], row['模块'], row['场景'] || row['功能'] || row['功能（或场景）'], row['描述'] || row['测试点']);
  }
  rootTitle = source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s*测试点(?:设计)?\s*$/, '').trim() || '测试点';
}
if (!ids.size) throw new Error('没有可导出的测试点，拒绝生成空脑图。');

const target = resolve(output);
mkdirSync(dirname(target), { recursive: true });
const workbook = new Workbook();
const sheet = workbook.createSheet("测试点", rootTitle);
const topics = new Topic({ sheet });
function append(nodes, parentId) {
  for (const node of nodes) {
    topics.on(parentId).add({ title: node.title });
    const nodeId = topics.cid();
    if (node.children?.length) append(node.children, nodeId);
  }
}
append(branches, topics.cid());
const validation = workbook.validate();
if (!validation.status) throw new Error(`XMind 数据校验失败: ${JSON.stringify(validation.errors)}`);
const zipper = new Zipper({ path: dirname(target), workbook, filename: basename(target, ".xmind") });
if (!await zipper.save()) throw new Error("XMind 文件写入失败。");
console.log(`已使用官方 XMind SDK 生成: ${target}`);
