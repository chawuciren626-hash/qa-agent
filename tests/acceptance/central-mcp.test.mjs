/**
 * M1 验收：能力出口真的能被 MCP 客户端连上、列全、并拒绝该拒绝的调用。
 *
 * 用**官方 SDK 客户端**而不是自己拼 JSON：Inspector 与 penguin-core 的
 * McpToolProvider 走的是同一个包。手拼协议只能证明"我按自己的理解发出去有人应"，
 * 证明不了客户端认不认——而后者才是"agent 到底能不能用"。
 *
 * 这条测试挡的是三类静默失败：
 *   1. 工具名带点号 → core 的 LLM_TOOL_NAME_PATTERN 会 warn-and-skip，出口变空壳；
 *   2. tools/list 与运行期注册表漂了 → agent 看到一个调不通的名字；
 *   3. 停用/未绑定只写在文档里 → 调用照跑，产出少了一道校验的产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const SDK = resolve(ROOT, 'platform/packages/core/node_modules/@modelcontextprotocol/client/dist/index.mjs');
const SDK_STDIO = resolve(ROOT, 'platform/packages/core/node_modules/@modelcontextprotocol/client/dist/stdio.mjs');
const SERVER = resolve(ROOT, 'scripts/central-mcp.mjs');
const STATE = resolve(ROOT, 'config/tool-runtime-state.json');

const haveSdk = existsSync(SDK) && existsSync(SDK_STDIO);
const {Client} = haveSdk ? await import(`file://${SDK.replaceAll('\\', '/')}`) : {};
const {StdioClientTransport} = haveSdk ? await import(`file://${SDK_STDIO.replaceAll('\\', '/')}`) : {};
const {TOOL_IDS, PAYLOAD_SCHEMAS, buildRequest, pickActiveStage, mcpToolName} = await import('../../scripts/central-mcp.mjs');
const {STAGE_TOOLS, validateToolPayload} = await import('../../scripts/stage-tool-runtime.mjs');

const skip = haveSdk ? false : 'MCP SDK 未安装（pnpm install 后可跑）';

async function connect(t, env = {}) {
  const client = new Client({name: 'aitest-acceptance', version: '0.0.0'});
  const transport = new StdioClientTransport({command: process.execPath, args: [SERVER], env: {...process.env, ...env}, stderr: 'pipe'});
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return client;
}

test('官方 SDK 客户端能连上，并列出全部可调工具', {skip}, async t => {
  const client = await connect(t);
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(item => item.name).sort(), TOOL_IDS.map(mcpToolName).sort());
  // 注册表是唯一真源：出口清单不能是另一份手抄的名单。
  assert.deepEqual([...TOOL_IDS].sort(), Object.keys(STAGE_TOOLS).sort());
});

test('每个工具名都符合 LLM API 的工具名契约', {skip}, async t => {
  const client = await connect(t);
  const {tools} = await client.listTools();
  for (const tool of tools) {
    // core 的 provider 用 /^[a-zA-Z0-9_-]{1,128}$/ 过滤；不匹配的工具会被静默跳过。
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,128}$/, `${tool.name} 会被客户端跳过`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.includes(`tool_id=${TOOL_IDS[tools.indexOf(tool)]}`), '描述里要留可回溯的 tool_id');
  }
});

test('未绑定运行：能列出，但一次调用都不执行', {skip}, async t => {
  const client = await connect(t, {AITEST_RUN_ID: '', AITEST_CONTROLLER_SESSION: ''});
  const {tools} = await client.listTools();
  assert.ok(tools.every(item => item.description.includes('未绑定运行')), '列表本身就要说明调不动，不能等调用时才说');
  const result = await client.callTool({name: 'irval_check', arguments: {document: {}}});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未绑定运行/);
});

test('停用工具在协议层就拒，并且列表里标注已停用', {skip}, async t => {
  const backup = `${STATE}.acceptance-backup`;
  const restore = () => {
    if (existsSync(backup)) { renameSync(backup, STATE); }
  };
  t.after(restore);
  if (existsSync(STATE)) renameSync(STATE, backup);
  writeFileSync(STATE, JSON.stringify({version: 1, disabled: ['irval.check'], versions: {}, updated_at: new Date().toISOString()}));
  const client = await connect(t, {AITEST_RUN_ID: 'run-acceptance', AITEST_CONTROLLER_SESSION: 'session-acceptance'});
  const {tools} = await client.listTools();
  assert.match(tools.find(item => item.name === 'irval_check').description, /已停用/);
  const result = await client.callTool({name: 'irval_check', arguments: {document: {}}});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /停用/);
});

test('未知工具给出可执行的下一步，而不是协议错误', {skip}, async t => {
  const client = await connect(t);
  const result = await client.callTool({name: 'irval.check', arguments: {}});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未知工具/);
});

test('MCP 调用参数翻译成 run_stage_tool，上下文不落进 payload', () => {
  const context = {runId: 'run-abc', session: 'session-1', stage: 'analysis'};
  const request = buildRequest('irval.check', {document: {a: 1}, run_id: 'run-other', stage: 'report', session: 'x'}, context);
  assert.deepEqual(request, {action: 'run_stage_tool', run_id: 'run-abc', stage: 'analysis', tool_id: 'irval.check', payload: {document: {a: 1}}});
});

test('阶段解析三分支：唯一/没有/多个', () => {
  assert.equal(pickActiveStage({analysis: {status: 'in_progress'}, report: {status: 'pending'}}), 'analysis');
  assert.throws(() => pickActiveStage({analysis: {status: 'pending'}}), /没有进行中的阶段/);
  assert.throws(() => pickActiveStage({analysis: {status: 'in_progress'}, report: {status: 'in_progress'}}), /请显式传 stage/);
});

test('inputSchema 与校验层同源：不多一个键，也不少一个键', () => {
  // 占位值要满足 schema 自身的约束（enum 取首个值），否则测的是"占位值不合法"而不是"键是否被接受"。
  const placeholder = schema => Array.isArray(schema.enum) ? schema.enum[0]
    : schema.type === 'array' ? [] : schema.type === 'object' ? {} : schema.type === 'boolean' ? false : schema.type === 'integer' ? 0 : 'x';
  for (const toolId of TOOL_IDS) {
    const declared = PAYLOAD_SCHEMAS[toolId];
    assert.ok(declared, `${toolId} 没有声明 inputSchema`);
    const required = Object.fromEntries((declared.required ?? []).map(key => [key, placeholder(declared.properties[key])]));
    // ① schema 声明的每个键，校验层都必须接受（否则 agent 按 schema 传会被拒）
    for (const [key, schema] of Object.entries(declared.properties)) {
      assert.doesNotThrow(() => validateToolPayload(toolId, {...required, [key]: placeholder(schema)}),
        `${toolId} 的 schema 声明了 ${key}，校验层却拒绝`);
    }
    // ② schema 之外的键必须被拒（additionalProperties:false 不是装饰）
    assert.throws(() => validateToolPayload(toolId, {...required, __undeclared__: 1}), new RegExp(`unsupported __undeclared__|missing`),
      `${toolId} 接受了未声明的键`);
    // ③ 必填项缺失要报 missing，而不是静默通过
    for (const key of declared.required ?? []) {
      const without = {...required};
      delete without[key];
      assert.throws(() => validateToolPayload(toolId, without), /missing/);
    }
  }
});

test('工具注册表与闸门绑定不允许各自为政', () => {
  // stage-tool-runtime 在 import 期已断言 STAGE_TOOLS ≡ CALLABLE_STAGE_TOOL_IDS；
  // 这里补另一半：MCP 出口清单不能比注册表多（多出来的永远调不通）。
  const {CALLABLE_STAGE_TOOL_IDS} = readGateBindings();
  for (const toolId of TOOL_IDS) assert.ok(CALLABLE_STAGE_TOOL_IDS.includes(toolId), `${toolId} 不在闸门绑定里`);
  assert.equal(TOOL_IDS.length, CALLABLE_STAGE_TOOL_IDS.length, '有可调用工具没被出口暴露');
});

function readGateBindings() {
  const text = readFileSync(resolve(ROOT, 'scripts/tool-gate.mjs'), 'utf8');
  const block = text.slice(text.indexOf('CALLABLE_STAGE_TOOL_IDS = Object.freeze(['), text.indexOf(']);', text.indexOf('CALLABLE_STAGE_TOOL_IDS = Object.freeze([')));
  return {CALLABLE_STAGE_TOOL_IDS: [...block.matchAll(/'([a-z0-9_.]+)'/g)].map(item => item[1])};
}
