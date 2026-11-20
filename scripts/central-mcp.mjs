/**
 * M1 能力出口：把确定性阶段工具暴露成 MCP 工具，让 agent 真的「看得到、调得着」。
 *
 * 在这之前，能力声明有三种写法、三种落点：
 *   - `central_tools` 台账里 33 条（管理端能看见、能启停，但 agent 调不到）；
 *   - `TASK_CONTRACTS.tools` 里写着 `requirement.testability.check_testability` 这种
 *     **函数名**（不是任何入口认识的名字）；
 *   - agent 真正能用的只有 `run_stage_tool` 的 10 个 tool_id。
 * 三者靠人记着对齐，于是「管理端改了配置不生效」成了常态。这个进程把出口补上：
 * 工具列表来自运行期注册表（不是手抄一份），调用走 `run_stage_tool` 那条路（不是另开
 * 一条），启停状态在这一层就过滤掉（不是列出来再拒），所以「列出来的就是能调的」。
 *
 * 为什么是 stdio 而不是新起一个 HTTP 服务：
 *   服务端的 agent 已经跑在自己的进程里，MCP 客户端（penguin-core 的 McpToolProvider）
 *   本来就支持 stdio。多开一个端口等于多一份部署、鉴权与生命周期；而这里的工具全是
 *   **本机确定性脚本**，没有跨机访问的需求。一个被父进程拉起的子进程就是正确形态。
 *
 * 为什么手写协议而不引 `@modelcontextprotocol/server`：
 *   该包目前只出现在 core 的 devDependencies（`platform/packages/core/package.json`），
 *   发布资源清单里没有它。为了让 10 个工具能列出来，去改发布链、安装布局与四个打包
 *   脚本，成本远高于这里 60 行的 JSON-RPC 分派；而协议面只需要
 *   initialize / tools/list / tools/call / ping 四个方法。**代价要写明**：新协议版本
 *   （比如加入 sampling、elicitation）需要手工跟进，届时应当改用官方 SDK。
 *
 * 三个必须钉住的细节：
 *
 * 1. **工具名用下划线，不是 tool_id 的点号形式**。core 的 `LLM_TOOL_NAME_PATTERN` 是
 *    `[a-zA-Z0-9_-]{1,128}`，点号名会被 warn-and-skip 掉——那样这个出口就是个空壳，
 *    而且只在运行期的 stderr 里说一句。映射只有一处（`mcpToolName`），契约与 CI 都引它。
 * 2. **stdout 只走协议**。下游任何 `console.log` 都会把一条协议行变成两截，
 *    客户端的表现是「连接断了」，排查会往传输层找。这里把 console 重定向到 stderr。
 * 3. **缺 run/session 不静默**：`tools/list` 照常返回（Inspector 要能看契约），
 *    但每个工具的 description 末尾标注「未绑定运行」，`tools/call` 直接拒绝。
 *    「能列不能调」必须当场说出来，否则就是又一个"看起来配好了"。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { runDirectory } from './design-quality.mjs';
import { bindProductCommandPaths } from './product-layout.mjs';
import { executeAction } from './structured-actions.mjs';
import { readRuntimeState } from './tool-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SERVER_NAME = 'aitest-internal-tools';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_FALLBACK = '2024-11-05';

// 协议独占 stdout。劫持发生在任何 import 的副作用之后（模块已加载完），
// 但仍在开始读 stdin 之前——下游的懒加载打印同样会被挡住。
const writeMessage = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const toStderr = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

/** 与 tool_id 一一对应的 MCP 工具名。改这里等于改契约（CI 会一起校验）。 */
export const mcpToolName = toolId => toolId.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * 阶段工具目录：只列**真正可调用**的确定性工具。
 *
 * `BROWSER_STAGE_TOOLS`（dom.snapshot / login.captcha_chain）不在这里：它们由
 * browser-task 在浏览器宿主里执行，入参是页面状态而不是 JSON payload，硬塞进
 * tools/call 只会让 agent 以为传个 payload 就能跑。它们仍属于能力目录，走
 * `dom.snapshot` / `login_captcha_chain` 这两个 action。
 */
const TOOL_IDS = Object.freeze([
  'requirement.testability', 'requirement.acceptance', 'testpoint.coverage', 'irval.check',
  'plan.gates', 'report.reviewer', 'defect.evidence', 'defect.tools',
  'regression.impact', 'regression.select',
]);

/**
 * payload 的结构化契约，供 MCP `inputSchema` 使用。
 *
 * 为什么不直接解析 `STAGE_TOOLS[].payload`：那是 `{"requirement":{"id":string}}` 这种
 * **带伪类型的提示串**，不是 JSON（`string` 不是值），JSON.parse 会直接抛。
 * 两边键集由 `tests/acceptance/central-mcp.test.mjs` 断言一致，防止这里写漏一个键
 * 导致「schema 说能传、校验层拒」。
 */
const PAYLOAD_SCHEMAS = Object.freeze({
  'requirement.testability': { required: ['requirement'], properties: { requirement: { type: 'object' } } },
  'requirement.acceptance': { required: ['requirement'], properties: { requirement: { type: 'object' } } },
  'testpoint.coverage': {
    required: ['requirements', 'test_points'],
    properties: { requirements: { type: 'array' }, test_points: { type: 'array' }, cases: { type: 'array' }, enforce: { type: 'boolean' } },
  },
  'irval.check': { required: ['document'], properties: { document: { type: 'object' } } },
  'plan.gates': { required: ['plan'], properties: { plan: { type: 'object' }, case: { type: 'object' } } },
  'report.reviewer': { required: ['execs'], properties: { execs: { type: 'array' } } },
  'defect.evidence': {
    required: ['exec_ir'],
    properties: { exec_ir: { type: 'object' }, failed_step: { type: 'object' }, baseline: { type: 'object' }, history: { type: 'array' } },
  },
  'defect.tools': {
    required: ['evidence_packs'],
    properties: {
      evidence_packs: { type: 'array' }, existing: { type: 'array' }, history: { type: 'array' },
      // 三分归因（P7/M4）：给了 exec_ir 才走归因，preflight / replay 是环境与
      // 可复现性两路事实，缺一路归因就会降置信度——这是有意的降级，不是失败。
      exec_ir: { type: 'object' }, preflight: { type: 'object' }, replay: { type: 'object' },
    },
  },
  'regression.impact': {
    required: [],
    properties: {
      explicit_ids: { type: 'array', items: { type: 'string' } }, changed_requirements: { type: 'array', items: { type: 'string' } },
      changed_modules: { type: 'array', items: { type: 'string' } }, changed_fragments: { type: 'array', items: { type: 'string' } },
      similar_cases: { type: 'array', items: { type: 'string' } }, cases: { type: 'array' }, quarantine_ids: { type: 'array', items: { type: 'string' } },
    },
  },
  'regression.select': {
    required: ['cases'],
    properties: { cases: { type: 'array' }, tier: { type: 'string', enum: ['smoke', 'core', 'full'] }, budget_s: { type: 'integer', minimum: 0 } },
  },
});

/**
 * 从阶段状态里挑出「唯一在跑的那个」。纯函数，三分支各自有独立的错误文案：
 * 0 个与多个的处理方式完全不同——0 个是"还没开始"，多个是"归属不明、必须显式指定"，
 * 合成一句"阶段状态异常"会让人两个方向都试一遍。agent 不该靠猜 stage，猜错就是一次白跑。
 */
function pickActiveStage(stages) {
  const running = Object.entries(stages ?? {}).filter(([, value]) => value?.status === 'in_progress').map(([name]) => name);
  if (running.length === 1) return running[0];
  if (running.length === 0) throw new Error('当前没有进行中的阶段：先让阶段进入 in_progress 再调工具。');
  throw new Error(`同时有多个进行中的阶段（${running.join(', ')}）：工具调用无法确定归属，请显式传 stage。`);
}

function activeStage(root, runId) {
  const dir = runDirectory(root, runId);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 run manifest（${runId}）：${error.message}。工具只在活跃阶段内可见可调。`);
  }
  try {
    return pickActiveStage(manifest?.stages);
  } catch (error) {
    throw new Error(`run ${runId} ${error.message}`);
  }
}

/** 一次调用的上下文：run 与 session 由装配处注入，缺一个就不许调。 */
function callContext({ runId, session, stage }) {
  const env = process.env;
  const boundRun = runId || env.AITEST_RUN_ID || '';
  const boundSession = session || env.AITEST_CONTROLLER_SESSION || '';
  if (!boundRun) throw new Error('未绑定运行：设置 AITEST_RUN_ID（或调用参数 run_id）。未绑定时的调用一律不执行。');
  if (!/^run-[A-Za-z0-9-]+$/.test(boundRun)) throw new Error(`run_id 格式非法：${boundRun}`);
  if (!boundSession) throw new Error('未绑定会话：设置 AITEST_CONTROLLER_SESSION（或调用参数 session）。工具调用必须记到具体会话上。');
  return { runId: boundRun, session: boundSession, stage: stage || activeStage(ROOT, boundRun) };
}

/**
 * 把 MCP 调用参数翻译成 `run_stage_tool` 请求。纯函数，便于把「请求形态」单独测。
 *
 * `run_id` / `session` / `stage` 是**传送上下文**，不是工具业务参数：把它们留在 payload 里，
 * `validateToolPayload` 会以 `unsupported run_id` 拒绝，而错误文案会误导人去改 payload。
 * 所以这里剥掉，并在剥之前就用掉（stage 缺省时从 manifest 解析）。
 */
function buildRequest(toolId, argument, context) {
  const payload = { ...argument };
  delete payload.run_id;
  delete payload.session;
  delete payload.stage;
  return { action: 'run_stage_tool', run_id: context.runId, stage: context.stage, tool_id: toolId, payload };
}

function toolDescriptor(toolId, runtimeState, bound) {
  const schema = PAYLOAD_SCHEMAS[toolId];
  const spec = TOOL_SPECS[toolId];
  const disabled = runtimeState.disabled.has(toolId);
  const notes = [
    `tool_id=${toolId}`,
    `实现：aitestharness_tools/${spec?.source ?? '（未知）'}`,
    spec ? `阶段：${[spec.stage].flat().join('/')}` : null,
    disabled ? '**当前已停用（管理后台）**，调用会被拒' : null,
    bound ? null : '未绑定运行（缺 AITEST_RUN_ID / AITEST_CONTROLLER_SESSION），调用会被拒',
  ].filter(Boolean);
  return {
    name: mcpToolName(toolId),
    description: `${notes.join('；')}。参数契约：${spec?.payload ?? '{}'}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: schema?.required ?? [],
      properties: schema?.properties ?? {},
    },
  };
}

/** 工具注册表的本地缓存（惰性填充）。 */
const TOOL_SPECS = {};

/** 惰性取注册表：`stage-tool-runtime.mjs` 在 import 期就校验注册表与闸门一致，失败要能被看见。 */
async function loadRegistry() {
  if (Object.keys(TOOL_SPECS).length) return;
  const { STAGE_TOOLS } = await import('./stage-tool-runtime.mjs');
  for (const id of TOOL_IDS) {
    if (!STAGE_TOOLS[id]) throw new Error(`注册表缺少工具 ${id}：STAGE_TOOLS 与 MCP 出口清单不一致`);
    TOOL_SPECS[id] = STAGE_TOOLS[id];
  }
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handle(message) {
  const { id = null, method, params } = message ?? {};
  if (method === undefined) return fail(id, -32600, 'Invalid Request');
  if (method === 'initialize') {
    return ok(id, {
      // 回显客户端请求的版本：规范允许服务端只支持某一版，但本服务的接口面是
      // tools/* 的最小集，各版本的差异（structuredContent、outputSchema）都是可选字段，
      // 回显能让老客户端（2024-11-05）与新客户端都连上，而不是互相以为对方不兼容。
      protocolVersion: params?.protocolVersion ?? PROTOCOL_FALLBACK,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return null;
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') {
    await loadRegistry();
    const runtimeState = readRuntimeState(ROOT);
    const bound = Boolean((process.env.AITEST_RUN_ID ?? '') && (process.env.AITEST_CONTROLLER_SESSION ?? ''));
    return ok(id, { tools: TOOL_IDS.map(toolId => toolDescriptor(toolId, runtimeState, bound)) });
  }
  if (method === 'tools/call') {
    await loadRegistry();
    const name = params?.name;
    const toolId = TOOL_IDS.find(item => mcpToolName(item) === name);
    const argument = params?.arguments ?? {};
    if (!toolId) return ok(id, { isError: true, content: [{ type: 'text', text: `未知工具：${name}。可用工具见 tools/list；不要凭记忆编造工具名。` }] });
    // 停用在协议层就拒：让 agent 立刻看到「这条纪律被关了」，而不是拿到一份少了校验的产物。
    if (readRuntimeState(ROOT).disabled.has(toolId)) {
      return ok(id, { isError: true, content: [{ type: 'text', text: `工具「${toolId}」已在管理后台停用，本次不执行。要恢复请由管理员启用；不要改用别的工具绕过它。` }] });
    }
    let context;
    try {
      context = callContext({ runId: argument.run_id, session: argument.session, stage: argument.stage });
    } catch (error) {
      return ok(id, { isError: true, content: [{ type: 'text', text: error.message }] });
    }
    const request = buildRequest(toolId, argument, context);
    try {
      // 走 executeAction 而不是直接 runStageTool：身份校验、工具闸门、用量与阶段回执
      // 都在那一条路上。MCP 只是传输形态，不是一条新的权限通道。
      const result = await executeAction(ROOT, context.session, () => Buffer.from(JSON.stringify(request), 'utf8'));
      const body = result?.result ?? result;
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] });
    } catch (error) {
      return ok(id, { isError: true, content: [{ type: 'text', text: `工具「${toolId}」执行失败：${error.message}` }] });
    }
  }
  return fail(id, -32601, `Method not found: ${method}`);
}

function start() {
  bindProductCommandPaths(ROOT);
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // 串行处理：MCP 客户端可能并发发请求，但工具调用要写同一个 run 目录的审计与回执，
  // 并发写会让回执顺序与阶段状态互相打架。一次一条，代价是一次调用的延迟。
  let chain = Promise.resolve();
  reader.on('line', line => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      writeMessage(fail(null, -32700, 'Parse error'));
      return;
    }
    chain = chain.then(async () => {
      const response = await handle(message);
      if (response) writeMessage(response);
    }).catch(error => {
      writeMessage(fail(message?.id ?? null, -32603, `Internal error: ${error.message}`));
    });
  });
  reader.on('close', () => {
    chain.finally(() => process.exit(0));
  });
  if (!process.env.AITEST_RUN_ID || !process.env.AITEST_CONTROLLER_SESSION) {
    toStderr(`[${SERVER_NAME}] 未绑定运行：tools/list 可用，tools/call 会被拒。`
      + '需要 AITEST_RUN_ID 与 AITEST_CONTROLLER_SESSION（由装配处注入，Inspector 调试可用 -- 前的同名环境变量）。');
  }
  toStderr(`[${SERVER_NAME}] ready (stdio, ${TOOL_IDS.length} tools)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  // `--list-tools` 是给 CI 用的静态出口：R4 的「契约 tools ⊆ tools/list」必须能不起进程
  // 就拿到清单，否则那条断言只能靠人肉在 Inspector 里点。列表与运行期同源（同一个
  // TOOL_IDS + mcpToolName），不接受另一份手抄的名单。
  if (process.argv.includes('--list-tools')) {
    process.stdout.write(`${JSON.stringify({ tools: TOOL_IDS.map(id => ({ name: mcpToolName(id), toolId: id })) })}\n`);
  } else start();
}

export { TOOL_IDS, PAYLOAD_SCHEMAS, handle, activeStage, pickActiveStage, callContext, buildRequest };
