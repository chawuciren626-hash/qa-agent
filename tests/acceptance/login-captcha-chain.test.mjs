import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { executeAction } from '../../scripts/structured-actions.mjs';
import { CAPTCHA_TYPES, classifyLoginForm, classifyCaptcha, parseArithmetic, confidenceGate, strategyOrder, recordStrategyOutcome, validateLoginConfig, MAX_CAPTCHA_SUBMITS, MIN_SOLVE_CONFIDENCE, loginSessionFile, loginSessionMetaFile, loginCaptchaPendingFile, loginCaptchaImageFile, AGENT_VISION_STRATEGY, resolveCaptchaType } from '../../scripts/login-captcha-chain.mjs';
import { validateBrowserOperation } from '../../scripts/browser-task.mjs';

const root = resolve(import.meta.dirname, '../..');
const pause = ms => new Promise(done => setTimeout(done, ms));

test('login form and captcha classification mirror the zero-LLM python rules', () => {
  assert.deepEqual(CAPTCHA_TYPES, ['none', 'image', 'slider', 'click_select', 'sms', 'unknown']);
  const login = classifyLoginForm({ inputs: [{ type: 'text', name: 'u' }, { type: 'password', name: 'p' }], iframes: 0, canvas: 0 });
  assert.equal(login.is_login, true); assert.equal(login.username_field, 'u'); assert.equal(login.password_field, 'p');
  assert.equal(classifyLoginForm({ inputs: [], iframes: 1, canvas: 0 }).is_login, null);
  assert.equal(classifyLoginForm({ inputs: [{ type: 'text', name: 'q' }], iframes: 0, canvas: 0 }).is_login, false);
  const type = hints => classifyCaptcha({ hints }).type;
  assert.equal(type(['img', 'captcha.png']), 'image');
  assert.equal(type(['滑块验证']), 'slider');
  assert.equal(type(['点选验证码']), 'click_select');
  assert.equal(type(['短信验证码', 'sms']), 'sms');
  assert.equal(type(['验证码', 'captcha']), 'unknown');
  assert.equal(type(['username', 'password']), 'none');
});

test('arithmetic captcha parsing computes strictly and never evaluates arbitrary text', () => {
  assert.equal(parseArithmetic('3 + 4 = ?').answer, '7');
  assert.equal(parseArithmetic('12-5＝').answer, '7');
  assert.equal(parseArithmetic('6 × 3 =').answer, '18');
  assert.equal(parseArithmetic('8 ÷ 2 = ?').answer, '4');
  assert.equal(parseArithmetic('2x3').answer, '6');
  for (const text of ['3+4; process.exit()', '9999+1', '5/2', '1/0', 'abc', '', '3++4', '12*34*5', null]) assert.equal(parseArithmetic(text), null, String(text));
  assert.equal(confidenceGate(parseArithmetic('1+1')).accepted, true);
  assert.equal(confidenceGate(null).reason, 'no_solution');
  assert.equal(confidenceGate({ answer: '7', confidence: 0.5 }).reason, 'low_confidence');
});

test('strategy order keeps manual last, sorts by project success rate and bounds retries', () => {
  assert.deepEqual(strategyOrder('image'), ['test_bypass_code', 'ocr', 'captcha_service', 'manual']);
  const stats = {};
  recordStrategyOutcome(stats, 'proj', 'ocr', true);
  recordStrategyOutcome(stats, 'proj', 'ocr', true);
  recordStrategyOutcome(stats, 'proj', 'test_bypass_code', false);
  assert.deepEqual(strategyOrder('image', stats, 'proj'), ['ocr', 'test_bypass_code', 'captcha_service', 'manual']);
  assert.deepEqual(strategyOrder('sms'), ['sms_fixed_code', 'manual']);
  assert.equal(MAX_CAPTCHA_SUBMITS, 2);
});

test('login config validation rejects unknown fields, bad targets and missing success metadata', () => {
  const target = { by: 'css', value: 'input[name=u]' };
  const base = {
    project: 'synthetic-login', username_target: target, password_target: target, submit_target: { by: 'role', value: 'button', name: '登录' },
    success_check: { target: { by: 'text', value: '控制台' }, condition: 'text', case_id: 'LOGIN-OK', title: '登录成功', expected: '进入控制台' },
  };
  assert.equal(validateLoginConfig(base).project, 'synthetic-login');
  assert.throws(() => validateLoginConfig({ ...base, extra: 1 }), /Unknown login config field/);
  assert.throws(() => validateLoginConfig({ ...base, submit_target: { by: 'xpath', value: '//button' } }), /observed target/);
  assert.throws(() => validateLoginConfig({ ...base, success_check: { target, condition: 'visible' } }), /case_id/);
  assert.throws(() => validateLoginConfig({ ...base, reuse_session: { run_id: 'bad id' } }), /prior run_id/);
  assert.throws(() => validateLoginConfig({ ...base, test_code: '' }), /test_code/);
  const op = { type: 'login', request_id: 'login-1', config_path: 'inputs/login-config.json', quote: '"project":"synthetic-login"', username: 'u', password: 'p' };
  validateBrowserOperation(op);
  validateBrowserOperation({ type: 'login_probe', request_id: 'probe-1' });
  assert.throws(() => validateBrowserOperation({ ...op, config_path: '../secrets.json' }), /archived inputs/);
  assert.throws(() => validateBrowserOperation({ ...op, password: '' }), /required/);
  assert.throws(() => validateBrowserOperation({ ...op, quote: 'qa-secret://abc' }), /Protected inputs/);
});

// ---- 合成登录站点：真实 chromium 走完整 worker 链路（工程验证，非真实业务验收） ----

function loginSite({ mode = 'ok', captchaAlt = '3 + 4 = ?', acceptCode = '7', smsHint = false } = {}) {
  const state = { posts: 0, tokens: new Set(), mode, captchaVersion: 0 };
  const page = (body, extra = '') => `<!doctype html><meta charset="utf-8"><title>合成登录</title>${body}${extra}`;
  const formHtml = error => `${smsHint ? '<span>手机短信登录</span>' : ''}<form action="/login" method="post">
    <input name="username" placeholder="用户名">
    <input name="password" type="password" placeholder="密码">
    <img class="captcha" src="/captcha.svg" alt="${captchaAlt}" width="120" height="40">
    <input name="captcha" placeholder="验证码">
    <button type="submit">登录</button>
  </form>${error ? '<div id="error">验证码错误</div>' : ''}`;
  const loginHtml = error => page(formHtml(error));
  const captchaSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#ffffff"/><text x="10" y="28" font-size="24" font-family="monospace" fill="#000000">v${state.captchaVersion}</text></svg>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cookie = /session=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
    const authenticated = cookie && state.tokens.has(cookie);
    if (req.method === 'POST' && url.pathname === '/login') {
      state.posts++;
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        const fields = new URLSearchParams(body);
        if (state.mode === 'unknown') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('<h1>处理中</h1>')); return; }
        // 自愈 toast：错误提示 1.1s 后自己消失，页面不跳转。真实 element-plus 就是这样，
        // 而串行探测要等 8s 成功等待结束才去看失败，那时早已消失。
        if (state.mode === 'toast') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(page(`${formHtml(true)}<script>setTimeout(()=>document.getElementById('error')?.remove(),1100)</script>`));
          return;
        }
        const codeOk = fields.get('captcha') === acceptCode || fields.get('captcha') === '8888';
        const credentialsOk = fields.get('username') === 'demo-user' && fields.get('password') === 'demo-pass-123';
        if (codeOk && credentialsOk) {
          const token = randomUUID().replaceAll('-', ''); state.tokens.add(token);
          res.writeHead(302, { 'set-cookie': `session=${token}; Path=/`, location: '/home' }); res.end(); return;
        }
        state.captchaVersion++;
        res.writeHead(302, { location: '/?error=1' }); res.end();
      });
      return;
    }
    if (url.pathname === '/home') {
      if (authenticated) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('<h1>控制台</h1>')); }
      else { res.writeHead(302, { location: '/' }); res.end(); }
      return;
    }
    if (url.pathname === '/captcha.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }); res.end(captchaSvg()); return; }
    if (authenticated) { res.writeHead(302, { location: '/home' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(loginHtml(url.searchParams.get('error') === '1'));
  });
  return { server, state };
}

async function fixture(url, config) {
  const parent = `session-2026-10-13-00-00-00-${randomUUID().replaceAll('-','')}`;
  const agentRoot = resolve(root, 'output/acceptance', randomUUID());
  const traces = resolve(agentRoot, 'test_agent/traces/2026-10-13'); mkdirSync(traces, { recursive: true });
  const parentFile = resolve(traces, `${parent}_001.jsonl`);
  writeFileSync(parentFile, JSON.stringify({ type: 'session_meta', payload: { session_id: parent, agent_state: resolve(agentRoot, 'test_agent/agent_state'), workspace: root } }));
  const call = r => executeAction(root, parent, () => JSON.stringify(r), { agentRoot });
  const created = await call({ action: 'create_run' }); assert.equal(created.exit_code, 0);
  const id = created.run_id, dir = resolve(root, 'output/runs', id);
  const send = r => call({ run_id: id, ...r });
  assert.equal((await send({ action: 'archive_input', name: 'request.txt', text: `${url} 请对该合成登录页执行自动登录工程验证，仅使用本地合成页面。` })).exit_code, 0);
  const configText = JSON.stringify(config);
  assert.equal((await send({ action: 'archive_input', name: 'login-config.json', text: configText })).exit_code, 0);
  assert.equal((await send({ action: 'plan_run', stages: ['execution'] })).exit_code, 0);
  const dispatched = await send({ action: 'dispatch', stage: 'execution', agent: 'automation_execution_agent', skills: ['playwright-execution'] });
  assert.equal(dispatched.exit_code, 0, JSON.stringify(dispatched));
  const browser = async operation => {
    const result = await send({ action: 'browser_task', operation });
    assert.equal(result.exit_code, 0, JSON.stringify(result));
    return result.data;
  };
  const started = await browser({ type: 'start', request_id: 'start', url, source_path: 'inputs/request.txt', scope: '合成登录页自动登录工程验证', headless: true });
  assert.equal(started.status, 'ready', JSON.stringify(started));
  return { id, dir, browser, send };
}

const target = value => ({ by: 'css', value });
function loginConfig(overrides = {}) {
  return {
    project: 'synthetic-login',
    username_target: target('input[name=username]'),
    password_target: target('input[name=password]'),
    captcha_image_target: target('img.captcha'),
    captcha_input_target: target('input[name=captcha]'),
    submit_target: { by: 'role', value: 'button', name: '登录' },
    success_check: { target: { by: 'text', value: '控制台' }, condition: 'text', case_id: 'LOGIN-OK', title: '自动登录成功', expected: '登录后进入控制台' },
    failure_check: { target: target('#error'), condition: 'visible' },
    ...overrides,
  };
}
const loginOp = (requestId, overrides = {}) => ({ type: 'login', request_id: requestId, config_path: 'inputs/login-config.json', quote: '"project":"synthetic-login"', username: 'demo-user', password: 'demo-pass-123', ...overrides });

async function withSite(options, run) {
  const { server, state } = loginSite(options);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try { await run(url, state); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); }
}

test('login_probe classifies without mutating; configured test code logs in and saves a protected session', async () => {
  await withSite({}, async (url, state) => {
    const config = loginConfig({ test_code: '8888' });
    const f = await fixture(url, config);
    const probe = await f.browser({ type: 'login_probe', request_id: 'probe' });
    assert.equal(probe.classification.is_login, true);
    assert.equal(probe.captcha.type, 'image');
    assert.equal(state.posts, 0);
    const result = await f.browser(loginOp('login-1'));
    assert.equal(result.status, 'logged_in', JSON.stringify(result));
    assert.equal(result.phases.classification.captcha_type, 'image');
    assert.equal(result.phases.recognition.strategy, 'test_bypass_code');
    assert.equal(result.phases.submission.attempts.length, 1);
    assert.equal(result.assertion.status, 'passed');
    assert.equal(result.session.saved, true);
    assert.equal(state.posts, 1);
    assert.ok(existsSync(resolve(f.dir, loginSessionFile)));
    assert.ok(existsSync(resolve(f.dir, loginSessionMetaFile)));
    if (process.platform !== 'win32') assert.equal(statSync(resolve(f.dir, loginSessionFile)).mode & 0o777, 0o600);
    // 回执与结果不得包含凭据、测试码或验证码答案
    const receipt = readFileSync(resolve(f.dir, 'execution/browser-evidence/login-1.json'), 'utf8');
    for (const secret of ['demo-pass-123', 'demo-user', '8888']) assert.ok(!receipt.includes(secret), `receipt leaks ${secret}`);
    assert.ok(!JSON.stringify(result).includes('demo-pass-123'));
    const finished = await f.browser({ type: 'finish', request_id: 'finish', summary: '合成登录工程验证', limitations: ['合成页面，非真实业务验收'] });
    assert.equal(finished.status, 'closed');
    const observation = JSON.parse(readFileSync(resolve(f.dir, 'execution/exploration.json'), 'utf8'));
    const paths = observation.evidence.map(e => e.path);
    assert.ok(paths.includes(loginSessionMetaFile));
    assert.ok(!paths.includes(loginSessionFile), '会话存储本体不得进入证据清单');
    assert.ok(!readFileSync(resolve(f.dir, 'execution/exploration.json'), 'utf8').includes('demo-pass-123'));
  });
});

test('arithmetic captcha is parsed and computed locally without a configured test code', async () => {
  await withSite({}, async (url, state) => {
    const f = await fixture(url, loginConfig());
    const result = await f.browser(loginOp('login-arith'));
    assert.equal(result.status, 'logged_in', JSON.stringify(result));
    assert.equal(result.phases.recognition.strategy, 'local_arithmetic_recognition');
    assert.equal(result.phases.recognition.confidence, 1);
    assert.equal(state.posts, 1);
    assert.ok(!readFileSync(resolve(f.dir, 'execution/browser-evidence/login-arith.json'), 'utf8').includes('"answer"'));
    await f.browser({ type: 'finish', request_id: 'finish', summary: '算术码自动登录工程验证', limitations: ['合成页面'] });
  });
});

test('explicit failure retries at most once and never exceeds the anti-lockout bound', async () => {
  await withSite({}, async (url, state) => {
    const f = await fixture(url, loginConfig({ test_code: '0000' }));
    const result = await f.browser(loginOp('login-bad'));
    assert.equal(result.status, 'login_failed_after_bounded_retries', JSON.stringify(result));
    assert.equal(result.phases.submission.attempts.length, 2);
    assert.ok(result.phases.submission.attempts.every(a => a.outcome === 'explicit_failure'));
    assert.equal(state.posts, 2);
    await f.browser({ type: 'finish', request_id: 'finish', summary: '受限重试验证', limitations: ['合成页面'] });
  });
});

test('a self-healing error toast is judged as explicit failure, not unknown', async () => {
  await withSite({ mode: 'toast' }, async (url, state) => {
    const f = await fixture(url, loginConfig({ test_code: '0000' }));
    const result = await f.browser(loginOp('login-toast'));
    // 这条是 1F 真实验收里栽过的坑：错误提示 1.1s 后自己消失，若等 8s 成功等待
    // 结束再去探失败，只会得到"既没成功也没失败"，把密码错写成"结果未知"。
    assert.equal(result.status, 'login_failed_after_bounded_retries', JSON.stringify(result));
    assert.ok(result.phases.submission.attempts.every(a => a.outcome === 'explicit_failure'), JSON.stringify(result.phases.submission));
    assert.equal(state.posts, 2, '明确失败才允许受限重试一次，且不能超过锁定上限');
    await f.browser({ type: 'finish', request_id: 'finish', summary: '自愈错误提示的失败判定验证', limitations: ['合成页面'] });
  });
});


test('unknown submit outcome stops for inspection and is never replayed', async () => {
  await withSite({ mode: 'unknown' }, async (url, state) => {
    const f = await fixture(url, loginConfig({ test_code: '8888' }));
    const result = await f.browser(loginOp('login-unknown'));
    assert.equal(result.status, 'login_outcome_unknown', JSON.stringify(result));
    assert.equal(state.posts, 1);
    const again = await f.browser(loginOp('login-unknown-replay'));
    assert.equal(again.status, 'needs_inspection');
    assert.equal(again.operation_started ?? false, false);
    assert.equal(state.posts, 1, '未知提交结果绝不允许重放');
    await f.browser({ type: 'finish', request_id: 'finish', summary: '未知提交结果检查', limitations: ['提交结果未知，保留现场'] });
  });
});

test('unrecognizable captcha hands off to agent vision without guess-submitting', async () => {
  await withSite({ captchaAlt: '请输入图中字符' }, async (url, state) => {
    const f = await fixture(url, loginConfig());
    const result = await f.browser(loginOp('login-noguess'));
    assert.equal(result.status, 'recognition_required', JSON.stringify(result));
    assert.equal(result.operation_started, true, '已填凭据但未提交');
    assert.equal(state.posts, 0, '识别回传前绝不提交');
    assert.equal(result.recognition.executor, 'agent_vision');
    assert.equal(result.recognition.strategy, AGENT_VISION_STRATEGY);
    assert.equal(result.recognition.login_request_id, 'login-noguess');
    assert.equal(result.recognition.confidence_minimum, MIN_SOLVE_CONFIDENCE);
    assert.match(result.recognition.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(result.phases.recognition.reason, 'no_recognizable_arithmetic_expression');
    const imagePath = resolve(f.dir, loginCaptchaImageFile('login-noguess'));
    assert.ok(existsSync(imagePath), '验证码截图应受保护保存');
    assert.ok(existsSync(resolve(f.dir, loginCaptchaPendingFile)));
    if (process.platform !== 'win32') assert.equal(statSync(imagePath).mode & 0o777, 0o600);
    // 不回传答案直接收尾：不得提交，受保护临时文件清理且不进证据清单
    const finished = await f.browser({ type: 'finish', request_id: 'finish', summary: '识别回传前不猜测提交', limitations: ['合成页面'] });
    assert.equal(state.posts, 0);
    assert.ok(!existsSync(resolve(f.dir, loginCaptchaPendingFile)));
    const observation = JSON.parse(readFileSync(resolve(f.dir, 'execution/exploration.json'), 'utf8'));
    const paths = observation.evidence.map(e => e.path);
    assert.ok(!paths.includes(loginCaptchaImageFile('login-noguess')), '验证码截图不得进入证据清单');
    assert.ok(!paths.includes(loginCaptchaPendingFile));
  });
});

test('sms captcha reports manual_required without any submission', async () => {
  const smsServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><form action="/login" method="post">
      <input name="username"><input name="password" type="password">
      <input name="smscode" placeholder="短信验证码"><button type="submit">登录</button></form>`);
  });
  const sockets = new Set();
  smsServer.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(done => smsServer.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${smsServer.address().port}/`;
  try {
    const f = await fixture(url, loginConfig());
    const probe = await f.browser({ type: 'login_probe', request_id: 'probe-sms' });
    assert.equal(probe.captcha.type, 'sms');
    const result = await f.browser(loginOp('login-sms'));
    assert.equal(result.status, 'manual_required', JSON.stringify(result));
    assert.equal(result.operation_started, false);
    assert.equal(result.captcha_type, 'sms');
    await f.browser({ type: 'finish', request_id: 'finish', summary: '短信验证码走人工分支', limitations: ['合成页面'] });
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(done => smsServer.close(done)); }
});

test('saved session is verified before reuse; expiry re-runs the strategy chain', async () => {
  await withSite({}, async (url, state) => {
    const first = await fixture(url, loginConfig({ test_code: '8888' }));
    const loggedIn = await first.browser(loginOp('login-first'));
    assert.equal(loggedIn.status, 'logged_in', JSON.stringify(loggedIn));
    const postsAfterFirst = state.posts;
    const second = await fixture(url, loginConfig({ test_code: '8888', reuse_session: { run_id: first.id } }));
    const reused = await second.browser(loginOp('login-reuse'));
    assert.equal(reused.status, 'session_reused', JSON.stringify(reused));
    assert.equal(reused.phases.session_reuse.status, 'reused');
    assert.equal(reused.assertion.status, 'passed');
    assert.equal(state.posts, postsAfterFirst, '会话复用不得重复提交登录');
    // 服务端会话失效后，复用验证失败应自动重走策略链
    state.tokens.clear();
    const third = await fixture(url, loginConfig({ test_code: '8888', reuse_session: { run_id: first.id } }));
    const relogged = await third.browser(loginOp('login-expired'));
    assert.equal(relogged.status, 'logged_in', JSON.stringify(relogged));
    assert.equal(relogged.phases.session_reuse.status, 'expired');
    assert.equal(state.posts, postsAfterFirst + 1);
    for (const f of [first, second, third]) await f.browser({ type: 'finish', request_id: 'finish', summary: '会话复用工程验证', limitations: ['合成页面'] });
  });
});

// ---- 截图识别回传协议：识别执行器=代理视觉（测试扮演读图代理，工程验证非真实业务验收） ----

const recognizeOp = (requestId, loginRequestId, overrides = {}) => ({ type: 'login_recognize', request_id: requestId, login_request_id: loginRequestId, answer: '7', confidence: 0.95, recognizer: 'agent_vision', ...overrides });

test('resolveCaptchaType overrides DOM misclassification only when the declared image exists', () => {
  const config = loginConfig();
  assert.deepEqual(resolveCaptchaType('sms', config, true), { type: 'image', basis: 'project_config_declared', dom_captcha_type: 'sms' });
  assert.deepEqual(resolveCaptchaType('sms', config, false), { type: 'sms', basis: 'dom_keyword_rules', dom_captcha_type: 'sms' });
  assert.deepEqual(resolveCaptchaType('image', config, true), { type: 'image', basis: 'dom_keyword_rules', dom_captcha_type: 'image' });
  assert.deepEqual(resolveCaptchaType('none', {}, false), { type: 'none', basis: 'dom_keyword_rules', dom_captcha_type: 'none' });
  assert.equal(resolveCaptchaType('slider', config, true).type, 'image');
});

test('login_recognize operation validation binds login_request_id, confidence and recognizer', () => {
  validateBrowserOperation(recognizeOp('rec-1', 'login-1'));
  assert.throws(() => validateBrowserOperation(recognizeOp('rec-1', 'login-1', { recognizer: 'local_ocr' })), /agent_vision/);
  assert.throws(() => validateBrowserOperation(recognizeOp('rec-1', 'login-1', { confidence: 1.5 })), /confidence/);
  assert.throws(() => validateBrowserOperation(recognizeOp('rec-1', 'login-1', { answer: '' })), /answer/);
  assert.throws(() => validateBrowserOperation(recognizeOp('rec-1', '')), /login_request_id/);
});

test('agent vision return completes auto-login and saves a protected session', async () => {
  await withSite({ captchaAlt: '' }, async (url, state) => {
    const f = await fixture(url, loginConfig());
    const handoff = await f.browser(loginOp('login-vision'));
    assert.equal(handoff.status, 'recognition_required', JSON.stringify(handoff));
    assert.equal(state.posts, 0);
    const result = await f.browser(recognizeOp('rec-vision', 'login-vision'));
    assert.equal(result.status, 'logged_in', JSON.stringify(result));
    assert.equal(result.phases.recognition.strategy, AGENT_VISION_STRATEGY);
    assert.equal(result.phases.recognition.executor, 'agent_vision');
    assert.equal(result.phases.submission.attempts.length, 1);
    assert.equal(result.assertion.status, 'passed');
    assert.equal(result.session.saved, true);
    assert.equal(state.posts, 1);
    assert.ok(!existsSync(resolve(f.dir, loginCaptchaPendingFile)), '待识别状态一次性消费');
    // 回执与结果不得包含凭据或验证码答案字段
    const receipt = readFileSync(resolve(f.dir, 'execution/browser-evidence/rec-vision.json'), 'utf8');
    assert.ok(!receipt.includes('demo-pass-123'));
    assert.ok(!receipt.includes('"answer"'));
    assert.ok(!JSON.stringify(result).includes('demo-pass-123'));
    const finished = await f.browser({ type: 'finish', request_id: 'finish', summary: '代理视觉识别回传自动登录工程验证', limitations: ['合成页面，识别执行器=代理视觉'] });
    assert.equal(finished.status, 'closed');
    const observation = JSON.parse(readFileSync(resolve(f.dir, 'execution/exploration.json'), 'utf8'));
    const paths = observation.evidence.map(e => e.path);
    assert.ok(paths.includes(loginSessionMetaFile));
    assert.ok(!paths.includes(loginSessionFile));
    assert.ok(!paths.includes(loginCaptchaImageFile('login-vision')), '验证码截图不进证据清单');
    assert.ok(!paths.includes(loginCaptchaPendingFile));
    assert.ok(!readFileSync(resolve(f.dir, 'execution/exploration.json'), 'utf8').includes('demo-pass-123'));
  });
});

test('a refreshed captcha rejects the stale answer via fingerprint mismatch', async () => {
  await withSite({ captchaAlt: '' }, async (url, state) => {
    const f = await fixture(url, loginConfig());
    const handoff = await f.browser(loginOp('login-stale'));
    assert.equal(handoff.status, 'recognition_required', JSON.stringify(handoff));
    state.captchaVersion++; // 模拟验证码刷新
    await f.browser({ type: 'goto', request_id: 'reload-stale', url, source_path: 'inputs/request.txt' }); // 重新加载使新码真正渲染
    const result = await f.browser(recognizeOp('rec-stale', 'login-stale'));
    assert.equal(result.status, 'captcha_changed', JSON.stringify(result));
    assert.equal(result.operation_started, false);
    assert.equal(state.posts, 0, '指纹不一致绝不提交旧答案');
    assert.ok(!existsSync(resolve(f.dir, loginCaptchaPendingFile)));
    await f.browser({ type: 'finish', request_id: 'finish', summary: '指纹绑定防旧答案', limitations: ['合成页面'] });
  });
});

test('low confidence return never submits and keeps the pending recognition reusable', async () => {
  await withSite({ captchaAlt: '' }, async (url, state) => {
    const f = await fixture(url, loginConfig());
    await f.browser(loginOp('login-conf'));
    const low = await f.browser(recognizeOp('rec-low', 'login-conf', { confidence: 0.5 }));
    assert.equal(low.status, 'recognition_low_confidence', JSON.stringify(low));
    assert.equal(low.operation_started, false);
    assert.equal(state.posts, 0);
    assert.ok(existsSync(resolve(f.dir, loginCaptchaPendingFile)), '低置信度不消费待识别状态');
    const ok = await f.browser(recognizeOp('rec-ok', 'login-conf', { confidence: 0.95 }));
    assert.equal(ok.status, 'logged_in', JSON.stringify(ok));
    assert.equal(state.posts, 1);
    await f.browser({ type: 'finish', request_id: 'finish', summary: '置信度门控', limitations: ['合成页面'] });
  });
});

test('recognition return is one-time: replay reads the receipt and a consumed pending cannot be reused', async () => {
  await withSite({ captchaAlt: '' }, async (url, state) => {
    const f = await fixture(url, loginConfig());
    await f.browser(loginOp('login-once'));
    const first = await f.browser(recognizeOp('rec-once', 'login-once'));
    assert.equal(first.status, 'logged_in', JSON.stringify(first));
    assert.equal(state.posts, 1);
    const replay = await f.browser(recognizeOp('rec-once', 'login-once'));
    assert.equal(replay.status, 'logged_in', '相同 request_id 幂等读取回执');
    assert.equal(state.posts, 1);
    const changed = await f.send({ action: 'browser_task', operation: recognizeOp('rec-once', 'login-once', { answer: '8' }) });
    assert.equal(changed.exit_code, 0);
    assert.equal(changed.data.status, 'invalid_request', '同 ID 改答案被拒');
    const fresh = await f.browser(recognizeOp('rec-again', 'login-once'));
    assert.equal(fresh.status, 'recognition_not_pending', '已消费的待识别状态不可再用');
    assert.equal(state.posts, 1);
    await f.browser({ type: 'finish', request_id: 'finish', summary: '一次性回传', limitations: ['合成页面'] });
  });
});

test('explicit failure re-captures a new captcha and stays within the anti-lockout bound', async () => {
  await withSite({ captchaAlt: '' }, async (url, state) => {
    const f = await fixture(url, loginConfig());
    const first = await f.browser(loginOp('login-bound'));
    assert.equal(first.status, 'recognition_required', JSON.stringify(first));
    assert.equal(first.recognition.attempt, 1);
    const wrong1 = await f.browser(recognizeOp('rec-bound1', 'login-bound', { answer: '1' }));
    assert.equal(wrong1.status, 'recognition_required', JSON.stringify(wrong1));
    assert.equal(wrong1.recognition.attempt, 2);
    assert.notEqual(wrong1.recognition.fingerprint, first.recognition.fingerprint, '失败后应截取刷新后的新码');
    assert.equal(state.posts, 1);
    const wrong2 = await f.browser(recognizeOp('rec-bound2', 'login-bound', { answer: '2' }));
    assert.equal(wrong2.status, 'login_failed_after_bounded_retries', JSON.stringify(wrong2));
    assert.equal(wrong2.phases.submission.attempts.length, 2);
    assert.ok(wrong2.phases.submission.attempts.every(a => a.outcome === 'explicit_failure'));
    assert.equal(state.posts, 2, '首次+1 次重试，绝不超限');
    assert.ok(!existsSync(resolve(f.dir, loginCaptchaPendingFile)));
    await f.browser({ type: 'finish', request_id: 'finish', summary: '回传链路受限重试', limitations: ['合成页面'] });
  });
});

test('config-declared image overrides an inactive sms tab misclassification end to end', async () => {
  await withSite({ captchaAlt: '', smsHint: true }, async (url, state) => {
    const f = await fixture(url, loginConfig());
    const probe = await f.browser({ type: 'login_probe', request_id: 'probe-override' });
    assert.equal(probe.captcha.type, 'sms', 'DOM 关键词仍误判为短信');
    const handoff = await f.browser(loginOp('login-override'));
    assert.equal(handoff.status, 'recognition_required', JSON.stringify(handoff));
    assert.equal(handoff.phases.classification.captcha_type, 'image');
    assert.equal(handoff.phases.classification.basis, 'project_config_declared');
    assert.equal(handoff.phases.classification.dom_captcha_type, 'sms');
    const result = await f.browser(recognizeOp('rec-override', 'login-override'));
    assert.equal(result.status, 'logged_in', JSON.stringify(result));
    assert.equal(state.posts, 1);
    await f.browser({ type: 'finish', request_id: 'finish', summary: '配置声明覆盖误分类', limitations: ['合成页面'] });
  });
});