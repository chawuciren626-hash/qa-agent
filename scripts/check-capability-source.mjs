/**
 * R4 能力声明单一真源（P5）。与 `check-tool-contract.mjs`（A 系列，工具台账漂移）互补：
 * A 管「登记的路径是否存在」，这里管「声明的东西是不是同一个东西」。
 *
 * 为什么必须进 CI：能力声明有四处写法——`TASK_CONTRACTS.tools`、`skills/**\/SKILL.md`、
 * `STAGE_TOOLS` 注册表、MCP 出口清单。四处各说一遍时，"管理端改了配置不生效"不会报错，
 * 只会在某次演示里变成"这个工具怎么调不动"。2026-11-19 盘出 12 条契约声明里只有 4 条
 * 能对上出口，其余 8 条在 prompt 里只是噪声——没有任何一处会红。
 *
 * 四条断言：
 *   B1 契约 → 出口：`TASK_CONTRACTS[task].tools` 每一项都必须出现在 MCP `tools/list`；
 *   B2 skill → 契约：声明了工具就必须声明 task，且 tools ⊆ 契约 tools、stage 与契约一致；
 *   B3 正文 → 声明：SKILL.md 正文提到的 tool_id 必须 ⊆ 它自己声明的 tools；
 *   B4 三类分离：每个 `##`/`###` 标题都在 frontmatter `sections` 里有归属（判据/知识/步骤），
 *      且 sections 里不许有已删除的幽灵标题。
 *
 * 第三条覆盖的是 A2（`central_tools.impl_path` 指向的文件必须存在）——不重复实现，
 * 两个脚本一起构成 §8.3 的三条 CI。
 *
 * 用法：node scripts/check-capability-source.mjs [--json]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_IDS, mcpToolName } from './central-mcp.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const problems = [];
const push = (code, message) => problems.push({ code, message });

/** 解析 Python 契约：结构简单（字面量字典），解析失败直接判错而不是跳过。 */
function readContracts() {
  const file = resolve(root, 'aitestharness-tools/aitestharness_tools/agent/tasks.py');
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('TASK_CONTRACTS: dict[str, dict] = {');
  const end = text.indexOf('\n}', start);
  if (start < 0 || end < 0) {
    push('B0', '找不到 TASK_CONTRACTS 定义：契约定形变了，本检查需要同步更新（不允许静默跳过）');
    return new Map();
  }
  const block = text.slice(start, end);
  const contracts = new Map();
  // 按顶层 `"task": {` 切块：契约里没有嵌套的同级花括号，故以行首缩进判断归属。
  const chunks = block.split(/\n    "([a-z_]+)": \{/).slice(1);
  for (let index = 0; index + 1 < chunks.length; index += 2) {
    const name = chunks[index];
    const body = chunks[index + 1];
    const stage = body.match(/"stage":\s*"([a-z_]+)"/)?.[1] ?? null;
    const toolsBlock = body.match(/"tools":\s*\(([\s\S]*?)\)/)?.[1] ?? '';
    const tools = [...toolsBlock.matchAll(/"([a-z0-9_.]+)"/g)].map(item => item[1]);
    const budget = Number(body.match(/"budget_tokens":\s*(\d+)/)?.[1] ?? 0);
    const onExceed = body.match(/"on_exceed":\s*"([a-z]+)"/)?.[1] ?? null;
    contracts.set(name, { stage, tools, budget, onExceed });
  }
  if (contracts.size === 0) push('B0', 'TASK_CONTRACTS 解析出 0 条契约：解析器与文件格式已不匹配');
  return contracts;
}

const contracts = readContracts();
const exported = new Set(TOOL_IDS);

// B1 契约 tools ⊆ MCP tools/list
for (const [task, contract] of contracts) {
  if (!contract.stage) push('B1', `契约 ${task} 没有 stage：阶段工具只在对应阶段可调，缺阶段等于没约束`);
  if (contract.tools.length === 0) push('B1', `契约 ${task} 没有声明任何工具`);
  // §6.2：成本失控与"超了随便"同源——预算不写进契约，就没有任何一处能约束单次派发。
  if (!(contract.budget > 0)) push('B1', `契约 ${task} 没有 budget_tokens：长上下文阶段（报告/归因）的单次成本将不可控`);
  if (!['degrade', 'abort'].includes(contract.onExceed)) {
    push('B1', `契约 ${task} 的 on_exceed=${contract.onExceed}：超限行为必须是 degrade（程序兜底）或 abort（中止交人），不能留空`);
  }
  for (const tool of contract.tools) {
    if (!exported.has(tool)) {
      push('B1', `契约 ${task} 声明了 ${tool}，但 MCP 出口里没有它（可用：${[...exported].join(', ')}）`);
    }
  }
}

// B2/B3/B4 skills
const skillsDir = resolve(root, 'skills');
const skillNames = readdirSync(skillsDir, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name);
const allTools = new Set([...exported]);

function readFront(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const front = match[1];
  const scalar = key => front.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim() ?? null;
  const list = key => {
    const flow = front.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm'))?.[1];
    if (flow === undefined) return null;
    return [...flow.matchAll(/"([^"]*)"/g)].map(item => item[1]);
  };
  const nested = key => {
    const line = front.match(new RegExp(`^  ${key}:\\s*\\[([^\\]]*)\\]`, 'm'))?.[1];
    if (line === undefined) return null;
    return [...line.matchAll(/"([^"]*)"/g)].map(item => item[1]);
  };
  return {scalar, list, nested, raw: front};
}

let declaredSkills = 0;
for (const name of skillNames) {
  const file = resolve(skillsDir, name, 'SKILL.md');
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const front = readFront(text);
  if (!front) { push('B2', `skills/${name}/SKILL.md 没有 frontmatter`); continue; }
  const body = text.slice(text.indexOf('\n---\n', 4) + 5);
  const task = front.scalar('task');
  const stage = front.scalar('stage');
  const tools = front.list('tools');

  if (tools && tools.length) {
    declaredSkills += 1;
    if (task === 'none') {
      // 确定性步骤（不是 LLM 派发任务）可以是"不绑定契约"的，但必须显式说出来，
      // 且工具仍要落在 MCP 出口里：`task: none` 是声明，不是逃逸口。
      if (front.scalar('deterministic') !== 'true') {
        push('B2', `skills/${name} 用 task: none 但没标 deterministic: true：不绑定契约只允许确定性编排步骤`);
      }
      for (const tool of tools) {
        if (!exported.has(tool)) push('B2', `skills/${name} 声明了 ${tool}，但 MCP 出口里没有它`);
      }
    } else if (!task) push('B2', `skills/${name} 声明了 tools 却没有 task：不知道它受哪份契约约束`);
    else if (!contracts.has(task)) push('B2', `skills/${name} 的 task=${task} 不在 TASK_CONTRACTS 里`);
    else {
      const contract = contracts.get(task);
      if (stage !== contract.stage) {
        push('B2', `skills/${name} 的 stage=${stage}，契约 ${task} 是 ${contract.stage}（阶段不一致会让工具在错误阶段被调）`);
      }
      for (const tool of tools) {
        if (!contract.tools.includes(tool)) push('B2', `skills/${name} 声明了 ${tool}，但契约 ${task} 只允许 ${contract.tools.join(', ')}`);
      }
    }
  }

  // B3 正文提到的 tool_id 必须在自己的声明里
  const mentioned = [...body.matchAll(/`([a-z]+\.[a-z0-9_]+(?:\.[a-z0-9_]+)*)`/g)]
    .map(item => item[1])
    .filter(item => allTools.has(item) || /^(requirement|testpoint|case|assets|defect|regression|report|plan|irval|knowledge)\./.test(item));
  const own = new Set(tools ?? []);
  for (const tool of new Set(mentioned)) {
    if (!allTools.has(tool)) push('B3', `skills/${name} 正文引用了不存在的工具 ${tool}`);
    else if (!own.has(tool)) push('B3', `skills/${name} 正文调用了 ${tool}，但 frontmatter tools 里没有声明`);
  }

  // B4 三类分离：标题与 sections 双向一致
  const heads = [...body.matchAll(/^#{2,3} (.+)$/gm)].map(item => item[1].trim());
  const groups = ['criteria', 'knowledge', 'steps'].map(key => [key, front.nested(key) ?? []]);
  if (groups.every(([, list]) => list.length === 0)) {
    push('B4', `skills/${name} 没有 sections 声明：判据/知识/执行步骤无法分离`);
  } else {
    const declared = new Map();
    for (const [key, list] of groups) for (const head of list) declared.set(head, key);
    for (const head of heads) if (!declared.has(head)) push('B4', `skills/${name} 的小节「${head}」没有归类（判据/知识/执行步骤）`);
    for (const head of declared.keys()) if (!heads.includes(head)) push('B4', `skills/${name} 的 sections 里有幽灵标题「${head}」`);
  }
}

const report = {
  checked: {contracts: contracts.size, exportedTools: exported.size, skills: skillNames.length, skillsWithTools: declaredSkills},
  problems,
  ok: problems.length === 0,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`契约 ${report.checked.contracts} 条 / MCP 出口 ${report.checked.exportedTools} 个 / skill ${report.checked.skills} 个（声明工具 ${report.checked.skillsWithTools} 个）`);
  if (report.ok) console.log('PASS  B1 契约⊆出口 / B2 skill⊆契约 / B3 正文⊆声明 / B4 三类分离');
  else for (const item of problems) console.log(`FAIL  [${item.code}] ${item.message}`);
}
process.exit(report.ok ? 0 : 1);
