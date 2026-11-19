/**
 * R3 契约漂移检查（P0）。
 *
 * 背景：工具台账最贵的错误不是参数写错，而是「描述指向不存在的文件」——
 * 2026-11-19 盘点时 33 个工具里 14 条 description 指着 `qa/scripts/`（全仓无此目录），
 * 是人工发现的；两天后文档里的表数量又漂了。所以这件事必须进 CI，不靠自觉。
 *
 * 四条断言（任一不过即退出码 1）：
 *   A1 登记覆盖：SEED 里每个 implemented 工具都必须在 IMPL_PATHS 里登记至少一条路径；
 *   A2 路径存在：登记路径必须真实存在于仓库；
 *   A3 描述无影子路径：description 里出现的仓库路径 token 必须是登记路径的子集；
 *   A4 无历史漂移：文件里不得再出现 `qa/scripts/`（真实目录是 `scripts/`）。
 *
 * 用法：node scripts/check-tool-contract.mjs [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = "platform/packages/server/src/http/central-tools.ts";
const text = readFileSync(resolve(root, target), "utf8");

const problems = [];
const push = (code, message) => problems.push({ code, message });

/** 取 IMPL_PATHS 字面量块。解析 TS 而非 import，是因为该文件依赖服务端运行时。 */
function implRegistry() {
  const start = text.indexOf("const IMPL_PATHS: Record<string, string[]>");
  if (start < 0) throw new Error("找不到 IMPL_PATHS 定义（R3 尚未接入？）");
  const end = text.indexOf("\n};", start);
  if (end < 0) throw new Error("IMPL_PATHS 定义未闭合");
  const block = text.slice(start, end);
  const registry = new Map();
  for (const line of block.split("\n")) {
    const match = line.match(/^\s*"([a-z0-9_.]+)":\s*\[(.*)\],?\s*$/);
    if (!match) continue;
    const paths = [...match[2].matchAll(/"([^"]+)"/g)].map(item => item[1]);
    registry.set(match[1], paths);
  }
  return registry;
}

/** 取 SEED 条目：name + implemented（同一对象内两个字段，用对象边界切分）。 */
function seedTools() {
  const start = text.indexOf("const SEED: Seed[] = [");
  const end = text.indexOf("\n];", start);
  if (start < 0 || end < 0) throw new Error("找不到 SEED 定义");
  const block = text.slice(start, end);
  const tools = [];
  const re = /name: "([a-z0-9_.]+)"[\s\S]*?implemented: (true|false)/g;
  for (const match of block.matchAll(re)) tools.push({ name: match[1], implemented: match[2] === "true" });
  return tools;
}

const registry = implRegistry();
const seeds = seedTools();

// A1 登记覆盖
for (const tool of seeds) {
  const paths = registry.get(tool.name);
  if (!paths || paths.length === 0) {
    if (tool.implemented) push("A1", `工具 ${tool.name} 已落地（implemented:true）但未在 IMPL_PATHS 登记实现路径`);
    continue;
  }
}
for (const name of registry.keys()) {
  if (!seeds.some(item => item.name === name)) push("A1", `IMPL_PATHS 里有未知工具 ${name}（SEED 中不存在，多为改名后漏改）`);
}

// A2 路径存在
for (const [name, paths] of registry) {
  for (const path of paths) {
    if (!existsSync(resolve(root, path))) push("A2", `工具 ${name} 登记的实现路径不存在：${path}`);
  }
}

// A3 描述里不得出现未登记的仓库路径
const pathToken = /(?:^|[\s(（])((?:scripts|config|aitestharness-tools|platform)\/[A-Za-z0-9_./-]+\.(?:py|mjs|ts|json))/g;
const seedBlock = text.slice(text.indexOf("const SEED: Seed[] = ["), text.indexOf("\n];", text.indexOf("const SEED: Seed[] = [")));
for (const line of seedBlock.split("\n")) {
  const nameMatch = line.match(/name: "([a-z0-9_.]+)"/);
  const name = nameMatch ? nameMatch[1] : null;
  for (const match of line.matchAll(pathToken)) {
    const token = match[1];
    if (!name) continue;
    const registered = registry.get(name) ?? [];
    // 只查 .py/.mjs 的实现文件；配置与输出产物（config/*.json、selection/*.json）不算实现路径。
    if (!/\.(py|mjs)$/.test(token)) continue;
    if (!registered.some(path => path.endsWith(token) || token.endsWith(path))) {
      push("A3", `工具 ${name} 的描述引用了未登记的实现路径 ${token}（登记：${registered.join(", ") || "无"}）`);
    }
  }
}

// A4 历史漂移
if (text.includes("qa/scripts/")) push("A4", "仍存在 qa/scripts/ 引用：真实目录是 scripts/（2026-11-19 的 14 条漂移）");

const report = {
  checked: { tools: seeds.length, implemented: seeds.filter(item => item.implemented).length, registry: registry.size },
  problems,
  ok: problems.length === 0,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`检查对象：${target}`);
  console.log(`工具 ${report.checked.tools} 个（已落地 ${report.checked.implemented}），登记 ${report.checked.registry} 条`);
  if (report.ok) console.log("PASS  A1 登记覆盖 / A2 路径存在 / A3 描述无影子路径 / A4 无历史漂移");
  else for (const item of problems) console.log(`FAIL  [${item.code}] ${item.message}`);
}
process.exit(report.ok ? 0 : 1);
