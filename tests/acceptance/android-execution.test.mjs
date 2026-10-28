import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { runAndroidOperation, validateAndroidOperation } from '../../scripts/android-task.mjs';
import { parseUiHierarchy, findUiNodes, describeUiTree } from '../../scripts/android-ui-tree.mjs';
import { parseAdbDevices, selectDevice, classifyAdbFailure } from '../../scripts/android-adb.mjs';
import { scrubText } from '../../scripts/android-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const schema = JSON.parse(readFileSync(resolve(root, 'schemas/test_result.schema.json'), 'utf8'));
const validateResult = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[0,0][1080,1920]">
<node index="0" text="Login" resource-id="com.example.app:id/title" class="android.widget.TextView" package="com.example.app" content-desc="" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[100,200][400,260]" />
<node index="1" text="" resource-id="com.example.app:id/username" class="android.widget.EditText" package="com.example.app" content-desc="Username" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[100,300][900,380]" />
<node index="2" text="" resource-id="com.example.app:id/password" class="android.widget.EditText" package="com.example.app" content-desc="Password" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[100,400][900,480]" />
<node index="3" text="Sign in" resource-id="com.example.app:id/submit" class="android.widget.Button" package="com.example.app" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[100,500][500,580]" />
</node></hierarchy>`;

function runDirectory() {
  const directory = resolve(root, 'output/acceptance', randomUUID());
  mkdirSync(directory, { recursive: true });
  return directory;
}

function ok(stdout = '') {
  return { code: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false };
}

function createFakeAdb({ packageName = 'com.example.app', component = 'com.example.app/.MainActivity', installed = true, locked = false, devices = 'emulator-5554\tdevice\n', xml = UI_XML, logcat = 'I/ActivityManager: fixture\n' } = {}) {
  const calls = [];
  const failures = [];
  const state = { packageName, component, installed, locked, xml, logcat, devices };
  const has = (args, ...parts) => parts.every(part => args.includes(part));
  const respond = args => {
    if (args[0] === 'version') return ok('Android Debug Bridge version 1.0.41');
    if (args[0] === 'devices') return ok(`List of devices attached\n${state.devices}`);
    if (has(args, 'get-state')) return ok('device');
    if (has(args, 'shell', 'getprop')) return ok('[ro.product.manufacturer]: [Fixture]\n[ro.product.model]: [Synthetic Phone]\n[ro.build.version.sdk]: [34]\n[ro.build.version.release]: [14]\n[sys.boot_completed]: [1]\n');
    if (has(args, 'dumpsys', 'activity', 'activities')) return ok(`mResumedActivity: ActivityRecord{1a2b u0 ${state.component} t1}\n`);
    if (has(args, 'dumpsys', 'window', 'policy')) return ok(`KeyguardShowing=${state.locked}\n`);
    if (has(args, 'dumpsys', 'window', 'windows')) return ok('');
    if (has(args, 'dumpsys', 'power')) return ok('mWakefulness=Awake\nDisplay Power: state=ON\n');
    if (has(args, 'uiautomator', 'dump')) return ok('UI hierchary dumped to: /data/local/tmp/fixture.xml\n');
    if (has(args, 'exec-out', 'cat')) return ok(state.xml);
    if (has(args, 'exec-out', 'screencap')) return ok(PNG);
    if (has(args, 'shell', 'rm')) return ok('');
    if (has(args, 'shell', 'logcat')) return ok(state.logcat);
    if (has(args, 'shell', 'pm', 'path')) return ok(state.installed ? 'package:/data/app/fixture/base.apk\n' : '');
    if (has(args, 'shell', 'dumpsys', 'package')) return ok('versionName=1.0.0 versionCode=1\n');
    if (has(args, 'cmd', 'package', 'resolve-activity')) return ok(`${state.packageName}/${state.component.split('/')[1]}\n`);
    if (has(args, 'shell', 'am', 'start')) return ok('Starting: Intent { cmp=fixture }\nStatus: ok\nLaunchState: COLD\n');
    if (has(args, 'shell', 'am', 'force-stop')) return ok('');
    if (has(args, 'shell', 'input')) return ok('');
    if (has(args, 'shell', 'wm', 'dismiss-keyguard')) return ok('');
    return ok('');
  };
  return {
    calls,
    state,
    failNext(match, options = {}) { failures.push({ match, ...options }); },
    async run(args) {
      calls.push(args);
      const index = failures.findIndex(rule => args.join(' ').includes(rule.match));
      if (index >= 0) {
        const rule = failures.splice(index, 1)[0];
        return { code: rule.code ?? 1, stdout: Buffer.from(rule.stdout ?? ''), stderr: Buffer.from(rule.stderr ?? 'injected failure'), timedOut: rule.timedOut === true };
      }
      return respond(args);
    }
  };
}

const operation = (runDir, value, extra = {}) => runAndroidOperation({ runDirectory: runDir, operation: value, runner: extra.runner, allowedPackages: extra.allowedPackages ?? [], checkJava: false });

async function started(runDir, runner, requestId = 'start-1', extra = {}) {
  const receipt = await operation(runDir, { type: 'start', request_id: requestId, package: 'com.example.app', device: 'emulator-5554', ...extra }, { runner });
  assert.equal(receipt.status, 'ok', JSON.stringify(receipt));
  return receipt;
}

test('ui tree parsing resolves locators on an adb hierarchy dump', () => {
  const tree = parseUiHierarchy(UI_XML);
  assert.equal(describeUiTree(tree, { limit: 10 }).node_count, 5);
  assert.equal(findUiNodes(tree, { by: 'text', value: 'Sign in' }).selected.resourceId, 'com.example.app:id/submit');
  assert.equal(findUiNodes(tree, { by: 'id', value: 'com.example.app:id/password' }).selected.bounds.center_y, 440);
  assert.equal(findUiNodes(tree, { by: 'text', value: 'Sign in', index: 0 }).total, 1);
  assert.equal(findUiNodes(tree, { by: 'desc', value: 'Username' }).selected.className, 'android.widget.EditText');
  assert.equal(findUiNodes(tree, { by: 'text', value: 'Missing' }).total, 0);
  assert.equal(parseAdbDevices('List of devices attached\nemulator-5554\tdevice product:x\n').length, 1);
  assert.throws(() => selectDevice([{ serial: 'a', state: 'offline' }]), /offline/);
  assert.equal(classifyAdbFailure({ code: 1, stdout: '', stderr: 'error: device offline' }), 'device_offline');
});

test('operation validation rejects unsupported fields and incomplete assertions', () => {
  assert.throws(() => validateAndroidOperation({ type: 'teleport', request_id: 'a' }), /operation.type/);
  assert.throws(() => validateAndroidOperation({ type: 'tap', request_id: 'a' }), /target/);
  assert.throws(() => validateAndroidOperation({ type: 'tap', request_id: 'a', target: { by: 'text', value: 'x' }, extra: true }), /unsupported field/);
  assert.throws(() => validateAndroidOperation({ type: 'start', request_id: 'a' }), /package/);
  assert.throws(() => validateAndroidOperation({ type: 'start', request_id: 'a', package: 'not-a-package' }), /package name/);
  assert.throws(() => validateAndroidOperation({ type: 'key', request_id: 'a', key: 'power' }), /operation.key/);
  assert.throws(() => validateAndroidOperation({ type: 'wait', request_id: 'a' }), /wait requires/);
  assert.throws(() => validateAndroidOperation({ type: 'assert', request_id: 'a', condition: 'visible', case_id: 'c', title: 't', expected: 'e' }), /target/);
  assert.equal(validateAndroidOperation({ type: 'wait', request_id: 'a', target: { by: 'text', value: 'Login' } }).assertion.condition, 'visible');
});

test('doctor reports a blocked preflight when no device is connected', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb({ devices: '' });
  const receipt = await operation(runDir, { type: 'doctor', request_id: 'doctor-1' }, { runner });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.failure_category, 'environment_issue');
  assert.equal(receipt.preflight.blockers[0].id, 'devices');
  assert.ok(existsSync(resolve(runDir, receipt.evidence_paths[0])));
  assert.equal(existsSync(resolve(runDir, 'execution/android-session.json')), false);
});

test('start resolves the launcher, records a session and stores launch evidence', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  const receipt = await started(runDir, runner);
  assert.equal(receipt.focused, true);
  assert.equal(receipt.resolved_activity, 'com.example.app/.MainActivity');
  assert.ok(receipt.evidence_paths.includes('execution/android-evidence/start-1.png'));
  assert.ok(receipt.evidence_paths.includes('execution/android-evidence/start-1.ui.xml'));
  assert.ok(existsSync(resolve(runDir, 'execution/android-evidence/start-1.png')));
  const session = JSON.parse(readFileSync(resolve(runDir, 'execution/android-session.json'), 'utf8'));
  assert.equal(session.status, 'active');
  assert.equal(session.package, 'com.example.app');
  assert.equal(session.device_serial, 'emulator-5554');
  assert.equal(session.steps, 1);
});

test('start reports a missing package without creating a session', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb({ installed: false });
  const receipt = await operation(runDir, { type: 'start', request_id: 'start-missing', package: 'com.example.app' }, { runner });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.diagnostic.category, 'package_not_installed');
  assert.equal(receipt.failure_category, 'environment_issue');
  assert.equal(existsSync(resolve(runDir, 'execution/android-session.json')), false);
});

test('start enforces the allowed package list', async () => {
  const runDir = runDirectory();
  const receipt = await operation(runDir, { type: 'start', request_id: 'start-denied', package: 'com.example.app' }, { runner: createFakeAdb(), allowedPackages: ['com.other.app'] });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.diagnostic.category, 'package_not_allowed');
  assert.equal(receipt.failure_category, 'script_issue');
});

test('tap uses the matched node center and records a passed case', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner);
  const receipt = await operation(runDir, {
    type: 'tap',
    request_id: 'tap-1',
    target: { by: 'text', value: 'Sign in' },
    assertion: { condition: 'visible', target: { by: 'text', value: 'Login' }, case_id: 'TC-1', title: 'Login visible', expected: 'Login title rendered' }
  }, { runner });
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.case.status, 'passed');
  assert.equal(receipt.action_completed, true);
  const tap = runner.calls.find(args => args.includes('input') && args.includes('tap'));
  assert.deepEqual(tap.slice(-2), ['300', '540']);
  const session = JSON.parse(readFileSync(resolve(runDir, 'execution/android-session.json'), 'utf8'));
  assert.equal(session.cases.length, 1);
  assert.equal(session.cases[0].status, 'passed');
});

test('a failed assertion records a failed case with failure evidence', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner);
  const receipt = await operation(runDir, {
    type: 'assert',
    request_id: 'assert-miss',
    condition: 'visible',
    target: { by: 'text', value: 'Absent element' },
    case_id: 'TC-MISS',
    title: 'Missing element',
    expected: 'Element must be visible',
    timeout_ms: 0
  }, { runner });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.case.status, 'failed');
  assert.equal(receipt.failure_category, 'needs_review');
  assert.ok(receipt.evidence_paths.some(path => path.endsWith('.logcat.txt')));
  assert.ok(existsSync(resolve(runDir, receipt.evidence_paths.find(path => path.endsWith('.failure.json')))));
});

test('an ambiguous locator blocks the action instead of guessing', async () => {
  const runDir = runDirectory();
  const ambiguousXml = UI_XML.replace('</node></hierarchy>', '<node index="4" text="Sign in" resource-id="com.example.app:id/submit2" class="android.widget.Button" package="com.example.app" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[100,600][500,680]" />\n</node></hierarchy>');
  const runner = createFakeAdb({ xml: ambiguousXml });
  await started(runDir, runner);
  const before = runner.calls.length;
  const receipt = await operation(runDir, { type: 'tap', request_id: 'tap-ambiguous', target: { by: 'text', value: 'Sign in' } }, { runner });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.diagnostic.category, 'locator_ambiguous');
  assert.equal(receipt.failure_category, 'script_issue');
  assert.equal(runner.calls.slice(before).some(args => args.includes('input') && args.includes('tap')), false);
});

test('duplicate request ids return the original receipt without replaying the action', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner);
  const value = { type: 'key', request_id: 'key-1', key: 'back' };
  const first = await operation(runDir, value, { runner });
  const second = await operation(runDir, value, { runner });
  assert.equal(first.status, 'ok');
  assert.equal(second.duplicate, true);
  assert.equal(Object.hasOwn(value, '__runner'), false);
  assert.equal(runner.calls.filter(args => args.includes('keyevent')).length, 1);
  const changed = await operation(runDir, { type: 'key', request_id: 'key-1', key: 'home' }, { runner });
  assert.equal(changed.status, 'needs_inspection');
  assert.equal(changed.do_not_replay, true);
  assert.equal(changed.duplicate, false);
  assert.equal(runner.calls.filter(args => args.includes('keyevent')).length, 1);
  assert.equal(JSON.parse(readFileSync(resolve(runDir, 'execution/android-receipts/key-1.json'), 'utf8')).status, 'ok');
});

test('an intent without a receipt yields needs_inspection and blocks the session', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner);
  const value = { type: 'tap', request_id: 'crash-1', target: { by: 'text', value: 'Sign in', match: 'exact' } };
  mkdirSync(resolve(runDir, 'execution/android-receipts'), { recursive: true });
  writeFileSync(resolve(runDir, 'execution/android-receipts/crash-1.intent.json'), JSON.stringify({ version: 1, request_id: 'crash-1', type: 'tap', request_sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'), started_at: new Date().toISOString() }));
  const before = runner.calls.length;
  const receipt = await operation(runDir, value, { runner });
  assert.equal(receipt.status, 'needs_inspection');
  assert.equal(receipt.do_not_replay, true);
  assert.equal(receipt.action_outcome, 'unknown');
  assert.equal(receipt.failure_category, 'needs_review');
  assert.equal(runner.calls.slice(before).some(args => args.includes('tap')), false);
  const session = JSON.parse(readFileSync(resolve(runDir, 'execution/android-session.json'), 'utf8'));
  assert.equal(session.status, 'blocked');
  assert.equal(session.disconnect.category, 'unknown_action_outcome');
});

test('a disconnect during a side effect is uncertain, not a product failure', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner);
  runner.failNext('input tap', { stderr: "error: device 'emulator-5554' not found" });
  const receipt = await operation(runDir, { type: 'tap', request_id: 'tap-offline', target: { by: 'text', value: 'Sign in' } }, { runner });
  assert.equal(receipt.status, 'needs_inspection');
  assert.equal(receipt.failure_category, 'environment_issue');
  assert.equal(receipt.diagnostic.category, 'device_not_found');
  assert.equal(receipt.diagnostic.action_outcome, 'unknown');
  assert.equal(receipt.do_not_replay, true);
  const session = JSON.parse(readFileSync(resolve(runDir, 'execution/android-session.json'), 'utf8'));
  assert.equal(session.status, 'blocked');
  assert.equal(session.disconnect.category, 'device_not_found');
  const blocked = await operation(runDir, { type: 'snapshot', request_id: 'snapshot-blocked' }, { runner });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.diagnostic.category, 'session_blocked');
  assert.equal(blocked.failure_category, 'environment_issue');
});

test('a blocked session resumes only with an explicit flag', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner, 'start-a');
  runner.failNext('input keyevent', { stderr: 'error: device offline' });
  const failed = await operation(runDir, { type: 'key', request_id: 'key-offline', key: 'back' }, { runner });
  assert.equal(failed.status, 'needs_inspection');
  const denied = await operation(runDir, { type: 'start', request_id: 'start-denied', package: 'com.example.app' }, { runner });
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.diagnostic.category, 'session_blocked');
  const resumed = await operation(runDir, { type: 'start', request_id: 'start-resume', package: 'com.example.app', resume_blocked: true }, { runner });
  assert.equal(resumed.status, 'ok');
  const session = JSON.parse(readFileSync(resolve(runDir, 'execution/android-session.json'), 'utf8'));
  assert.equal(session.status, 'active');
  assert.ok(session.resumed_from);
  const archived = resolve(runDir, `execution/android-sessions/${session.resumed_from}.json`);
  assert.ok(existsSync(archived));
});

test('secret input never writes the plaintext to receipts or evidence', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb({ logcat: 'I/InputDispatcher: typed Sup3rSecret into field\n' });
  await started(runDir, runner);
  const receipt = await operation(runDir, {
    type: 'input',
    request_id: 'input-secret',
    text: 'Sup3rSecret',
    secret: true,
    assertion: { condition: 'visible', target: { by: 'text', value: 'Absent' }, case_id: 'TC-SECRET', title: 'Secret input evidence', expected: 'Evidence hides the typed secret', timeout_ms: 0 }
  }, { runner });
  const receiptText = JSON.stringify(receipt);
  assert.equal(receiptText.includes('Sup3rSecret'), false);
  assert.equal(receipt.action.text, undefined);
  assert.equal(receipt.action.secret, true);
  const logcatPath = receipt.evidence_paths.find(path => path.endsWith('.logcat.txt'));
  const logcat = readFileSync(resolve(runDir, logcatPath), 'utf8');
  assert.equal(logcat.includes('Sup3rSecret'), false);
  assert.ok(logcat.includes('[REDACTED]'));
  assert.equal(scrubText('password=abc123', []), 'password=[REDACTED]');
});

test('unsupported input text is rejected before adb is called', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner);
  const before = runner.calls.length;
  const receipt = await operation(runDir, { type: 'input', request_id: 'input-cjk', text: '中文输入' }, { runner });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.diagnostic.category, 'unsupported_input');
  assert.equal(runner.calls.slice(before).some(args => args.includes('text')), false);
});

test('screenshot rejects non-PNG output and keeps other evidence', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner);
  runner.failNext('screencap', { code: 0, stdout: 'not a png' });
  runner.failNext('screencap', { code: 0, stdout: 'not a png' });
  const receipt = await operation(runDir, { type: 'screenshot', request_id: 'shot-bad' }, { runner });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.diagnostic.category, 'command_failed');
  assert.ok(receipt.missing_evidence.some(row => row.kind === 'screenshot'));
  assert.ok(receipt.evidence_paths.includes('execution/android-evidence/shot-bad.ui.xml'));
});

test('finish without assertions stays blocked, and a passing chain writes a schema-valid result', async () => {
  const blockedDir = runDirectory();
  const blockedRunner = createFakeAdb();
  await started(blockedDir, blockedRunner);
  await operation(blockedDir, { type: 'tap', request_id: 'tap-no-assert', target: { by: 'text', value: 'Sign in' } }, { runner: blockedRunner });
  const blocked = await operation(blockedDir, { type: 'finish', request_id: 'finish-blocked' }, { runner: blockedRunner });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.failure_category, 'needs_review');
  const blockedResult = JSON.parse(readFileSync(resolve(blockedDir, 'execution/android-results.json'), 'utf8'));
  assert.equal(blockedResult.status, 'blocked');
  assert.equal(blockedResult.summary.total, 0);
  assert.ok(validateResult(blockedResult), JSON.stringify(validateResult.errors));

  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner, 'start-pass');
  await operation(runDir, { type: 'assert', request_id: 'assert-pass', condition: 'visible', target: { by: 'text', value: 'Login' }, case_id: 'TC-PASS', title: 'Login visible', expected: 'Login title rendered' }, { runner });
  const finished = await operation(runDir, { type: 'finish', request_id: 'finish-pass', summary: 'synthetic chain' }, { runner });
  assert.equal(finished.status, 'ok');
  const result = JSON.parse(readFileSync(resolve(runDir, 'execution/android-results.json'), 'utf8'));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.summary, { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 });
  assert.equal(result.cases[0].status, 'passed');
  assert.equal(result.android.evidence_mode, 'real');
  assert.ok(result.evidence_index.length > 0);
  assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
  const receipt = JSON.parse(readFileSync(resolve(runDir, 'execution/android-receipts/finish-pass.json'), 'utf8'));
  assert.equal(receipt.receipt_path, 'execution/android-receipts/finish-pass.json');
});

test('duplicate case ids are rejected instead of overwriting a result', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner);
  const base = { condition: 'visible', target: { by: 'text', value: 'Login' }, case_id: 'TC-DUP', title: 'Duplicate', expected: 'Only one case row' };
  assert.equal((await operation(runDir, { type: 'assert', request_id: 'assert-dup-1', ...base }, { runner })).status, 'ok');
  const duplicate = await operation(runDir, { type: 'assert', request_id: 'assert-dup-2', ...base }, { runner });
  assert.equal(duplicate.status, 'blocked');
  assert.equal(duplicate.failure_category, 'script_issue');
  const session = JSON.parse(readFileSync(resolve(runDir, 'execution/android-session.json'), 'utf8'));
  assert.equal(session.cases.filter(row => row.case_id === 'TC-DUP').length, 1);
});

test('wait passes for a visible target and for an absent target with not_visible', async () => {
  const runDir = runDirectory();
  const runner = createFakeAdb();
  await started(runDir, runner);
  const visible = await operation(runDir, { type: 'wait', request_id: 'wait-visible', target: { by: 'text', value: 'Login' }, timeout_ms: 0 }, { runner });
  assert.equal(visible.status, 'ok');
  assert.equal(visible.observation.verdict, 'pass');
  const absent = await operation(runDir, { type: 'wait', request_id: 'wait-absent', condition: 'not_visible', target: { by: 'text', value: 'Dialog' }, timeout_ms: 0 }, { runner });
  assert.equal(absent.status, 'ok');
  const timeout = await operation(runDir, { type: 'wait', request_id: 'wait-timeout', target: { by: 'text', value: 'Never' }, timeout_ms: 0 }, { runner });
  assert.equal(timeout.status, 'blocked');
  assert.equal(timeout.failure_category, 'needs_review');
});
