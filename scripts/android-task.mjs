import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AndroidAdbError,
  adbErrorText,
  adbText,
  androidFailureCategories,
  assertAdbSuccess,
  classifyAdbFailure,
  createAdbRunner,
  ensureDeviceState,
  infrastructureCategories
} from './android-adb.mjs';
import {
  captureScreenshot,
  dumpUi,
  readAppInfo,
  readCurrentActivity,
  readScreenState,
  resolveLauncherActivity
} from './android-device.mjs';
import { describeUiNode, describeUiTree, findUiNodes } from './android-ui-tree.mjs';
import {
  androidEvidenceDirectory,
  androidReceiptDirectory,
  atomicWriteJson,
  buildEvidenceIndex,
  captureEvidence,
  relativeRunPath,
  sha256,
  scrubText,
  writeEvidenceBuffer
} from './android-evidence.mjs';
import { runAndroidPreflight } from './android-preflight.mjs';

export const androidOperations = Object.freeze([
  'doctor', 'health', 'start', 'stop', 'snapshot', 'tap', 'input', 'key', 'swipe', 'wait', 'assert', 'screenshot', 'finish'
]);

const SIDE_EFFECT = new Set(['start', 'stop', 'tap', 'input', 'key', 'swipe']);
const SESSION_REQUIRED = new Set(['stop', 'snapshot', 'tap', 'input', 'key', 'swipe', 'wait', 'assert', 'screenshot', 'finish']);
const KEY_CODES = Object.freeze({
  back: 4,
  home: 3,
  enter: 66,
  delete: 67,
  tab: 61,
  escape: 111,
  menu: 82,
  app_switch: 187,
  search: 84,
  volume_up: 24,
  volume_down: 25
});
const OPERATION_FIELDS = new Set([
  'type', 'request_id', 'run_id', 'device', 'package', 'activity', 'target', 'assertion',
  'condition', 'value', 'match', 'index', 'timeout_ms', 'poll_ms', 'text', 'secret', 'key',
  'from', 'to', 'duration_ms', 'case_id', 'title', 'expected', 'summary', 'limitations',
  'unlock', 'resume_blocked', 'screenshot', 'limit', 'appium_url', 'allow_locked'
]);
const TARGET_FIELDS = new Set(['by', 'value', 'match', 'index']);
const ASSERTION_FIELDS = new Set(['target', 'condition', 'value', 'match', 'case_id', 'title', 'expected', 'timeout_ms', 'poll_ms']);
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const ACTIVITY = /^[A-Za-z0-9_.$]+$/;
const DEVICE_SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_FILE = 'execution/android-session.json';
const RESULT_FILE = 'execution/android-results.json';

const now = () => new Date().toISOString();
const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));

function fail(message, category = 'precondition_failed') {
  throw new AndroidAdbError(category, message);
}

function requireObject(value, name, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${name} contains an unsupported field: ${key}`);
  return value;
}

function requireString(value, name, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(`${name} must be a string of ${min}-${max} characters`);
  return value;
}

function requireInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function normalizeTarget(raw) {
  const target = requireObject(raw, 'target', TARGET_FIELDS);
  if (!['text', 'id', 'desc', 'class'].includes(target.by)) fail('target.by must be text, id, desc or class');
  requireString(target.value, 'target.value', { min: 1, max: 500 });
  if (target.match !== undefined && !['exact', 'contains'].includes(target.match)) fail('target.match must be exact or contains');
  if (target.index !== undefined) requireInteger(target.index, 'target.index', { min: 0, max: 99 });
  return { by: target.by, value: target.value, match: target.match ?? 'exact', ...(target.index === undefined ? {} : { index: target.index }) };
}

function normalizeAssertion(raw, name = 'assertion', { requireCase = true } = {}) {
  const assertion = requireObject(raw, name, ASSERTION_FIELDS);
  if (!['visible', 'not_visible', 'text', 'activity'].includes(assertion.condition)) fail(`${name}.condition must be visible, not_visible, text or activity`);
  if (assertion.target !== undefined) assertion.target = normalizeTarget(assertion.target);
  if (assertion.condition === 'visible' || assertion.condition === 'not_visible') {
    if (!assertion.target) fail(`${name}.target is required for ${assertion.condition}`);
  }
  if (assertion.condition === 'text' || assertion.condition === 'activity') requireString(assertion.value, `${name}.value`, { min: 1, max: 1000 });
  if (assertion.match !== undefined && !['exact', 'contains'].includes(assertion.match)) fail(`${name}.match must be exact or contains`);
  if (requireCase) {
    requireString(assertion.case_id, `${name}.case_id`, { min: 1, max: 64 });
    if (!CASE_ID.test(assertion.case_id)) fail(`${name}.case_id contains unsupported characters`);
    requireString(assertion.title, `${name}.title`, { min: 1, max: 200 });
    requireString(assertion.expected, `${name}.expected`, { min: 1, max: 1000 });
  }
  if (assertion.timeout_ms !== undefined) requireInteger(assertion.timeout_ms, `${name}.timeout_ms`, { min: 0, max: 120000 });
  if (assertion.poll_ms !== undefined) requireInteger(assertion.poll_ms, `${name}.poll_ms`, { min: 50, max: 5000 });
  return {
    condition: assertion.condition,
    ...(assertion.target ? { target: assertion.target } : {}),
    ...(assertion.value === undefined ? {} : { value: assertion.value }),
    ...(assertion.match ? { match: assertion.match } : {}),
    ...(requireCase ? { case_id: assertion.case_id, title: assertion.title, expected: assertion.expected } : {}),
    ...(assertion.timeout_ms === undefined ? {} : { timeout_ms: assertion.timeout_ms }),
    ...(assertion.poll_ms === undefined ? {} : { poll_ms: assertion.poll_ms })
  };
}

export function validateAndroidOperation(raw) {
  const operation = requireObject(raw, 'operation', OPERATION_FIELDS);
  if (!androidOperations.includes(operation.type)) fail(`operation.type must be one of ${androidOperations.join(', ')}`);
  requireString(operation.request_id, 'operation.request_id', { min: 1, max: 80 });
  if (!REQUEST_ID.test(operation.request_id)) fail('operation.request_id contains unsupported characters');
  if (operation.run_id !== undefined) {
    requireString(operation.run_id, 'operation.run_id', { min: 1, max: 128 });
    if (!RUN_ID.test(operation.run_id)) fail('operation.run_id contains unsupported characters');
  }
  if (operation.device !== undefined) {
    requireString(operation.device, 'operation.device', { min: 1, max: 128 });
    if (!DEVICE_SERIAL.test(operation.device)) fail('operation.device contains unsupported characters');
  }
  if (operation.package !== undefined) {
    requireString(operation.package, 'operation.package', { min: 1, max: 200 });
    if (!PACKAGE.test(operation.package)) fail('operation.package is not a valid Android package name');
  }
  if (operation.activity !== undefined) {
    requireString(operation.activity, 'operation.activity', { min: 1, max: 300 });
    const parts = operation.activity.split('/');
    if (parts.length !== 2 || !PACKAGE.test(parts[0]) || !ACTIVITY.test(parts[1])) fail('operation.activity must be a full package/activity component');
  }
  if (operation.target !== undefined) operation.target = normalizeTarget(operation.target);
  if (operation.assertion !== undefined) operation.assertion = normalizeAssertion(operation.assertion);
  if (operation.timeout_ms !== undefined) requireInteger(operation.timeout_ms, 'operation.timeout_ms', { min: 0, max: 300000 });
  if (operation.poll_ms !== undefined) requireInteger(operation.poll_ms, 'operation.poll_ms', { min: 50, max: 5000 });
  if (operation.screenshot !== undefined && typeof operation.screenshot !== 'boolean') fail('operation.screenshot must be a boolean');
  if (operation.unlock !== undefined && typeof operation.unlock !== 'boolean') fail('operation.unlock must be a boolean');
  if (operation.resume_blocked !== undefined && typeof operation.resume_blocked !== 'boolean') fail('operation.resume_blocked must be a boolean');
  if (operation.secret !== undefined && typeof operation.secret !== 'boolean') fail('operation.secret must be a boolean');
  if (operation.limit !== undefined) requireInteger(operation.limit, 'operation.limit', { min: 1, max: 400 });
  if (operation.appium_url !== undefined) {
    requireString(operation.appium_url, 'operation.appium_url', { min: 1, max: 500 });
    let parsed;
    try { parsed = new URL(operation.appium_url); } catch { fail('operation.appium_url is not a valid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) fail('operation.appium_url must be http or https');
  }
  if (operation.allow_locked !== undefined && typeof operation.allow_locked !== 'boolean') fail('operation.allow_locked must be a boolean');
  if (operation.summary !== undefined) requireString(operation.summary, 'operation.summary', { min: 0, max: 2000 });
  if (operation.limitations !== undefined) {
    if (!Array.isArray(operation.limitations) || operation.limitations.length > 20) fail('operation.limitations must be an array of at most 20 strings');
    for (const item of operation.limitations) requireString(item, 'operation.limitations item', { min: 1, max: 500 });
  }
  if (['start'].includes(operation.type) && !operation.package) fail('start requires operation.package');
  if (['tap'].includes(operation.type) && !operation.target) fail('tap requires operation.target');
  if (operation.type === 'input') requireString(operation.text, 'operation.text', { min: 1, max: 2000 });
  if (operation.type === 'key') {
    requireString(operation.key, 'operation.key', { min: 1, max: 30 });
    if (!(operation.key in KEY_CODES)) fail(`operation.key must be one of ${Object.keys(KEY_CODES).join(', ')}`);
  }
  if (operation.type === 'swipe') {
    for (const name of ['from', 'to']) {
      if (!Array.isArray(operation[name]) || operation[name].length !== 2) fail(`operation.${name} must be [x, y]`);
      for (const value of operation[name]) requireInteger(value, `operation.${name} coordinate`, { min: 0, max: 100000 });
    }
    if (operation.duration_ms !== undefined) requireInteger(operation.duration_ms, 'operation.duration_ms', { min: 50, max: 5000 });
  }
  if (operation.type === 'assert') {
    const flattened = {
      condition: operation.condition,
      ...(operation.target ? { target: operation.target } : {}),
      ...(operation.value === undefined ? {} : { value: operation.value }),
      ...(operation.match ? { match: operation.match } : {}),
      ...(operation.case_id === undefined ? {} : { case_id: operation.case_id }),
      ...(operation.title === undefined ? {} : { title: operation.title }),
      ...(operation.expected === undefined ? {} : { expected: operation.expected }),
      ...(operation.timeout_ms === undefined ? {} : { timeout_ms: operation.timeout_ms }),
      ...(operation.poll_ms === undefined ? {} : { poll_ms: operation.poll_ms })
    };
    operation.assertion = normalizeAssertion(flattened, 'assert');
    for (const key of ['condition', 'value', 'match', 'case_id', 'title', 'expected']) delete operation[key];
    if (!operation.target) delete operation.target;
  }
  if (operation.type === 'wait') {
    if (operation.assertion) operation.assertion = normalizeAssertion(operation.assertion, 'wait.assertion', { requireCase: false });
    else if (operation.condition || operation.target) {
      operation.assertion = normalizeAssertion({
        condition: operation.condition ?? (operation.target ? 'visible' : undefined),
        ...(operation.target ? { target: operation.target } : {}),
        ...(operation.value === undefined ? {} : { value: operation.value }),
        ...(operation.match ? { match: operation.match } : {}),
        ...(operation.timeout_ms === undefined ? {} : { timeout_ms: operation.timeout_ms }),
        ...(operation.poll_ms === undefined ? {} : { poll_ms: operation.poll_ms })
      }, 'wait', { requireCase: false });
    } else {
      fail('wait requires target, condition or assertion');
    }
    for (const key of ['condition', 'value', 'match']) delete operation[key];
    if (!operation.target) delete operation.target;
  }
  return operation;
}

function validateInputText(text) {
  if (!/^[\x20-\x7e]+$/.test(text)) {
    throw new AndroidAdbError('unsupported_input', 'The ADB backend cannot reliably type non-ASCII or control characters. Use an Appium/ADBKeyboard input helper for this text.');
  }
  if (!/^[A-Za-z0-9 .,@_+\-/:=]+$/.test(text)) {
    throw new AndroidAdbError('unsupported_input', 'The text contains characters that adb input text could interpret as shell syntax; it was not sent.');
  }
  return text.replaceAll(' ', '%s');
}

function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Unreadable JSON at ${path}: ${error.message}`);
  }
}

function sessionPath(runDirectory) { return resolve(runDirectory, SESSION_FILE); }

function loadSession(runDirectory) {
  const session = loadJson(sessionPath(runDirectory));
  if (!session) return null;
  if (session.version !== 1 || !session.session_id) throw new Error('Invalid Android session state');
  return session;
}

function saveSession(runDirectory, session) {
  session.updated_at = now();
  atomicWriteJson(sessionPath(runDirectory), session);
}

function archiveSession(runDirectory, session) {
  const directory = resolve(runDirectory, 'execution/android-sessions');
  mkdirSync(directory, { recursive: true });
  atomicWriteJson(resolve(directory, `${session.session_id}.json`), session);
}

function createSession(operation) {
  return {
    version: 1,
    session_id: randomUUID(),
    run_id: operation.run_id ?? 'android-standalone',
    started_at: now(),
    updated_at: now(),
    status: 'active',
    backend: 'adb',
    device_serial: null,
    device: null,
    package: null,
    activity: null,
    cases: [],
    receipts: [],
    evidence: [],
    limitations: [],
    disconnect: null,
    steps: 0,
    finished_at: null,
    resumed_from: null
  };
}

function unresolvedIntents(runDirectory) {
  const directory = androidReceiptDirectory(runDirectory);
  if (!existsSync(directory)) return [];
  const receipts = new Set(readdirSync(directory).filter(name => name.endsWith('.json') && !name.endsWith('.intent.json')));
  return readdirSync(directory).filter(name => name.endsWith('.intent.json')).map(name => name.replace(/\.intent\.json$/, '')).filter(id => !receipts.has(`${id}.json`));
}

function appendEvidence(session, paths) {
  if (!session || !Array.isArray(paths)) return;
  const set = new Set(session.evidence);
  for (const path of paths) if (typeof path === 'string') set.add(path);
  session.evidence = [...set];
}

function caseHasId(session, caseId) {
  return session.cases.some(row => row.case_id === caseId);
}

const ENVIRONMENT_ONLY_CATEGORIES = new Set(['device_locked', 'device_not_booted', 'package_not_installed', 'launcher_unresolved', 'session_blocked']);
const REVIEW_CATEGORIES = new Set(['app_error', 'app_focus_timeout']);

function actionOutcome(error, actionStarted) {
  const category = error.category ?? 'command_failed';
  const infrastructure = infrastructureCategories.has(category);
  const environment = infrastructure || ENVIRONMENT_ONLY_CATEGORIES.has(category);
  const status = actionStarted && infrastructure ? 'needs_inspection' : 'blocked';
  return {
    category,
    infrastructure,
    status,
    failure_category: environment ? 'environment_issue' : REVIEW_CATEGORIES.has(category) ? 'needs_review' : 'script_issue',
    action_outcome: actionStarted ? (infrastructure ? 'unknown' : 'completed_with_error') : 'not_executed',
    do_not_replay: actionStarted && infrastructure
  };
}

function operationHash(operation) {
  const { __runner, ...rest } = operation;
  return sha256(JSON.stringify(rest));
}

function intentRecord(operation) {
  return {
    version: 1,
    request_id: operation.request_id,
    type: operation.type,
    request_sha256: operationHash(operation),
    session_id: null,
    started_at: now()
  };
}

function publish({ runDirectory, operation, receipt, session }) {
  const receiptPath = resolve(androidReceiptDirectory(runDirectory), `${operation.request_id}.json`);
  receipt.receipt_path = relativeRunPath(runDirectory, receiptPath);
  receipt.request_sha256 = operationHash(operation);
  if (session) {
    session.steps += 1;
    session.receipts.push({ request_id: operation.request_id, type: operation.type, status: receipt.status, at: receipt.at, receipt_path: receipt.receipt_path });
    appendEvidence(session, [...(receipt.evidence_paths ?? []), receipt.receipt_path]);
    if (receipt.case) {
      if (caseHasId(session, receipt.case.case_id)) fail(`Case ${receipt.case.case_id} already exists in this session`, 'duplicate_case_id');
      session.cases.push(receipt.case);
    }
    if (receipt.disconnect) session.disconnect = receipt.disconnect;
    if (receipt.session_status) session.status = receipt.session_status;
    saveSession(runDirectory, session);
  }
  atomicWriteJson(receiptPath, receipt);
  return receipt;
}

function receiptBase({ operation, session, status, reason = null, failureCategory = 'none', extra = {} }) {
  return {
    version: 1,
    request_id: operation.request_id,
    type: operation.type,
    status,
    at: now(),
    session_id: session?.session_id ?? null,
    session_status: session?.status ?? null,
    device_serial: session?.device_serial ?? null,
    package: session?.package ?? null,
    reason,
    failure_category: failureCategory,
    evidence_paths: [],
    ...extra
  };
}

async function failureReceipt({ runDirectory, operation, session, serial, error, phase, actionStarted, secrets = [] }) {
  const outcome = actionOutcome(error, actionStarted);
  let evidence = null;
  if (serial) {
    evidence = await captureEvidence({
      runner: operation.__runner,
      serial,
      requestId: operation.request_id,
      runDirectory,
      secrets,
      kind: outcome.status === 'needs_inspection' ? 'failure' : 'failure',
      phase,
      error,
      includeScreenshot: true,
      includeUi: true,
      includeLogcat: true,
      includeDevice: true
    }).catch(captureError => ({ evidence_path: null, files: [], missing: [{ kind: 'capture', reason: captureError.message }] }));
  }
  if (session && (outcome.infrastructure || outcome.status === 'needs_inspection')) {
    session.status = 'blocked';
    session.disconnect = { at: now(), category: outcome.category, phase, request_id: operation.request_id, action_outcome: outcome.action_outcome };
  }
  const evidencePaths = evidence?.files?.map(file => file.path) ?? [];
  if (evidence?.evidence_path) evidencePaths.push(evidence.evidence_path);
  return receiptBase({
    operation,
    session,
    status: outcome.status,
    reason: scrubText(error.message, secrets).slice(0, 1000),
    failureCategory: outcome.failure_category,
    extra: {
      diagnostic: { category: outcome.category, phase, action_outcome: outcome.action_outcome },
      do_not_replay: outcome.do_not_replay,
      evidence_paths: [...new Set(evidencePaths)],
      missing_evidence: evidence?.missing ?? []
    }
  });
}

function currentSerial(session, operation) {
  return session?.device_serial ?? operation.device ?? null;
}

function requireSession(session, operation) {
  if (!session) fail(`No active Android session; start an app first (request ${operation.request_id})`, 'no_active_session');
  if (session.status === 'blocked') fail('The Android session is blocked after an infrastructure or uncertain action; inspect evidence and start a new session explicitly', 'session_blocked');
  if (session.status === 'finished') fail('The Android session is finished; start a new session', 'no_active_session');
  if (operation.package && session.package && operation.package !== session.package) fail(`Operation package ${operation.package} differs from session package ${session.package}`);
  if (operation.device && session.device_serial && operation.device !== session.device_serial) fail(`Operation device ${operation.device} differs from session device ${session.device_serial}`);
}

async function observeEnvironment(runner, serial) {
  const [activity, screen] = await Promise.all([readCurrentActivity(runner, serial), readScreenState(runner, serial)]);
  return { activity, screen };
}

function matchText(actual, expected, mode = 'exact') {
  return mode === 'contains' ? String(actual).includes(expected) : String(actual) === expected;
}

function checkCondition(root, activity, assertion) {
  const mode = assertion.match ?? 'exact';
  if (assertion.condition === 'activity') {
    if (!activity?.component) return { verdict: 'blocked', reason: 'activity_unavailable', actual: null, timeout_verdict: 'blocked' };
    const matched = String(activity.component).includes(assertion.value);
    return {
      verdict: matched ? 'pass' : 'retry',
      timeout_verdict: 'fail',
      reason: matched ? 'activity_matched' : 'activity_mismatch',
      actual: activity.component,
      activity
    };
  }
  if (assertion.condition === 'text' && !assertion.target) {
    const nodes = findUiNodes(root, { by: 'text', value: assertion.value, match: mode, index: null });
    if (nodes.total) return { verdict: 'pass', reason: 'text_matched', actual: nodes.matches[0].text, node: describeUiNode(nodes.matches[0]), activity: activity?.component ?? null };
    return { verdict: 'retry', timeout_verdict: 'fail', reason: 'text_mismatch', actual: null, activity: activity?.component ?? null };
  }
  const found = findUiNodes(root, assertion.target);
  if (found.ambiguous) return { verdict: 'blocked', reason: 'locator_ambiguous', actual: `${found.total} matching nodes`, total: found.total, activity: activity?.component ?? null };
  if (assertion.condition === 'not_visible') {
    if (!found.total) return { verdict: 'pass', reason: 'not_visible', actual: 'no matching node', activity: activity?.component ?? null };
    return { verdict: 'retry', timeout_verdict: 'fail', reason: 'element_present', actual: describeUiNode(found.matches[0]), activity: activity?.component ?? null };
  }
  if (!found.selected) return { verdict: 'retry', timeout_verdict: 'fail', reason: 'target_not_found', actual: null, locator: found.locator, activity: activity?.component ?? null };
  const node = found.selected;
  if (assertion.condition === 'visible') {
    const visible = (node.bounds?.width ?? 0) > 0 && (node.bounds?.height ?? 0) > 0;
    if (visible) return { verdict: 'pass', reason: 'visible', actual: describeUiNode(node), node: describeUiNode(node), activity: activity?.component ?? null };
    return { verdict: 'retry', timeout_verdict: 'fail', reason: 'zero_bounds', actual: describeUiNode(node), activity: activity?.component ?? null };
  }
  const matched = matchText(node.text, assertion.value, mode);
  return {
    verdict: matched ? 'pass' : 'retry',
    timeout_verdict: 'fail',
    reason: matched ? 'text_matched' : 'text_mismatch',
    actual: node.text,
    node: describeUiNode(node),
    locator: found.locator,
    activity: activity?.component ?? null
  };
}

async function evaluateCondition({ runner, serial, requestId, assertion, timeoutMs = 5000, pollMs = 400 }) {
  const startedAt = Date.now();
  let latest = null;
  for (;;) {
    const [ui, activity] = await Promise.allSettled([
      dumpUi(runner, serial, requestId),
      readCurrentActivity(runner, serial)
    ]);
    if (ui.status === 'rejected') throw ui.reason;
    if (activity.status === 'rejected' && assertion.condition === 'activity') throw activity.reason;
    latest = checkCondition(ui.value.root, activity.status === 'fulfilled' ? activity.value : null, assertion);
    latest.checked_at = now();
    latest.elapsed_ms = Date.now() - startedAt;
    if (latest.verdict !== 'retry') return latest;
    if (Date.now() - startedAt >= timeoutMs) {
      return { ...latest, verdict: latest.timeout_verdict ?? 'fail', reason: latest.reason ?? 'timeout', timed_out: true };
    }
    await sleep(Math.min(pollMs, Math.max(50, timeoutMs - (Date.now() - startedAt))));
  }
}

async function recordAssertion({ runDirectory, operation, session, serial, assertion, secrets = [], actionCompleted = null }) {
  if (caseHasId(session, assertion.case_id)) fail(`Case ${assertion.case_id} already exists in this session`, 'duplicate_case_id');
  const timeoutMs = assertion.timeout_ms ?? 5000;
  const pollMs = assertion.poll_ms ?? 400;
  const verdict = await evaluateCondition({
    runner: operation.__runner,
    serial,
    requestId: operation.request_id,
    assertion,
    timeoutMs,
    pollMs
  });
  const status = verdict.verdict === 'pass' ? 'passed' : verdict.verdict === 'blocked' ? 'blocked' : 'failed';
  const failureCategory = status === 'passed' ? 'none' : status === 'failed' ? 'needs_review' : (verdict.reason === 'locator_ambiguous' ? 'script_issue' : 'environment_issue');
  const evidence = await captureEvidence({
    runner: operation.__runner,
    serial,
    requestId: operation.request_id,
    runDirectory,
    secrets,
    kind: status === 'passed' ? 'observation' : 'failure',
    phase: 'assert',
    error: status === 'passed' ? null : new AndroidAdbError(status === 'failed' ? 'precondition_failed' : 'command_failed', `${verdict.reason}: ${JSON.stringify(verdict.actual)}`),
    includeScreenshot: true,
    includeUi: true,
    includeLogcat: status !== 'passed',
    includeDevice: true
  }).catch(error => ({ files: [], missing: [{ kind: 'capture', reason: error.message }], evidence_path: null }));
  const observation = {
    version: 1,
    request_id: operation.request_id,
    case_id: assertion.case_id,
    condition: assertion.condition,
    target: assertion.target ?? null,
    expected: assertion.expected,
    comparison_value: assertion.value ?? null,
    status,
    verdict_reason: verdict.reason,
    actual: verdict.actual ?? null,
    activity: verdict.activity ?? null,
    timed_out: verdict.timed_out === true,
    elapsed_ms: verdict.elapsed_ms,
    checked_at: verdict.checked_at,
    action_completed: actionCompleted,
    device_serial: serial,
    evidence_mode: 'real',
    evidence_paths: [...new Set([...(evidence.files ?? []).map(file => file.path), ...(evidence.evidence_path ? [evidence.evidence_path] : [])])],
    missing_evidence: evidence.missing ?? []
  };
  const observationPath = resolve(androidEvidenceDirectory(runDirectory), `${operation.request_id}.observation.json`);
  atomicWriteJson(observationPath, observation);
  observation.evidence_paths.push(relativeRunPath(runDirectory, observationPath));
  const row = {
    case_id: assertion.case_id,
    title: assertion.title,
    expected: assertion.expected,
    status,
    failure_category: failureCategory,
    actual_result: `${assertion.condition}: ${typeof verdict.actual === 'object' ? JSON.stringify(verdict.actual) : verdict.actual ?? 'no observation'}; ${verdict.reason}`,
    evidence_paths: observation.evidence_paths,
    evidence_confidence: status === 'passed' ? 'strong' : 'medium',
    conclusion_confidence: status === 'failed' ? 'medium' : status === 'blocked' ? 'low' : 'strong',
    evidence_mode: 'real',
    verification_scope: { layer: 'android_ui', does_not_prove: ['backend persistence', 'other devices or OS versions', 'performance'] },
    checked_condition: {
      condition: assertion.condition,
      target: assertion.target ?? null,
      value: assertion.value ?? null,
      match: assertion.match ?? 'exact'
    },
    verdict_reason: verdict.reason,
    timing: { elapsed_ms: verdict.elapsed_ms, timed_out: verdict.timed_out === true }
  };
  return { verdict, observation, case: row, evidence };
}

async function captureActionEvidence({ runDirectory, operation, serial, secrets = [], includeScreenshot = true, includeUi = true }) {
  return captureEvidence({
    runner: operation.__runner,
    serial,
    requestId: operation.request_id,
    runDirectory,
    secrets,
    kind: 'observation',
    includeScreenshot,
    includeUi,
    includeLogcat: false,
    includeDevice: true
  });
}

function evidencePaths(evidence) {
  return [...new Set([...(evidence?.files ?? []).map(file => file.path), ...(evidence?.evidence_path ? [evidence.evidence_path] : [])])];
}

async function actionWithOptionalAssertion({ runDirectory, operation, session, serial, secrets = [], actionSummary, actionCompleted, assertion, captureOptions = {} }) {
  let assertionResult = null;
  let evidence = null;
  if (assertion) {
    try {
      assertionResult = await recordAssertion({ runDirectory, operation, session, serial, assertion, secrets, actionCompleted });
    } catch (error) {
      if (error instanceof AndroidAdbError) error.details = { ...error.details, action_started: true };
      throw error;
    }
    evidence = assertionResult.evidence;
  } else {
    try {
      evidence = await captureActionEvidence({ runDirectory, operation, serial, secrets, includeScreenshot: true, includeUi: true, ...captureOptions });
    } catch (error) {
      if (error instanceof AndroidAdbError) error.details = { ...error.details, action_started: true };
      throw error;
    }
  }
  const status = assertionResult ? assertionResult.case.status : 'ok';
  const receipt = receiptBase({
    operation,
    session,
    status: status === 'passed' ? 'ok' : status,
    reason: assertionResult ? assertionResult.verdict.reason : null,
    failureCategory: assertionResult ? assertionResult.case.failure_category : 'none',
    extra: {
      action: actionSummary,
      action_completed: actionCompleted,
      assertion: assertionResult?.observation ?? null,
      case: assertionResult?.case ?? null,
      evidence_paths: evidencePaths(evidence),
      missing_evidence: evidence?.missing ?? [],
      ...(assertionResult ? {} : { assertion_guidance: 'The action succeeded but no assertion was recorded; it is not a passing test case. Do not replay it to obtain evidence.' })
    }
  });
  return { receipt, evidence };
}

async function handlerDoctor({ runDirectory, operation, runner, options }) {
  const preflight = await runAndroidPreflight({
    runner,
    device: operation.device,
    packageName: operation.package,
    sdkRoot: options.sdkRoot,
    checkJava: options.checkJava !== false,
    appiumUrl: operation.appium_url,
    allowLocked: operation.allow_locked === true,
    javaProbe: options.javaProbe,
    appiumProbe: options.appiumProbe
  });
  const directory = androidEvidenceDirectory(runDirectory);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${operation.request_id}.preflight.json`);
  atomicWriteJson(path, preflight);
  const receipt = receiptBase({
    operation,
    session: null,
    status: preflight.status === 'ready' ? 'ok' : 'blocked',
    reason: preflight.status === 'ready' ? null : preflight.blockers.map(row => `${row.id}:${row.reason}`).join('; '),
    failureCategory: preflight.status === 'ready' ? 'none' : 'environment_issue',
    extra: {
      backend: 'adb',
      preflight,
      evidence_paths: [relativeRunPath(runDirectory, path)],
      device_serial: preflight.device?.serial ?? null
    }
  });
  return { receipt, session: null };
}

async function handlerHealth({ runDirectory, operation, runner, session }) {
  if (session?.device_serial && operation.device && operation.device !== session.device_serial) {
    fail(`Operation device ${operation.device} differs from session device ${session.device_serial}`);
  }
  const serial = currentSerial(session, operation);
  if (!serial) fail('No device serial is known; run doctor first', 'device_not_found');
  await ensureDeviceState(runner, serial);
  const facts = await observeEnvironment(runner, serial);
  const receipt = receiptBase({
    operation,
    session,
    status: 'ok',
    extra: {
      health: 'online',
      device_serial: serial,
      activity: facts.activity,
      screen: facts.screen,
      session_status: session?.status ?? null,
      next_action: session?.status === 'blocked' ? 'inspect blocked-session evidence, then explicitly start a new session with resume_blocked=true' : null
    }
  });
  return { receipt, session };
}

async function handlerStart({ runDirectory, operation, runner, session, options }) {
  if (options.allowedPackages?.length && !options.allowedPackages.includes(operation.package)) {
    fail(`Package ${operation.package} is outside the allowed package list`, 'package_not_allowed');
  }
  let previousSessionId = null;
  let previousSerial = null;
  let resumed = false;
  if (session?.status === 'blocked') {
    if (!operation.resume_blocked) fail('The previous Android session is blocked; inspect its evidence and pass resume_blocked=true only after verifying device state', 'session_blocked');
    const unresolved = unresolvedIntents(runDirectory).filter(id => id !== operation.request_id);
    if (unresolved.length) fail(`Unresolved side-effect intents exist (${unresolved.join(', ')}); inspect them before starting a new session`, 'precondition_failed');
    previousSessionId = session.session_id;
    previousSerial = session.device_serial;
    archiveSession(runDirectory, session);
    session = null;
    resumed = true;
  } else if (session?.status === 'finished') {
    previousSerial = session.device_serial;
    archiveSession(runDirectory, session);
    session = null;
  } else if (session) {
    if (session.package && session.package !== operation.package) fail(`Session package ${session.package} differs from requested package ${operation.package}`);
    if (session.device_serial && operation.device && session.device_serial !== operation.device) fail('Requested device differs from the active session device');
  }
  const preflight = await runAndroidPreflight({
    runner,
    device: operation.device ?? session?.device_serial ?? previousSerial,
    packageName: operation.package,
    sdkRoot: options.sdkRoot,
    checkJava: false,
    allowLocked: operation.unlock === true,
    appiumUrl: null
  });
  if (preflight.status !== 'ready') {
    const blocker = preflight.blockers[0];
    const category = androidFailureCategories.includes(blocker?.reason) ? blocker.reason : 'command_failed';
    throw new AndroidAdbError(category, `Environment is not ready: ${preflight.blockers.map(row => `${row.id}:${row.reason}`).join('; ')}`);
  }
  const serial = preflight.device.serial;
  if (preflight.device.screen?.locked === true) {
    if (!operation.unlock) throw new AndroidAdbError('device_locked', 'The device is locked; pass unlock=true to wake and dismiss the keyguard explicitly');
    await runner.run(['-s', serial, 'shell', 'input', 'keyevent', '224'], { timeout: 10000 });
    await runner.run(['-s', serial, 'shell', 'wm', 'dismiss-keyguard'], { timeout: 10000 });
    const screen = await readScreenState(runner, serial);
    if (screen.locked !== false) throw new AndroidAdbError('device_locked', 'The device is still locked after the explicit unlock attempt');
  }
  const component = operation.activity ?? await resolveLauncherActivity(runner, serial, operation.package);
  if (!component) throw new AndroidAdbError('launcher_unresolved', `Could not resolve a launcher activity for ${operation.package}; pass operation.activity explicitly`);
  const started = await runner.run(['-s', serial, 'shell', 'am', 'start', '-W', '-n', component], { timeout: operation.timeout_ms ?? 30000 });
  const startText = `${adbText(started)}\n${adbErrorText(started)}`;
  if (started.code !== 0 || started.timedOut || /Error:|Exception/i.test(startText) && !/Status:\s*ok/i.test(startText)) {
    const category = classifyAdbFailure(started, 'am start');
    const actionStarted = !/Activity not started|does not exist|Unable to find explicit activity/i.test(startText);
    throw new AndroidAdbError(category === 'command_failed' ? 'app_error' : category, `App launch failed: ${startText.trim().slice(0, 600)}`, { action_started: actionStarted });
  }
  if (!session) {
    session = createSession(operation);
    if (resumed) session.resumed_from = previousSessionId;
  }
  const timeoutMs = operation.timeout_ms ?? 15000;
  const deadline = Date.now() + timeoutMs;
  let activity = null;
  let focused = false;
  try {
    while (Date.now() <= deadline) {
      activity = await readCurrentActivity(runner, serial);
      if (activity.package_name === operation.package) { focused = true; break; }
      await sleep(400);
    }
  } catch (error) {
    if (error instanceof AndroidAdbError) error.details = { ...error.details, action_started: true };
    throw error;
  }
  session.device_serial = serial;
  session.device = { serial, model: preflight.device.model, api_level: preflight.device.api_level, android_release: preflight.device.android_release };
  session.package = operation.package;
  session.activity = activity?.component ?? component;
  session.status = 'active';
  const evidence = await captureActionEvidence({ runDirectory, operation, serial, includeScreenshot: true, includeUi: true });
  return {
    receipt: receiptBase({
      operation,
      session,
      status: focused ? 'ok' : 'blocked',
      reason: focused ? null : 'app_focus_timeout',
      failureCategory: focused ? 'none' : 'needs_review',
      extra: {
        backend: 'adb',
        device_serial: serial,
        capability: 'launch',
        resolved_activity: component,
        current_activity: activity,
        focused,
        launch_output: startText.trim().slice(0, 400),
        evidence_paths: evidencePaths(evidence),
        missing_evidence: evidence.missing ?? []
      }
    }),
    session
  };
}

async function handlerStop({ runDirectory, operation, runner, session }) {
  const serial = requireActiveSerial(session);
  const packageName = operation.package ?? session.package;
  if (!packageName) fail('stop requires a package or an active app session');
  await ensureDeviceState(runner, serial);
  const result = await runner.run(['-s', serial, 'shell', 'am', 'force-stop', packageName], { timeout: 20000 });
  assertAdbSuccess(result, 'am force-stop', { actionStarted: true });
  return {
    receipt: receiptBase({
      operation,
      session,
      status: 'ok',
      extra: { action: { type: 'stop', package: packageName }, action_completed: true, evidence_paths: [] }
    }),
    session
  };
}

function requireActiveSerial(session) {
  if (!session?.device_serial) fail('The session has no device serial', 'device_not_found');
  return session.device_serial;
}

async function handlerSnapshot({ runDirectory, operation, runner, session }) {
  const serial = requireActiveSerial(session);
  const { root, xml } = await dumpUi(runner, serial, operation.request_id);
  const activity = await readCurrentActivity(runner, serial);
  const evidence = await captureActionEvidence({
    runDirectory,
    operation,
    serial,
    includeScreenshot: operation.screenshot !== false,
    includeUi: false
  });
  const uiPath = resolve(androidEvidenceDirectory(runDirectory), `${operation.request_id}.ui.xml`);
  writeEvidenceBuffer(uiPath, Buffer.from(xml, 'utf8'));
  const paths = [...evidencePaths(evidence), relativeRunPath(runDirectory, uiPath)];
  return {
    receipt: receiptBase({
      operation,
      session,
      status: 'ok',
      extra: {
        activity,
        ui: describeUiTree(root, { limit: operation.limit ?? 120 }),
        evidence_paths: paths,
        missing_evidence: evidence.missing ?? []
      }
    }),
    session
  };
}

async function locateTarget(runner, serial, operation, target) {
  const { root } = await dumpUi(runner, serial, operation.request_id);
  const found = findUiNodes(root, target);
  if (found.ambiguous) throw new AndroidAdbError('locator_ambiguous', `Locator matched ${found.total} nodes; add an index or a more specific locator`);
  if (!found.selected) throw new AndroidAdbError('locator_not_found', `No node matched ${target.by}=${target.value}`);
  if (!found.selected.bounds?.width || !found.selected.bounds?.height) throw new AndroidAdbError('locator_not_found', 'The matched node has zero bounds and cannot be tapped');
  return found.selected;
}

async function handlerTap({ runDirectory, operation, runner, session }) {
  const serial = requireActiveSerial(session);
  await ensureDeviceState(runner, serial);
  const node = await locateTarget(runner, serial, operation, operation.target);
  const { center_x: x, center_y: y } = node.bounds;
  const result = await runner.run(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], { timeout: 15000 });
  assertAdbSuccess(result, 'input tap', { actionStarted: true });
  const output = await actionWithOptionalAssertion({
    runDirectory,
    operation,
    session,
    serial,
    actionSummary: { type: 'tap', target: operation.target, matched: describeUiNode(node), x, y },
    actionCompleted: true,
    assertion: operation.assertion
  });
  return { receipt: output.receipt, session };
}

async function handlerInput({ runDirectory, operation, runner, session }) {
  const serial = requireActiveSerial(session);
  const escaped = validateInputText(operation.text);
  const secrets = operation.secret ? [operation.text] : [];
  await ensureDeviceState(runner, serial);
  let targetNode = null;
  if (operation.target) {
    targetNode = await locateTarget(runner, serial, operation, operation.target);
    const tap = await runner.run(['-s', serial, 'shell', 'input', 'tap', String(targetNode.bounds.center_x), String(targetNode.bounds.center_y)], { timeout: 15000 });
    assertAdbSuccess(tap, 'input tap (target focus)', { actionStarted: true });
  }
  const result = await runner.run(['-s', serial, 'shell', 'input', 'text', escaped], { timeout: 20000 });
  assertAdbSuccess(result, 'input text', { actionStarted: true });
  const output = await actionWithOptionalAssertion({
    runDirectory,
    operation,
    session,
    serial,
    secrets,
    actionSummary: {
      type: 'input',
      target: operation.target ?? null,
      matched: targetNode ? describeUiNode(targetNode) : null,
      secret: operation.secret === true,
      text_length: [...operation.text].length,
      text_sha256: sha256(operation.text),
      ...(operation.secret ? {} : { text: operation.text })
    },
    actionCompleted: true,
    assertion: operation.assertion,
    captureOptions: operation.secret ? { includeScreenshot: false, includeUi: false } : {}
  });
  if (operation.secret) {
    output.receipt.evidence_note = 'Screenshot and UI evidence may contain the typed value; secret text is not written to receipts or logs.';
    output.receipt.diagnostic = { ...(output.receipt.diagnostic ?? {}), category: 'sensitive_input', phase: 'input' };
  }
  return { receipt: output.receipt, session };
}

async function handlerKey({ runDirectory, operation, runner, session }) {
  const serial = requireActiveSerial(session);
  await ensureDeviceState(runner, serial);
  const code = KEY_CODES[operation.key];
  const result = await runner.run(['-s', serial, 'shell', 'input', 'keyevent', String(code)], { timeout: 15000 });
  assertAdbSuccess(result, 'input keyevent', { actionStarted: true });
  const output = await actionWithOptionalAssertion({
    runDirectory,
    operation,
    session,
    serial,
    actionSummary: { type: 'key', key: operation.key, keycode: code },
    actionCompleted: true,
    assertion: operation.assertion
  });
  return { receipt: output.receipt, session };
}

async function handlerSwipe({ runDirectory, operation, runner, session }) {
  const serial = requireActiveSerial(session);
  await ensureDeviceState(runner, serial);
  const duration = operation.duration_ms ?? 300;
  const args = ['-s', serial, 'shell', 'input', 'swipe', String(operation.from[0]), String(operation.from[1]), String(operation.to[0]), String(operation.to[1]), String(duration)];
  const result = await runner.run(args, { timeout: 20000 });
  assertAdbSuccess(result, 'input swipe', { actionStarted: true });
  const output = await actionWithOptionalAssertion({
    runDirectory,
    operation,
    session,
    serial,
    actionSummary: { type: 'swipe', from: operation.from, to: operation.to, duration_ms: duration },
    actionCompleted: true,
    assertion: operation.assertion
  });
  return { receipt: output.receipt, session };
}

async function handlerWait({ runDirectory, operation, runner, session }) {
  const serial = requireActiveSerial(session);
  const assertion = operation.assertion ?? (operation.target ? {
    condition: 'visible',
    target: operation.target,
    case_id: `wait-${operation.request_id}`.slice(0, 64).replace(/[^A-Za-z0-9._-]/g, '-'),
    title: 'Wait condition',
    expected: 'Target becomes visible',
    timeout_ms: operation.timeout_ms ?? 10000,
    poll_ms: operation.poll_ms ?? 500
  } : null);
  if (!assertion) fail('wait requires target or assertion');
  const verdict = await evaluateCondition({
    runner,
    serial,
    requestId: operation.request_id,
    assertion: { ...assertion, timeout_ms: operation.timeout_ms ?? assertion.timeout_ms ?? 10000, poll_ms: operation.poll_ms ?? assertion.poll_ms ?? 500 },
    timeoutMs: operation.timeout_ms ?? assertion.timeout_ms ?? 10000,
    pollMs: operation.poll_ms ?? assertion.poll_ms ?? 500
  });
  const evidence = await captureEvidence({
    runner,
    serial,
    requestId: operation.request_id,
    runDirectory,
    kind: verdict.verdict === 'pass' ? 'observation' : 'failure',
    phase: 'wait',
    includeScreenshot: verdict.verdict !== 'pass',
    includeUi: true,
    includeLogcat: verdict.verdict !== 'pass',
    includeDevice: true
  }).catch(error => ({ files: [], missing: [{ kind: 'capture', reason: error.message }], evidence_path: null }));
  return {
    receipt: receiptBase({
      operation,
      session,
      status: verdict.verdict === 'pass' ? 'ok' : 'blocked',
      reason: verdict.verdict === 'pass' ? null : `wait_timeout:${verdict.reason}`,
      failureCategory: verdict.verdict === 'pass' ? 'none' : 'needs_review',
      extra: {
        wait: { condition: assertion.condition, target: assertion.target ?? null, value: assertion.value ?? null },
        observation: verdict,
        evidence_paths: evidencePaths(evidence),
        missing_evidence: evidence?.missing ?? []
      }
    }),
    session
  };
}

async function handlerAssert({ runDirectory, operation, runner, session }) {
  const serial = requireActiveSerial(session);
  const result = await recordAssertion({
    runDirectory,
    operation,
    session,
    serial,
    assertion: operation.assertion,
    actionCompleted: null
  });
  return {
    receipt: receiptBase({
      operation,
      session,
      status: result.case.status === 'passed' ? 'ok' : result.case.status,
      reason: result.verdict.reason,
      failureCategory: result.case.failure_category,
      extra: {
        assertion: result.observation,
        case: result.case,
        evidence_paths: result.case.evidence_paths,
        missing_evidence: result.observation.missing_evidence
      }
    }),
    session
  };
}

async function handlerScreenshot({ runDirectory, operation, runner, session }) {
  const serial = requireActiveSerial(session);
  const buffer = await captureScreenshot(runner, serial);
  const directory = androidEvidenceDirectory(runDirectory);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${operation.request_id}.png`);
  writeEvidenceBuffer(path, buffer);
  const activity = await readCurrentActivity(runner, serial);
  return {
    receipt: receiptBase({
      operation,
      session,
      status: 'ok',
      extra: {
        activity,
        screenshot: { path: relativeRunPath(runDirectory, path), bytes: buffer.length, sha256: sha256(buffer) },
        evidence_paths: [relativeRunPath(runDirectory, path)]
      }
    }),
    session
  };
}

function summarizeCases(cases) {
  const summary = { total: cases.length, passed: 0, failed: 0, skipped: 0, blocked: 0 };
  for (const row of cases) {
    const status = row.status === 'pass' ? 'passed' : row.status === 'fail' ? 'failed' : row.status;
    if (status !== 'total' && Object.hasOwn(summary, status)) summary[status] += 1;
  }
  return summary;
}

async function handlerFinish({ runDirectory, operation, runner, session }) {
  if (!session) fail('No Android session exists to finish', 'no_active_session');
  const serial = session.device_serial;
  let finalEvidence = null;
  if (serial) {
    finalEvidence = await captureEvidence({
      runner,
      serial,
      requestId: operation.request_id,
      runDirectory,
      kind: 'observation',
      includeScreenshot: operation.screenshot === true,
      includeUi: false,
      includeLogcat: false,
      includeDevice: true
    }).catch(error => ({ files: [], missing: [{ kind: 'capture', reason: error.message }], evidence_path: null }));
  }
  const summary = summarizeCases(session.cases);
  const limitations = [...new Set([
    ...session.limitations,
    ...(operation.limitations ?? []),
    'ADB backend only; no Appium session was created.',
    'Assertions verify UI state only; backend persistence and other devices are not proven.'
  ])];
  let status;
  let blockReason = null;
  let failureCategory = 'none';
  if (session.status === 'blocked') {
    status = 'blocked';
    failureCategory = 'environment_issue';
    blockReason = session.disconnect ? `Session blocked after ${session.disconnect.category}` : 'Session was blocked before finish';
  } else if (!summary.total) {
    status = 'blocked';
    failureCategory = 'needs_review';
    blockReason = 'No assertion was recorded; observations and actions are not passing test cases';
  } else if (summary.failed) {
    status = 'failed';
    failureCategory = 'needs_review';
  } else if (summary.blocked) {
    status = 'blocked';
    failureCategory = 'environment_issue';
    blockReason = 'One or more assertions were blocked';
  } else {
    status = 'completed';
  }
  session.status = 'finished';
  session.finished_at = now();
  session.limitations = limitations;
  appendEvidence(session, evidencePaths(finalEvidence));
  const evidenceIndex = buildEvidenceIndex(runDirectory, session);
  const result = {
    run_id: session.run_id,
    invocation_id: session.session_id,
    status,
    started_at: session.started_at,
    finished_at: session.finished_at,
    ...(blockReason ? { block_reason: blockReason } : {}),
    summary,
    cases: session.cases,
    asset_refs: [],
    android: {
      version: 1,
      backend: 'adb',
      evidence_mode: 'real',
      device_serial: session.device_serial,
      device: session.device,
      package: session.package,
      activity: session.activity,
      steps: session.steps,
      summary: operation.summary ?? null,
      limitations,
      disconnect: session.disconnect,
      evidence_paths: evidenceIndex.map(row => row.path)
    },
    evidence_index: evidenceIndex
  };
  const resultPath = resolve(runDirectory, RESULT_FILE);
  atomicWriteJson(resultPath, result);
  const paths = [...evidencePaths(finalEvidence), relativeRunPath(runDirectory, resultPath)];
  return {
    receipt: receiptBase({
      operation,
      session,
      status: status === 'completed' ? 'ok' : status,
      reason: blockReason,
      failureCategory,
      extra: {
        summary,
        result_path: relativeRunPath(runDirectory, resultPath),
        limitations,
        disconnect: session.disconnect,
        evidence_paths: paths,
        missing_evidence: finalEvidence?.missing ?? [],
        session_id: session.session_id
      }
    }),
    session
  };
}

const handlers = {
  doctor: handlerDoctor,
  health: handlerHealth,
  start: handlerStart,
  stop: handlerStop,
  snapshot: handlerSnapshot,
  tap: handlerTap,
  input: handlerInput,
  key: handlerKey,
  swipe: handlerSwipe,
  wait: handlerWait,
  assert: handlerAssert,
  screenshot: handlerScreenshot,
  finish: handlerFinish
};

export async function runAndroidOperation({
  runDirectory,
  operation: rawOperation,
  runner,
  allowedPackages = [],
  sdkRoot,
  checkJava = true,
  javaProbe,
  appiumProbe
} = {}) {
  if (typeof runDirectory !== 'string' || !runDirectory) throw new Error('runDirectory is required');
  const directory = resolve(runDirectory);
  if (!existsSync(directory)) throw new Error(`runDirectory does not exist: ${directory}`);
  const operation = validateAndroidOperation(rawOperation);
  const androidRunner = runner ?? createAdbRunner();
  const receiptDirectory = androidReceiptDirectory(directory);
  mkdirSync(receiptDirectory, { recursive: true });
  const receiptPath = resolve(receiptDirectory, `${operation.request_id}.json`);
  const existing = loadJson(receiptPath);
  const intentPath = resolve(receiptDirectory, `${operation.request_id}.intent.json`);
  if (existing) {
    const savedHash = existing.request_sha256 ?? loadJson(intentPath)?.request_sha256;
    if (savedHash === operationHash(operation)) return { ...existing, duplicate: true };
    return {
      ...existing,
      status: 'needs_inspection',
      reason: 'This request id already has a receipt for different or unverifiable operation content. Inspect the original receipt; do not replay the action.',
      failure_category: 'needs_review',
      do_not_replay: true,
      action_outcome: 'unknown',
      duplicate: false
    };
  }
  if (SIDE_EFFECT.has(operation.type)) {
    if (existsSync(intentPath)) {
      const intent = loadJson(intentPath);
      if (intent?.request_sha256 !== operationHash(operation)) {
        const receipt = receiptBase({
          operation,
          session: loadSession(directory),
          status: 'needs_inspection',
          reason: 'An intent with the same request id but different content already exists; inspect it and use a new request id only for a genuinely new action.',
          failureCategory: 'needs_review',
          extra: { do_not_replay: true, intent }
        });
        receipt.request_sha256 = operationHash(operation);
        atomicWriteJson(receiptPath, receipt);
        return receipt;
      }
      const session = loadSession(directory);
      if (session) { session.status = 'blocked'; session.disconnect = { at: now(), category: 'unknown_action_outcome', request_id: operation.request_id }; saveSession(directory, session); }
      const receipt = receiptBase({
        operation,
        session,
        status: 'needs_inspection',
        reason: 'A prior intent for this request id has no receipt; the action outcome is unknown. Do not replay it.',
        failureCategory: 'needs_review',
        extra: { do_not_replay: true, intent, action_outcome: 'unknown' }
      });
      receipt.request_sha256 = operationHash(operation);
      atomicWriteJson(receiptPath, receipt);
      return receipt;
    }
    atomicWriteJson(intentPath, intentRecord(operation));
  }
  operation.__runner = androidRunner;
  let session = operation.type === 'doctor' ? null : loadSession(directory);
  try {
    if (SESSION_REQUIRED.has(operation.type)) requireSession(session, operation);
    const result = await handlers[operation.type]({ runDirectory: directory, operation, runner: androidRunner, session, options: { allowedPackages, sdkRoot, checkJava, javaProbe, appiumProbe } });
    return publish({ runDirectory: directory, operation, receipt: result.receipt, session: result.session });
  } catch (error) {
    const serial = session?.device_serial ?? operation.device ?? null;
    const actionStarted = error instanceof AndroidAdbError && error.details?.action_started === true;
    let receipt;
    if (error instanceof AndroidAdbError && error.category === 'duplicate_case_id') {
      receipt = receiptBase({
        operation,
        session,
        status: 'blocked',
        reason: error.message,
        failureCategory: 'script_issue',
        extra: { diagnostic: { category: error.category, phase: operation.type }, operation_started: false }
      });
    } else {
      receipt = await failureReceipt({
        runDirectory: directory,
        operation,
        session,
        serial,
        error: error instanceof AndroidAdbError ? error : new AndroidAdbError('command_failed', error.message),
        phase: operation.type,
        actionStarted,
        secrets: operation.secret ? [operation.text] : []
      });
    }
    return publish({ runDirectory: directory, operation, receipt, session });
  } finally {
    delete operation.__runner;
  }
}
