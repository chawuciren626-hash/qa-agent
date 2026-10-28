import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMiniprogramOperation } from '../../scripts/miniprogram-task.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SYNTHETIC_PASSWORD = 'SyntheticOnly1';

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'aitestharness-miniprogram-project-'));
  mkdirSync(join(directory, 'miniprogram'), { recursive: true });
  writeFileSync(join(directory, 'project.config.json'), JSON.stringify({
    compileType: 'miniprogram',
    appid: 'touristappid',
    projectname: 'aitestharness-miniprogram-fixture',
    miniprogramRoot: 'miniprogram/'
  }));
  writeFileSync(join(directory, 'miniprogram/app.json'), JSON.stringify({ pages: ['pages/login/index', 'pages/orders/index'] }));
  writeFileSync(join(directory, 'fake-devtools-cli.bat'), '@echo off\r\nexit /b 1\r\n');
  return { directory, cli: join(directory, 'fake-devtools-cli.bat') };
}

function runDirectory() {
  return mkdtempSync(join(tmpdir(), 'aitestharness-miniprogram-'));
}

function readAllJson(directory) {
  const rows = [];
  const walk = current => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (name.endsWith('.json')) rows.push(readFileSync(path, 'utf8'));
    }
  };
  walk(directory);
  return rows;
}

function textElement(tag, text) {
  return { tagName: tag, text: async () => text, tap: async () => undefined, input: async () => undefined };
}

function createMiniProgram(state, options = {}) {
  const loginElements = () => ({
    username: { tagName: 'input', text: async () => state.username, input: async value => { state.username = value; }, tap: async () => undefined },
    password: { tagName: 'input', text: async () => state.password, input: async value => { state.password = value; }, tap: async () => undefined },
    'login-btn': {
      tagName: 'button',
      text: async () => '登录',
      input: async () => undefined,
      tap: async () => {
        state.taps += 1;
        if (state.username === 'tester01' && state.password === SYNTHETIC_PASSWORD) state.page = 'orders';
        else state.message = '用户名或密码错误';
        if (options.afterLoginTapError) throw new Error('simulated post-action failure');
      }
    },
    'login-message': textElement('view', state.message),
    'login-title': textElement('view', '账号登录')
  });
  const orderElements = () => ({
    'order-1001-status': textElement('view', state.orderStatus),
    'order-1001-title': textElement('view', '合成订单 A'),
    'order-1001-amount': textElement('view', '128.00'),
    'orders-title': textElement('view', '订单查询'),
    'orders-message': textElement('view', state.message),
    'cancel-1001': {
      tagName: 'button',
      text: async () => '取消订单',
      input: async () => undefined,
      tap: async () => {
        state.taps += 1;
        state.orderStatus = '已取消';
        state.message = '订单已取消';
      }
    },
    logout: { tagName: 'button', text: async () => '退出登录', tap: async () => { state.page = 'login'; }, input: async () => undefined }
  });
  const page = () => {
    const login = state.page === 'login';
    const elements = login ? loginElements() : orderElements();
    const path = login ? 'pages/login/index' : 'pages/orders/index';
    return {
      path,
      data: async () => (login
        ? { username: state.username, password: state.password, message: state.message }
        : { orders: [{ id: '1001', title: '合成订单 A', amount: '128.00', status: state.orderStatus }], message: state.message }),
      $(selector) {
        if (selector.startsWith('#')) return Promise.resolve(elements[selector.slice(1)] ?? null);
        return Promise.resolve(null);
      },
      $$(selector) {
        if (selector.startsWith('#')) {
          const element = elements[selector.slice(1)];
          return Promise.resolve(element ? [element] : []);
        }
        if (selector.startsWith('.')) return Promise.resolve([]);
        return Promise.resolve(Object.values(elements).filter(element => element.tagName === selector));
      }
    };
  };
  return {
    state,
    async currentPage() { return page(); },
    async screenshot({ path }) {
      if (options.screenshotError) throw new Error('simulated screenshot failure');
      writeFileSync(path, png);
      return path;
    },
    async close() { state.closed = true; }
  };
}

function createBackend({ state, afterLoginTapError, screenshotError } = {}) {
  const miniProgramState = state ?? { page: 'login', username: '', password: '', orderStatus: '待支付', message: '', taps: 0, closed: false };
  let miniProgram = null;
  return {
    state: miniProgramState,
    kind: 'fake-devtools',
    async launch() {
      miniProgram = createMiniProgram(miniProgramState, { afterLoginTapError, screenshotError });
      return { miniProgram, wsEndpoint: 'fake://devtools' };
    },
    async connect() {
      if (!miniProgram) throw new Error('not launched');
      return { miniProgram };
    },
    async close() { if (miniProgram) await miniProgram.close(); }
  };
}

function baseArgs(directory, project, backend, operation) {
  return {
    runDirectory: directory,
    operation,
    projectDirectory: project.directory,
    devtoolsCli: project.cli,
    targetKind: 'devtools',
    backend
  };
}

async function chain(directory, project, backend) {
  const results = [];
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'doctor', request_id: 'doctor' })));
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'start', request_id: 'start' })));
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, {
    type: 'assert', request_id: 'login-page', condition: 'page', value: 'login/index', match: 'contains',
    case_id: 'MP-LOGIN-PAGE', title: '当前位于登录页', expected: 'pages/login/index'
  })));
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, {
    type: 'input', request_id: 'username', target: { by: 'id', value: 'username' }, text: 'tester01'
  })));
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, {
    type: 'input', request_id: 'password', target: { by: 'id', value: 'password' }, text: SYNTHETIC_PASSWORD, secret: true
  })));
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, {
    type: 'tap', request_id: 'login', target: { by: 'id', value: 'login-btn' },
    assertion: { condition: 'page', value: 'orders/index', match: 'contains', case_id: 'MP-LOGIN', title: '登录成功', expected: '进入订单页' }
  })));
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, {
    type: 'assert', request_id: 'order-before', condition: 'text', target: { by: 'id', value: 'order-1001-status' },
    value: '待支付', case_id: 'MP-BEFORE', title: '订单初始状态', expected: '待支付'
  })));
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, {
    type: 'tap', request_id: 'cancel', target: { by: 'id', value: 'cancel-1001' },
    assertion: { condition: 'text', target: { by: 'id', value: 'order-1001-status' }, value: '已取消', case_id: 'MP-CANCEL', title: '取消成功', expected: '已取消' }
  })));
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'screenshot', request_id: 'final-shot' })));
  results.push(await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'finish', request_id: 'finish', screenshot: true })));
  return results;
}

test('core synthetic mini program chain records real developer-tools evidence and passing cases', async () => {
  const directory = runDirectory();
  const project = fixtureDirectory();
  const backend = createBackend();
  const results = await chain(directory, project, backend);
  for (const receipt of results.slice(0, -1)) assert.equal(receipt.status, 'ok', `${receipt.request_id}: ${receipt.reason}`);
  const receipt = results.at(-1);
  assert.equal(receipt.status, 'ok');
  const result = JSON.parse(readFileSync(join(directory, 'execution/miniprogram-results.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true }).compile(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../schemas/test_result.schema.json'), 'utf8')));
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.summary, { total: 4, passed: 4, failed: 0, skipped: 0, blocked: 0 });
  assert.equal(result.target.real_device, false);
  assert.equal(result.target.synthetic, true);
  assert.ok(result.miniprogram.limitations.some(text => text.includes('injected fake')));
  assert.equal(result.target.appid_masked, 'tour***id');
  assert.deepEqual(result.cases.map(row => row.case_id).sort(), ['MP-BEFORE', 'MP-CANCEL', 'MP-LOGIN', 'MP-LOGIN-PAGE']);
  assert.ok(result.cases.every(row => row.evidence_paths.some(path => path.endsWith('.png'))));
  assert.ok(result.cases.every(row => row.evidence_paths.some(path => path.endsWith('.observation.json'))));
  assert.ok(result.evidence_index.every(entry => entry.path.startsWith('execution/') && entry.sha256.length === 64));
  const shot = join(directory, 'execution/miniprogram-evidence/final-shot.png');
  assert.ok(existsSync(shot));
  assert.ok(readFileSync(shot).subarray(0, 8).equals(png.subarray(0, 8)));
});

test('secret input is neither echoed nor persisted in receipts and evidence', async () => {
  const directory = runDirectory();
  const project = fixtureDirectory();
  const backend = createBackend();
  await chain(directory, project, backend);
  const documents = readAllJson(directory);
  assert.ok(documents.length > 0);
  for (const document of documents) assert.equal(document.includes(SYNTHETIC_PASSWORD), false);
  const receipt = JSON.parse(readFileSync(join(directory, 'execution/miniprogram-receipts/password.json'), 'utf8'));
  assert.equal(receipt.secret, true);
  assert.equal(receipt.value_length, SYNTHETIC_PASSWORD.length);
  assert.equal(receipt.value_sha256.length, 64);
});

test('secret assertion metadata and observed value are redacted before persistence', async () => {
  const directory = runDirectory();
  const project = fixtureDirectory();
  const backend = createBackend();
  await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'start', request_id: 'start' }));
  const receipt = await runMiniprogramOperation(baseArgs(directory, project, backend, {
    type: 'input',
    request_id: 'secret-input',
    target: { by: 'id', value: 'password' },
    text: SYNTHETIC_PASSWORD,
    secret: true,
    assertion: {
      condition: 'text',
      target: { by: 'id', value: 'password' },
      value: SYNTHETIC_PASSWORD,
      case_id: 'MP-SECRET',
      title: '密码控件回显验证',
      expected: '密码控件文本已写入'
    }
  }));
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.actual, '[REDACTED]');
  assert.equal(receipt.case.checked_condition.value, '[REDACTED]');
  assert.equal(receipt.case.expected, '密码控件文本已写入');
  for (const document of readAllJson(directory)) assert.equal(document.includes(SYNTHETIC_PASSWORD), false);
});

test('developer tools preflight blocks without launching when the CLI is unavailable', async () => {
  const directory = runDirectory();
  const project = fixtureDirectory();
  const backend = createBackend();
  const receipt = await runMiniprogramOperation({
    runDirectory: directory,
    operation: { type: 'doctor', request_id: 'doctor-missing' },
    projectDirectory: project.directory,
    devtoolsCli: resolve(directory, 'missing-wechat-cli.bat'),
    backend
  });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.failure_category, 'environment_issue');
  assert.equal(receipt.synthetic, true);
  assert.ok(receipt.blockers.some(blocker => blocker.id === 'devtools_not_found'));
  assert.equal(receipt.warnings[0].id, 'synthetic_appid');
  assert.equal(backend.state.taps, 0);
  const preflight = JSON.parse(readFileSync(join(directory, 'execution/miniprogram-evidence/doctor-missing.preflight.json'), 'utf8'));
  assert.equal(preflight.status, 'blocked');
  assert.equal(preflight.real_device, false);
});

test('a request id is idempotent and never executes a second write', async () => {
  const directory = runDirectory();
  const project = fixtureDirectory();
  const backend = createBackend();
  await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'start', request_id: 'start' }));
  const first = await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'tap', request_id: 'tap-once', target: { by: 'id', value: 'login-btn' } }));
  assert.equal(first.status, 'ok');
  assert.equal(backend.state.taps, 1);
  const second = await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'tap', request_id: 'tap-once', target: { by: 'id', value: 'login-btn' } }));
  assert.equal(second.duplicate, true);
  assert.equal(backend.state.taps, 1);
  const changed = await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'tap', request_id: 'tap-once', target: { by: 'id', value: 'other-btn' } }));
  assert.equal(changed.status, 'needs_inspection');
  assert.equal(changed.do_not_replay, true);
  assert.equal(changed.duplicate, false);
  assert.equal(backend.state.taps, 1);
  assert.equal(JSON.parse(readFileSync(join(directory, 'execution/miniprogram-receipts/tap-once.json'), 'utf8')).status, 'ok');
});

test('a lost receipt blocks replay of an uncertain write', async () => {
  const directory = runDirectory();
  const project = fixtureDirectory();
  const backend = createBackend();
  await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'start', request_id: 'start' }));
  const first = await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'tap', request_id: 'lost', target: { by: 'id', value: 'login-btn' } }));
  assert.equal(first.status, 'ok');
  assert.equal(backend.state.taps, 1);
  rmSync(join(directory, 'execution/miniprogram-receipts/lost.json'));
  const replay = await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'tap', request_id: 'lost', target: { by: 'id', value: 'login-btn' } }));
  assert.equal(replay.status, 'needs_inspection');
  assert.equal(replay.do_not_replay, true);
  assert.equal(backend.state.taps, 1);
  const finish = await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'finish', request_id: 'finish' }));
  assert.equal(finish.status, 'blocked');
  assert.equal(finish.failure_category, 'environment_issue');
  assert.deepEqual(finish.summary, { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 });
  assert.ok(existsSync(join(directory, 'execution/miniprogram-results.json')));
});

test('a visible assertion mismatch fails the run instead of being reported as a pass', async () => {
  const directory = runDirectory();
  const project = fixtureDirectory();
  const backend = createBackend({ state: { page: 'orders', username: '', password: '', orderStatus: '待支付', message: '', taps: 0, closed: false } });
  await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'start', request_id: 'start' }));
  const receipt = await runMiniprogramOperation(baseArgs(directory, project, backend, {
    type: 'assert', request_id: 'wrong', condition: 'text', target: { by: 'id', value: 'order-1001-status' },
    value: '不存在的状态', case_id: 'MP-WRONG', title: '错误断言', expected: '一个不存在的状态', timeout_ms: 100
  }));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.case.failure_category, 'needs_review');
  const finish = await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'finish', request_id: 'finish' }));
  assert.equal(finish.status, 'failed');
  const result = JSON.parse(readFileSync(join(directory, 'execution/miniprogram-results.json'), 'utf8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.summary.failed, 1);
});

test('a missing locator blocks the assertion without a passing case', async () => {
  const directory = runDirectory();
  const project = fixtureDirectory();
  const backend = createBackend();
  await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'start', request_id: 'start' }));
  const receipt = await runMiniprogramOperation(baseArgs(directory, project, backend, {
    type: 'assert', request_id: 'missing', condition: 'text', target: { by: 'id', value: 'never-rendered' },
    value: 'x', case_id: 'MP-MISSING', title: '不存在的定位', expected: '无法定位', timeout_ms: 100
  }));
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.case.failure_category, 'script_issue');
  const finish = await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'finish', request_id: 'finish' }));
  assert.equal(finish.status, 'blocked');
  const result = JSON.parse(readFileSync(join(directory, 'execution/miniprogram-results.json'), 'utf8'));
  assert.equal(result.summary.blocked, 1);
});

test('finishing without assertions cannot be reported as a completed run', async () => {
  const directory = runDirectory();
  const project = fixtureDirectory();
  const backend = createBackend();
  await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'start', request_id: 'start' }));
  const receipt = await runMiniprogramOperation(baseArgs(directory, project, backend, { type: 'finish', request_id: 'finish' }));
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.failure_category, 'needs_review');
});
