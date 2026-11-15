import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectStubs, attributeToStub, applyStubPolicy, describeStubPolicy } from '../../scripts/execution-stub.mjs';

const stubs = [{ id: 'sms', target: 'https://sms.example.com', mode: 'passthrough', steps: ['S2'] }];

const row = (overrides = {}) => ({ case_id: 'TC-1', step_id: 'S2', status: 'failed', error: { message: 'connect ECONNREFUSED https://sms.example.com' }, ...overrides });

test('没声明 stub 时一条也不降级：inconclusive 太舒服，不能随便给', () => {
  const result = applyStubPolicy([row()], { stubs: [] });
  assert.equal(result.cases[0].status, 'failed');
  assert.equal(result.downgraded.length, 0);
});

test('声明了依赖且连不上 → inconclusive，并说明不判产品缺陷', () => {
  const result = applyStubPolicy([row()], { stubs });
  assert.equal(result.cases[0].status, 'inconclusive');
  assert.equal(result.cases[0].original_status, 'failed');
  assert.equal(result.downgraded.length, 1);
  assert.match(result.downgraded[0].detail, /不判产品缺陷/);
});

test('声明了依赖但失败是断言不成立 → 仍然是 fail（那是产品行为不对）', () => {
  const failing = row({ error: { message: 'expected 3 to equal 4' } });
  const result = applyStubPolicy([failing], { stubs });
  assert.equal(result.cases[0].status, 'failed');
  assert.equal(result.downgraded.length, 0);
});

test('打了桩还失败 → 不降级，并单独计入 kept_fail', () => {
  const stubbed = [{ ...stubs[0], mode: 'stub' }];
  const result = applyStubPolicy([row()], { stubs: stubbed });
  assert.equal(result.cases[0].status, 'failed');
  assert.equal(result.kept_fail.length, 1);
  assert.match(result.kept_fail[0].detail, /真问题/);
});

test('步骤级绑定只影响该步骤，别的步骤挂了照常算 fail', () => {
  const other = row({ case_id: 'TC-2', step_id: 'S9' });
  const result = applyStubPolicy([row(), other], { stubs });
  assert.equal(result.cases[0].status, 'inconclusive');
  assert.equal(result.cases[1].status, 'failed');
});

test('只有依赖不可用特征才降级：普通业务报错不归到环境', () => {
  const business = row({ error: { message: '库存不足，无法下单' } });
  assert.equal(attributeToStub(business, stubs), null);
});

test('超时/5xx 也算依赖不可用', () => {
  for (const message of ['request timeout after 30000ms', 'HTTP 503 Service Unavailable', 'socket hang up']) {
    assert.ok(attributeToStub(row({ error: { message } }), stubs), message);
  }
});

test('已通过的用例不受影响', () => {
  const result = applyStubPolicy([{ case_id: 'TC-3', step_id: 'S2', status: 'passed' }], { stubs });
  assert.equal(result.cases[0].status, 'passed');
  assert.equal(result.cases[0].stub, undefined);
});

test('从 plan 收集两种写法：依赖视角与步骤视角', () => {
  const plan = {
    stubs: [{ id: 'sms', target: 'https://sms.example.com', steps: ['S2'] }],
    steps: [{ step_id: 'S1', stub: 'pay' }, { step_id: 'S2', stub: ['sms'] }],
  };
  const collected = collectStubs(plan);
  const byId = Object.fromEntries(collected.map(item => [item.id, item]));
  assert.deepEqual(byId.sms.steps.sort(), ['S2']);
  assert.deepEqual(byId.pay.steps, ['S1']);
  assert.equal(byId.pay.mode, 'passthrough');
});

test('未知 mode 归为 passthrough：不认识的写法不当成「已打桩」', () => {
  const collected = collectStubs({ stubs: [{ id: 'x', mode: 'weird' }] });
  assert.equal(collected[0].mode, 'passthrough');
});

test('描述文案：未声明时不说「没有外部依赖」', () => {
  assert.match(describeStubPolicy(applyStubPolicy([], { stubs: [] })), /未声明外部依赖桩/);
  assert.match(describeStubPolicy(applyStubPolicy([row()], { stubs })), /降为 inconclusive/);
});

test('无 stub 声明时 cases 原样透传，不改任何字段', () => {
  const input = [row()];
  const result = applyStubPolicy(input, { stubs: [] });
  assert.equal(result.cases[0], input[0], '应返回同一对象引用，避免悄悄加工数据');
});
