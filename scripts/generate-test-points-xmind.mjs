import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Workbook, Topic, Zipper } = require("xmind");

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("用法: node scripts/generate-test-points-xmind.mjs <test_points.md> <test_points.xmind>");

const markdown = readFileSync(resolve(input), "utf8");
const sections = [];
let current;
for (const line of markdown.split(/\r?\n/)) {
  const heading = line.match(/^##+\s+(?:[一二三四五六七八九十]+、)?(.+)/);
  if (heading) { current = { title: heading[1].trim(), cases: [] }; sections.push(current); continue; }
  if (!line.startsWith("| TP-")) continue;
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 7) continue;
  const [id, moduleName, feature, description, risk, coverage] = cells;
  if (!current) { current = { title: "测试点", cases: [] }; sections.push(current); }
  current.cases.push({ id, moduleName, feature, description, risk, coverage });
}

const rootTitle = markdown.match(/^#\s+(.+?)测试点设计/)?.[1]?.trim() || "测试点";
const normal = sections.find((section) => /正常|主流程/.test(section.title));
const exception = sections.find((section) => /异常/.test(section.title));
const boundary = sections.find((section) => /边界/.test(section.title));
const security = sections.find((section) => /安全/.test(section.title));
const performance = sections.find((section) => /性能/.test(section.title));
const compatibility = sections.find((section) => /兼容|体验/.test(section.title));

const leaf = (item) => ({ title: item.feature });
const branches = [];
const loginChildren = [];
if (normal?.cases.length) loginChildren.push({ title: "登录成功", children: normal.cases.map(leaf) });
if (exception?.cases.length) loginChildren.push({ title: "登录失败与校验", children: exception.cases.map(leaf) });
if (loginChildren.length) branches.push({ title: "登录", children: loginChildren });
if (boundary?.cases.length) branches.push({ title: "输入与次数边界", children: boundary.cases.map(leaf) });
if (security?.cases.length) branches.push({ title: "安全与会话", children: security.cases.map(leaf) });
if (performance?.cases.length) branches.push({ title: "性能", children: performance.cases.map(leaf) });
if (compatibility?.cases.length) branches.push({ title: "兼容性与体验", children: compatibility.cases.map(leaf) });

for (const section of sections) {
  if (![normal, exception, boundary, security, performance, compatibility].includes(section) && section.cases.length) {
    branches.push({ title: section.title, children: section.cases.map(leaf) });
  }
}

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
