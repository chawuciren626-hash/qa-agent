import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MiniprogramError,
  createDefaultBackend,
  detectAutomator,
  detectDevtoolsCli,
  readProjectConfig
} from './miniprogram-devtools.mjs';
import {
  atomicWriteJson,
  buildEvidenceIndex,
  fileEntry,
  miniprogramEvidenceDirectory,
  miniprogramReceiptDirectory,
  relativeRunPath,
  scrubText,
  scrubValue,
  sha256,
  writeEvidenceBuffer
} from './miniprogram-evidence.mjs';

export const miniprogramOperations = Object.freeze([
  'doctor', 'start', 'stop', 'snapshot', 'tap', 'input', 'wait', 'assert', 'screenshot', 'finish'
]);

const SIDE_EFFECT = new Set(['start', 'stop', 'tap', 'input']);
const SESSION_REQUIRED = new Set(['stop', 'snapshot', 'tap', 'input', 'wait', 'assert', 'screenshot', 'finish']);
const OPERATION_FIELDS = new Set([
  'type', 'request_id', 'run_id', 'target', 'assertion', 'target_kind', 'project_dir', 'devtools_cli', 'port',
  'condition', 'value', 'match', 'path', 'case_id', 'title', 'expected', 'timeout_ms', 'poll_ms',
  'text', 'secret', 'screenshot', 'summary', 'limitations', 'resume_blocked'
]);
const TARGET_FIELDS = new Set(['by', 'value', 'match', 'index']);
const ASSERTION_FIELDS = new Set(['condition', 'target', 'value', 'match', 'path', 'case_id', 'title', 'expected', 'timeout_ms', 'poll_ms']);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_FILE = 'execution/miniprogram-session.json';
const SESSION_ARCHIVE = 'execution/miniprogram-sessions';
const RESULT_FILE = 'execution/miniprogram-results.json';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CONDITIONS = new Set(['visible', 'not_visible', 'text', 'page', 'data']);
const ENVIRONMENT_CATEGORIES = new Set([
  'devtools_not_found', 'automator_not_installed', 'launch_timeout', 'connection_lost', 'devtools_closed',
  'session_blocked', 'screenshot_failed'
]);
const REVIEW_CATEGORIES = new Set(['app_error', 'compile_error']);

const now = () => new Date().toISOString();
const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));

function fail(category, message, details = {}) {
  throw new MiniprogramError(category, message, details);
}

function requireObject(value, name, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_argument', `${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('invalid_argument', `${name} contains an unsupported field: ${key}`);
  return value;
}

function requireString(value, name, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail('invalid_argument', `${name} must be a string of ${min}-${max} characters`);
  return value;
}

function requireInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_argument', `${name} must be an integer between ${min} and ${max}`);
  return value;
}

function normalizeTarget(raw) {
  const target = requireObject(raw, 'target', TARGET_FIELDS);
  if (!['id', 'class', 'text'].includes(target.by)) fail('invalid_argument', 'target.by must be id, class or text');
  requireString(target.value, 'target.value', { min: 1, max: 300 });
  if (target.match !== undefined && !['exact', 'contains'].includes(target.match)) fail('invalid_argument', 'target.match must be exact or contains');
  if (target.index !== undefined) requireInteger(target.index, 'target.index', { min: 0, max: 99 });
  return {
    by: target.by,
    value: target.value,
    ...(target.match === undefined ? {} : { match: target.match }),
    ...(target.index === undefined ? {} : { index: target.index })
  };
}

function normalizeAssertion(raw, name = 'assertion', { requireCase = true } = {}) {
  const assertion = requireObject(raw, name, ASSERTION_FIELDS);
  if (!CONDITIONS.has(assertion.condition)) fail('invalid_argument', `${name}.condition must be visible, not_visible, text, page or data`);
  const result = {
    condition: assertion.condition,
    ...(assertion.target === undefined ? {} : { target: normalizeTarget(assertion.target) }),
    ...(assertion.value === undefined ? {} : { value: assertion.value }),
    ...(assertion.match === undefined ? {} : { match: assertion.match }),
    ...(assertion.path === undefined ? {} : { path: assertion.path }),
    ...(assertion.timeout_ms === undefined ? {} : { timeout_ms: assertion.timeout_ms }),
    ...(assertion.poll_ms === undefined ? {} : { poll_ms: assertion.poll_ms })
  };
  if (!['exact', 'contains'].includes(result.match ?? 'exact')) fail('invalid_argument', `${name}.match must be exact or contains`);
  if (result.timeout_ms !== undefined) requireInteger(result.timeout_ms, `${name}.timeout_ms`, { min: 0, max: 300000 });
  if (result.poll_ms !== undefined) requireInteger(result.poll_ms, `${name}.poll_ms`, { min: 50, max: 5000 });
  if (result.value !== undefined && !['string', 'number', 'boolean'].includes(typeof result.value)) fail('invalid_argument', `${name}.value must be a string, number or boolean`);
  if (typeof result.value === 'string' && result.value.length > 2000) fail('invalid_argument', `${name}.value is too long`);
  if (result.path !== undefined) requireString(result.path, `${name}.path`, { min: 1, max: 300 });
  if (requireCase) {
    requireString(assertion.case_id, `${name}.case_id`, { min: 1, max: 64 });
    if (!CASE_ID.test(assertion.case_id)) fail('invalid_argument', `${name}.case_id contains unsupported characters`);
    requireString(assertion.title, `${name}.title`, { min: 1, max: 500 });
    requireString(assertion.expected, `${name}.expected`, { min: 1, max: 1000 });
    result.case_id = assertion.case_id;
    result.title = assertion.title;
    result.expected = assertion.expected;
  }
  if (['visible', 'not_visible'].includes(result.condition) && !result.target) fail('invalid_argument', `${name}.${result.condition} requires target`);
  if (result.condition === 'text' && (!result.target || result.value === undefined)) fail('invalid_argument', `${name}.text requires target and value`);
  if (result.condition === 'page' && result.value === undefined) fail('invalid_argument', `${name}.page requires value`);
  if (result.condition === 'data' && (!result.path || result.value === undefined)) fail('invalid_argument', `${name}.data requires path and value`);
  return result;
}

export function validateMiniprogramOperation(raw) {
  const operation = requireObject(raw, 'operation', OPERATION_FIELDS);
  if (!miniprogramOperations.includes(operation.type)) fail('invalid_argument', `operation.type must be one of ${miniprogramOperations.join(', ')}`);
  requireString(operation.request_id, 'operation.request_id', { min: 1, max: 80 });
  if (!REQUEST_ID.test(operation.request_id)) fail('invalid_argument', 'operation.request_id contains unsupported characters');
  if (operation.run_id !== undefined) {
    requireString(operation.run_id, 'operation.run_id', { min: 1, max: 128 });
    if (!RUN_ID.test(operation.run_id)) fail('invalid_argument', 'operation.run_id contains unsupported characters');
  }
  if (operation.target_kind !== undefined && !['devtools', 'device'].includes(operation.target_kind)) fail('invalid_argument', 'operation.target_kind must be devtools or device');
  if (operation.project_dir !== undefined) requireString(operation.project_dir, 'operation.project_dir', { min: 1, max: 1000 });
  if (operation.devtools_cli !== undefined) requireString(operation.devtools_cli, 'operation.devtools_cli', { min: 1, max: 1000 });
  if (operation.port !== undefined) requireInteger(operation.port, 'operation.port', { min: 1, max: 65535 });
  if (operation.timeout_ms !== undefined) requireInteger(operation.timeout_ms, 'operation.timeout_ms', { min: 0, max: 300000 });
  if (operation.poll_ms !== undefined) requireInteger(operation.poll_ms, 'operation.poll_ms', { min: 50, max: 5000 });
  if (operation.screenshot !== undefined && typeof operation.screenshot !== 'boolean') fail('invalid_argument', 'operation.screenshot must be a boolean');
  if (operation.secret !== undefined && typeof operation.secret !== 'boolean') fail('invalid_argument', 'operation.secret must be a boolean');
  if (operation.resume_blocked !== undefined && typeof operation.resume_blocked !== 'boolean') fail('invalid_argument', 'operation.resume_blocked must be a boolean');
  if (operation.target !== undefined) operation.target = normalizeTarget(operation.target);
  if (operation.assertion !== undefined) operation.assertion = normalizeAssertion(operation.assertion, 'operation.assertion');
  if (operation.summary !== undefined) requireString(operation.summary, 'operation.summary', { min: 0, max: 2000 });
  if (operation.limitations !== undefined) {
    if (!Array.isArray(operation.limitations) || operation.limitations.length > 20) fail('invalid_argument', 'operation.limitations must be an array of at most 20 strings');
    for (const item of operation.limitations) requireString(item, 'operation.limitations item', { min: 1, max: 500 });
  }
  if (operation.type === 'tap' && !operation.target) fail('invalid_argument', 'tap requires operation.target');
  if (operation.type === 'input') {
    requireString(operation.text, 'operation.text', { min: 1, max: 2000 });
    if (!operation.target) fail('invalid_argument', 'input requires operation.target');
  }
  if (operation.type === 'screenshot' && operation.screenshot !== undefined) fail('invalid_argument', 'screenshot does not accept operation.screenshot');
  if (operation.type === 'assert') {
    operation.assertion = normalizeAssertion({
      condition: operation.condition,
      ...(operation.target === undefined ? {} : { target: operation.target }),
      ...(operation.value === undefined ? {} : { value: operation.value }),
      ...(operation.match === undefined ? {} : { match: operation.match }),
      ...(operation.path === undefined ? {} : { path: operation.path }),
      ...(operation.case_id === undefined ? {} : { case_id: operation.case_id }),
      ...(operation.title === undefined ? {} : { title: operation.title }),
      ...(operation.expected === undefined ? {} : { expected: operation.expected }),
      ...(operation.timeout_ms === undefined ? {} : { timeout_ms: operation.timeout_ms }),
      ...(operation.poll_ms === undefined ? {} : { poll_ms: operation.poll_ms })
    }, 'assert');
    for (const key of ['condition', 'target', 'value', 'match', 'path', 'case_id', 'title', 'expected']) delete operation[key];
  }
  if (operation.type === 'wait') {
    const source = operation.assertion ?? (operation.condition || operation.target
      ? {
          condition: operation.condition ?? (operation.target ? 'visible' : undefined),
          ...(operation.target === undefined ? {} : { target: operation.target }),
          ...(operation.value === undefined ? {} : { value: operation.value }),
          ...(operation.match === undefined ? {} : { match: operation.match }),
          ...(operation.path === undefined ? {} : { path: operation.path }),
          ...(operation.timeout_ms === undefined ? {} : { timeout_ms: operation.timeout_ms }),
          ...(operation.poll_ms === undefined ? {} : { poll_ms: operation.poll_ms })
        }
      : null);
    if (!source) fail('invalid_argument', 'wait requires operation.assertion, target or condition');
    operation.assertion = normalizeAssertion(source, 'wait.assertion', { requireCase: false });
    for (const key of ['condition', 'target', 'value', 'match', 'path']) delete operation[key];
  }
  return operation;
}

function operationHash(operation) {
  return sha256(JSON.stringify(operation));
}

function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Unreadable JSON at ${path}: ${error.message}`);
  }
}

function sessionPath(runDirectory) { return resolve(runDirectory, SESSION_FILE); }

function loadSession(runDirectory) {
  const session = loadJson(sessionPath(runDirectory));
  if (!session) return null;
  if (session.version !== 1 || !session.session_id) throw new Error('Invalid miniprogram session state');
  return session;
}

function saveSession(runDirectory, session) {
  session.updated_at = now();
  atomicWriteJson(sessionPath(runDirectory), session);
}

function archiveSession(runDirectory, session) {
  const directory = resolve(runDirectory, SESSION_ARCHIVE);
  mkdirSync(directory, { recursive: true });
  atomicWriteJson(resolve(directory, `${session.session_id}.json`), session);
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

function actionOutcome(error, actionStarted) {
  const category = error.category ?? 'command_failed';
  const environment = ENVIRONMENT_CATEGORIES.has(category);
  const review = REVIEW_CATEGORIES.has(category);
  const status = environment && actionStarted ? 'needs_inspection' : review ? 'failed' : 'blocked';
  return {
    category,
    environment,
    status,
    failure_category: environment ? 'environment_issue' : review ? 'needs_review' : 'script_issue',
    action_outcome: actionStarted ? (environment ? 'unknown' : 'completed_with_error') : 'not_executed',
    do_not_replay: environment && actionStarted
  };
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
  const receiptPath = resolve(miniprogramReceiptDirectory(runDirectory), `${operation.request_id}.json`);
  receipt.receipt_path = relativeRunPath(runDirectory, receiptPath);
  receipt.request_sha256 = operationHash(operation);
  if (session) {
    session.steps += 1;
    session.receipts.push({ request_id: operation.request_id, type: operation.type, status: receipt.status, at: receipt.at, receipt_path: receipt.receipt_path });
    appendEvidence(session, [...(receipt.evidence_paths ?? []), receipt.receipt_path]);
    if (receipt.case) {
      if (caseHasId(session, receipt.case.case_id)) fail('duplicate_case_id', `Case ${receipt.case.case_id} already exists in this session`);
      session.cases.push(receipt.case);
    }
    if (receipt.disconnect) session.disconnect = receipt.disconnect;
    if (receipt.session_status) session.status = receipt.session_status;
    saveSession(runDirectory, session);
  }
  atomicWriteJson(receiptPath, receipt);
  return receipt;
}

function receiptBase({ operation, session, status, reason = null, failureCategory = 'none', synthetic = null, extra = {} }) {
  return {
    version: 1,
    request_id: operation.request_id,
    type: operation.type,
    status,
    at: now(),
    session_id: session?.session_id ?? null,
    session_status: session?.status ?? null,
    target_kind: session?.target_kind ?? operation.target_kind ?? 'devtools',
    synthetic: session ? session.synthetic === true : synthetic,
    appid_masked: session?.project?.appid_masked ?? null,
    reason,
    failure_category: failureCategory,
    evidence_paths: [],
    ...extra
  };
}

async function safeCurrentPage(miniProgram) {
  try {
    const page = await miniProgram.currentPage();
    if (!page) fail('page_not_found', 'The developer tools returned no current page; inspect the compiled app before acting.');
    return page;
  } catch (error) {
    if (error instanceof MiniprogramError) throw error;
    fail('page_not_found', `Unable to read the current mini program page: ${error.message}`);
  }
}

async function safePageData(page) {
  try { return await page.data(); }
  catch { return null; }
}

async function safeElementText(element) {
  try { return await element.text(); }
  catch { return null; }
}

function selectorFor(target) {
  if (target.by === 'id') return `#${target.value}`;
  if (target.by === 'class') return `.${target.value}`;
  return null;
}

async function elementsByTag(page, tag) {
  try { return await page.$$(tag); }
  catch { return []; }
}

async function findElements(page, target) {
  if (target.by !== 'text') {
    const selector = selectorFor(target);
    try { return await page.$$(selector); }
    catch { return []; }
  }
  const found = [];
  const seen = new Set();
  for (const tag of ['view', 'text', 'button']) {
    for (const element of await elementsByTag(page, tag)) {
      if (seen.has(element)) continue;
      seen.add(element);
      const text = await safeElementText(element);
      if (typeof text !== 'string') continue;
      const matched = target.match === 'contains' ? text.includes(target.value) : text === target.value;
      if (matched) found.push(element);
    }
  }
  return found;
}

async function pickElement(page, target) {
  const elements = await findElements(page, target);
  if (!elements.length) return null;
  if (target.index !== undefined) return elements[target.index] ?? null;
  if (elements.length > 1) fail('locator_ambiguous', `Target ${JSON.stringify(target)} matched ${elements.length} elements; add target.index or use a unique id.`);
  return elements[0];
}

async function describeElement(element, target, index, secrets = []) {
  return {
    selector: selectorFor(target) ?? `text=${target.value}`,
    by: target.by,
    value: scrubText(target.value, secrets),
    index,
    tag: element?.tagName ?? null,
    text: scrubText(await safeElementText(element), secrets).slice(0, 500)
  };
}

async function describePage(page, secrets = []) {
  const rows = [];
  const seen = new Set();
  for (const tag of ['view', 'text', 'button', 'input']) {
    for (const element of (await elementsByTag(page, tag)).slice(0, 30)) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (rows.length >= 60) break;
      rows.push({ tag, text: scrubText(await safeElementText(element), secrets).slice(0, 300) });
    }
  }
  return rows;
}

function readDataPath(data, path) {
  const segments = String(path).match(/[^.[\]]+/g) ?? [];
  let value = data;
  for (const segment of segments) {
    if (value === null || value === undefined) return undefined;
    value = value[segment];
  }
  return value;
}

function sameValue(actual, expected, match = 'exact') {
  if (match === 'contains') return String(actual).includes(String(expected));
  return actual === expected || String(actual) === String(expected);
}

function boundedSnapshotData(data, secrets) {
  if (data === null || data === undefined) return null;
  let raw;
  try { raw = JSON.stringify(data); }
  catch { return { available: false, reason: 'data_not_serializable' }; }
  if (raw.length > 20000) return { truncated: true, bytes: raw.length, preview: scrubText(raw.slice(0, 2000), secrets) };
  try {
    const parsed = JSON.parse(raw);
    const scrub = value => {
      if (typeof value === 'string') return scrubText(value, secrets);
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
      return value;
    };
    return scrub(parsed);
  } catch { return { available: false, reason: 'data_not_serializable' }; }
}

async function captureScreenshot({ runDirectory, requestId, miniProgram }) {
  const path = resolve(miniprogramEvidenceDirectory(runDirectory), `${requestId}.png`);
  let returned;
  try { returned = await miniProgram.screenshot({ path }); }
  catch (error) { fail('screenshot_failed', `Screenshot failed: ${error.message}`); }
  let buffer = null;
  if (Buffer.isBuffer(returned)) buffer = returned;
  else if (typeof returned === 'string' && existsSync(returned)) buffer = readFileSync(returned);
  if (!buffer && existsSync(path)) buffer = readFileSync(path);
  if (!buffer) fail('screenshot_invalid', 'Screenshot returned no image data.');
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) fail('screenshot_invalid', 'Screenshot output is not a PNG image.');
  if (!existsSync(path)) writeEvidenceBuffer(path, buffer);
  return fileEntry(runDirectory, path, 'screenshot');
}

async function captureSnapshot({ runDirectory, requestId, page, secrets = [] }) {
  const path = resolve(miniprogramEvidenceDirectory(runDirectory), `${requestId}.snapshot.json`);
  const data = await safePageData(page);
  const elements = page ? await describePage(page, secrets) : [];
  const record = {
    version: 1,
    request_id: requestId,
    captured_at: now(),
    page_path: page?.path ?? null,
    evidence_mode: 'devtools',
    data: boundedSnapshotData(data, secrets),
    elements,
    element_count: elements.length
  };
  atomicWriteJson(path, record);
  return { path: relativeRunPath(runDirectory, path), page_path: record.page_path, data, elements, element_count: elements.length };
}

async function captureFailureEvidence({ runDirectory, requestId, miniProgram, page, secrets = [] }) {
  const paths = [];
  const missing = [];
  if (miniProgram) {
    try { paths.push((await captureScreenshot({ runDirectory, requestId, miniProgram })).path); }
    catch (error) { missing.push({ kind: 'screenshot', reason: scrubText(error.message, secrets).slice(0, 500) }); }
  }
  if (page) {
    try { paths.push((await captureSnapshot({ runDirectory, requestId, page, secrets })).path); }
    catch (error) { missing.push({ kind: 'snapshot', reason: scrubText(error.message, secrets).slice(0, 500) }); }
  }
  return { paths: [...new Set(paths)], missing };
}

async function failureReceipt({ runDirectory, operation, session, error, phase, actionStarted, secrets = [] }) {
  const outcome = actionOutcome(error, actionStarted);
  const details = error.details ?? {};
  let evidence = { paths: [], missing: [] };
  if (details.miniProgram || details.page) {
    evidence = await captureFailureEvidence({
      runDirectory,
      requestId: operation.request_id,
      miniProgram: details.miniProgram,
      page: details.page,
      secrets
    }).catch(captureError => ({ paths: [], missing: [{ kind: 'capture', reason: captureError.message }] }));
  }
  if (session && (outcome.environment || outcome.status === 'needs_inspection')) {
    session.status = 'blocked';
    session.disconnect = { at: now(), category: outcome.category, phase, request_id: operation.request_id, action_outcome: outcome.action_outcome };
    session.updated_at = now();
  }
  return receiptBase({
    operation,
    session,
    status: outcome.status,
    reason: scrubText(error.message, secrets).slice(0, 1000),
    failureCategory: outcome.failure_category,
    extra: {
      diagnostic: { category: outcome.category, phase, action_outcome: outcome.action_outcome },
      do_not_replay: outcome.do_not_replay,
      evidence_paths: evidence.paths,
      missing_evidence: evidence.missing,
      ...(session?.disconnect ? { disconnect: session.disconnect } : {})
    }
  });
}

function requireSession(session, operation) {
  if (!session) fail('no_active_session', `No mini program session exists; start one first (request ${operation.request_id}).`);
  if (session.status === 'blocked' && operation.type !== 'finish') fail('session_blocked', 'The mini program session is blocked after an infrastructure or uncertain action; inspect evidence and start a new session explicitly with resume_blocked=true. Finish is allowed to record the blocked outcome.');
  if (session.status === 'finished') fail('no_active_session', 'The mini program session is finished; start a new session.');
  if (operation.target_kind && operation.target_kind !== session.target_kind) fail('invalid_argument', `Operation target_kind ${operation.target_kind} differs from session target_kind ${session.target_kind}`);
}

async function evaluateCondition(miniProgram, assertion, secrets = []) {
  const page = await safeCurrentPage(miniProgram);
  const condition = assertion.condition;
  if (condition === 'page') {
    const actual = page.path ?? null;
    const passed = actual !== null && sameValue(actual, assertion.value, assertion.match);
    return { status: passed ? 'passed' : 'failed', actual, reason: passed ? 'page_matched' : 'page_mismatch', failure_category: passed ? 'none' : 'needs_review' };
  }
  if (condition === 'data') {
    const data = await safePageData(page);
    if (data === null) return { status: 'blocked', actual: null, reason: 'data_unavailable', failure_category: 'environment_issue' };
    const actual = readDataPath(data, assertion.path);
    if (actual === undefined) return { status: 'blocked', actual: null, reason: 'data_path_missing', failure_category: 'script_issue' };
    const passed = sameValue(actual, assertion.value, assertion.match);
    return { status: passed ? 'passed' : 'failed', actual, reason: passed ? 'data_matched' : 'data_mismatch', failure_category: passed ? 'none' : 'needs_review' };
  }
  const element = await pickElement(page, assertion.target);
  if (condition === 'visible') {
    const actual = Boolean(element);
    return { status: actual ? 'passed' : 'blocked', actual, reason: actual ? 'visible' : 'locator_not_found', failure_category: actual ? 'none' : 'script_issue' };
  }
  if (condition === 'not_visible') {
    const actual = Boolean(element);
    return { status: actual ? 'failed' : 'passed', actual, reason: actual ? 'still_visible' : 'not_visible', failure_category: actual ? 'needs_review' : 'none' };
  }
  if (!element) return { status: 'blocked', actual: null, reason: 'locator_not_found', failure_category: 'script_issue' };
  const actual = await safeElementText(element);
  if (actual === null) return { status: 'blocked', actual: null, reason: 'text_unavailable', failure_category: 'environment_issue' };
  const passed = sameValue(actual, assertion.value, assertion.match);
  return { status: passed ? 'passed' : 'failed', actual, reason: passed ? 'text_matched' : 'text_mismatch', failure_category: passed ? 'none' : 'needs_review' };
}

async function pollCondition(miniProgram, assertion, { timeoutMs, pollMs = 250, secrets = [] }) {
  const started = Date.now();
  let last = null;
  while (true) {
    try {
      last = await evaluateCondition(miniProgram, assertion, secrets);
      last.elapsed_ms = Date.now() - started;
      if (last.status === 'passed') return { ...last, timed_out: false };
    } catch (error) {
      if (error instanceof MiniprogramError && error.category === 'locator_ambiguous') throw error;
      last = { status: 'blocked', actual: null, reason: error.category ?? 'observation_failed', failure_category: 'environment_issue', elapsed_ms: Date.now() - started };
    }
    if (Date.now() - started >= timeoutMs) break;
    await sleep(pollMs);
  }
  return {
    ...last,
    status: last?.status === 'failed' ? 'failed' : 'blocked',
    reason: last?.status === 'failed' ? last.reason : (last?.reason ?? 'assertion_timeout'),
    timed_out: true,
    elapsed_ms: Date.now() - started
  };
}

async function recordObservation({ runDirectory, requestId, miniProgram, page, secrets = [], verdict, phase }) {
  const paths = [];
  const missing = [];
  try { paths.push((await captureScreenshot({ runDirectory, requestId, miniProgram })).path); }
  catch (error) { missing.push({ kind: 'screenshot', reason: scrubText(error.message, secrets).slice(0, 500) }); }
  try { paths.push((await captureSnapshot({ runDirectory, requestId, page, secrets })).path); }
  catch (error) { missing.push({ kind: 'snapshot', reason: scrubText(error.message, secrets).slice(0, 500) }); }
  const observation = {
    version: 1,
    request_id: requestId,
    phase,
    captured_at: now(),
    evidence_mode: 'devtools',
    status: verdict.status,
    reason: verdict.reason,
    actual: scrubValue(verdict.actual ?? null, secrets),
    timed_out: verdict.timed_out === true,
    elapsed_ms: verdict.elapsed_ms ?? 0,
    evidence_paths: paths,
    missing_evidence: missing
  };
  const observationPath = resolve(miniprogramEvidenceDirectory(runDirectory), `${requestId}.observation.json`);
  atomicWriteJson(observationPath, observation);
  const observationRelative = relativeRunPath(runDirectory, observationPath);
  return { observation, observation_path: observationRelative, evidence_paths: [...paths, observationRelative], missing };
}

async function recordAssertion({ runDirectory, requestId, miniProgram, page, assertion, secrets = [] }) {
  if (!assertion.case_id) fail('invalid_argument', 'Assertion requires case_id, title and expected.');
  const verdict = await pollCondition(miniProgram, assertion, {
    timeoutMs: assertion.timeout_ms ?? 5000,
    pollMs: assertion.poll_ms ?? 250,
    secrets
  });
  const observed = await recordObservation({
    runDirectory,
    requestId,
    miniProgram,
    page,
    secrets,
    verdict,
    phase: 'assert'
  });
  const actual = scrubValue(verdict.actual ?? null, secrets);
  const caseRow = {
    case_id: assertion.case_id,
    title: scrubText(assertion.title, secrets),
    expected: scrubText(assertion.expected, secrets),
    status: verdict.status,
    failure_category: verdict.failure_category ?? (verdict.status === 'passed' ? 'none' : verdict.status === 'failed' ? 'needs_review' : 'environment_issue'),
    actual_result: `${assertion.condition}: ${typeof actual === 'object' ? JSON.stringify(actual) : actual ?? 'no observation'}; ${verdict.reason}`,
    evidence_paths: observed.evidence_paths,
    evidence_confidence: verdict.status === 'passed' ? 'strong' : 'medium',
    conclusion_confidence: verdict.status === 'failed' ? 'medium' : verdict.status === 'blocked' ? 'low' : 'strong',
    evidence_mode: 'devtools',
    verification_scope: {
      layer: 'miniprogram_devtools_ui',
      does_not_prove: ['real-device behavior', 'backend persistence', 'network services', 'performance']
    },
    checked_condition: scrubValue({
      condition: assertion.condition,
      target: assertion.target ?? null,
      value: assertion.value ?? null,
      match: assertion.match ?? 'exact',
      path: assertion.path ?? null
    }, secrets),
    verdict_reason: verdict.reason,
    timing: { elapsed_ms: verdict.elapsed_ms, timed_out: verdict.timed_out === true }
  };
  return { verdict, actual, case: caseRow, evidence_paths: observed.evidence_paths, missing: observed.missing };
}

function launchFailure(error) {
  const message = String(error.message ?? error);
  if (/timeout|timed out/i.test(message)) return new MiniprogramError('launch_timeout', message, { action_started: true });
  if (/ENOENT|not found|cli/i.test(message)) return new MiniprogramError('devtools_not_found', message, { action_started: false });
  if (/compile|编译|syntax|wxml|wxs/i.test(message)) return new MiniprogramError('compile_error', message, { action_started: true });
  return new MiniprogramError('app_error', message, { action_started: true });
}

function imagePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

async function handlerDoctor({ operation, projectDirectory, devtoolsCli, backendProvided, targetKind }) {
  const blockers = [];
  const warnings = [];
  let project = null;
  try { project = readProjectConfig(operation.project_dir ?? projectDirectory); }
  catch (error) {
    blockers.push({ id: error.category ?? 'project_invalid', category: 'script_issue', reason: error.message, next_action: 'Correct --project/project.config.json.' });
  }
  const cli = detectDevtoolsCli({ explicit: operation.devtools_cli ?? devtoolsCli });
  if (!cli.found) blockers.push({
    id: 'devtools_not_found',
    category: 'environment_issue',
    reason: 'WeChat DevTools CLI was not found. Set WECHAT_DEVTOOLS_CLI or pass --devtools-cli.',
    next_action: 'Install WeChat DevTools and point the adapter at cli.bat/cli. No product action was executed.'
  });
  const automator = backendProvided ? { available: true, source: 'injected_backend' } : detectAutomator();
  if (!automator.available) blockers.push({
    id: 'automator_not_installed',
    category: 'environment_issue',
    reason: 'The miniprogram-automator package is not installed in this project.',
    next_action: automator.install_hint
  });
  if (project?.synthetic_appid) warnings.push({ id: 'synthetic_appid', reason: 'The fixture uses touristappid; this is not a production mini program identity.' });
  const kind = operation.target_kind ?? targetKind ?? 'devtools';
  if (kind === 'device') blockers.push({
    id: 'real_device_not_supported',
    category: 'environment_issue',
    reason: 'This adapter only controls WeChat DevTools. Real-device execution needs a separate device backend and is not claimed here.',
    next_action: 'Use target_kind=devtools, or add a real-device backend through the public integration process.'
  });
  const status = blockers.length ? 'blocked' : 'ready';
  const record = {
    version: 1,
    request_id: operation.request_id,
    checked_at: now(),
    status,
    target_kind: kind,
    real_device: false,
    project: project ? {
      directory: project.directory,
      appid_masked: project.appid_masked,
      projectname: project.projectname,
      synthetic_appid: project.synthetic_appid,
      config_path: project.config_path,
      app_path: project.app_path
    } : null,
    devtools_cli: { path: cli.path, found: cli.found, source: cli.source, candidates: cli.candidates ?? [] },
    automator,
    synthetic_backend: backendProvided,
    blockers,
    warnings,
    scope: 'Environment and project preflight only; it does not launch DevTools or prove any business path.'
  };
  return { record, blockers, warnings, kind };
}

async function handlerStart({ runDirectory, operation, projectDirectory, devtoolsCli, port, getBackend, session }) {
  const kind = operation.target_kind ?? 'devtools';
  if (kind === 'device') fail('real_device_not_supported', 'Real-device execution is not implemented by the DevTools backend; no device was opened.');
  if (session) {
    if (session.status === 'active') fail('already_started', 'This run already has an active mini program session; stop it or use a new run.');
    if (session.status === 'blocked' && operation.resume_blocked !== true) {
      fail('session_blocked', 'The previous mini program session is blocked; inspect evidence and pass resume_blocked=true only after confirming DevTools is usable.');
    }
    if (session.status === 'finished' && operation.resume_blocked !== true) fail('no_active_session', 'The previous mini program session is finished; use resume_blocked=true for a new session.');
    archiveSession(runDirectory, session);
  }
  const project = readProjectConfig(operation.project_dir ?? projectDirectory);
  const cli = detectDevtoolsCli({ explicit: operation.devtools_cli ?? devtoolsCli });
  if (!cli.found) fail('devtools_not_found', `WeChat DevTools CLI was not found${cli.path ? ` at ${cli.path}` : ''}. Set WECHAT_DEVTOOLS_CLI or pass --devtools-cli.`);
  const backend = await getBackend();
  let launched;
  try {
    launched = await backend.launch({
      cliPath: cli.path,
      projectPath: project.directory,
      port: operation.port ?? port ?? 9420,
      timeoutMs: operation.timeout_ms ?? 20000
    });
  } catch (error) {
    throw launchFailure(error);
  }
  const miniProgram = launched.miniProgram;
  let page = null;
  try {
    const deadline = Date.now() + (operation.timeout_ms ?? 20000);
    while (Date.now() < deadline) {
      page = await miniProgram.currentPage();
      if (page) break;
      await sleep(250);
    }
    if (!page) fail('app_error', 'DevTools launched but no page became current; inspect compile/runtime errors.', { action_started: true, miniProgram });
  } catch (error) {
    if (!(error instanceof MiniprogramError)) {
      throw new MiniprogramError('app_error', `DevTools launched but the page could not be read: ${error.message}`, { action_started: true, miniProgram });
    }
    error.details = { ...error.details, miniProgram };
    throw error;
  }
  const next = {
    version: 1,
    session_id: randomUUID(),
    run_id: operation.run_id ?? session?.run_id ?? 'miniprogram-standalone',
    started_at: now(),
    updated_at: now(),
    status: 'active',
    backend: backend.kind ?? 'injected',
    synthetic: (backend.kind ?? 'injected') !== 'miniprogram-automator',
    target_kind: 'devtools',
    port: operation.port ?? port ?? 9420,
    real_device: false,
    project: {
      directory: project.directory,
      appid_masked: project.appid_masked,
      projectname: project.projectname,
      synthetic_appid: project.synthetic_appid
    },
    devtools_cli: cli.path,
    ws_endpoint: launched.wsEndpoint ?? null,
    page_path: page.path ?? null,
    cases: [],
    receipts: [],
    evidence: [],
    limitations: [],
    steps: 0,
    finished_at: null,
    resumed_from: session?.session_id ?? null,
    disconnect: null
  };
  let snapshot = null;
  try { snapshot = await captureSnapshot({ runDirectory, requestId: operation.request_id, page }); }
  catch (error) {
    throw new MiniprogramError('app_error', `DevTools launched but the initial snapshot failed: ${error.message}`, { action_started: true, miniProgram, page, session: next });
  }
  appendEvidence(next, [snapshot.path]);
  return {
    receipt: receiptBase({
      operation,
      session: next,
      status: 'ok',
      extra: {
        page_path: snapshot.page_path,
        session_id: next.session_id,
        appid_masked: project.appid_masked,
        snapshot_path: snapshot.path,
        evidence_paths: [snapshot.path],
        limitations: ['Developer tools only; real-device behavior is not verified.']
      }
    }),
    session: next
  };
}

async function handlerStop({ runDirectory, operation, getBackend, session }) {
  const backend = await getBackend();
  try {
    const connection = await backend.connect({ wsEndpoint: session.ws_endpoint });
    await backend.close({ miniProgram: connection.miniProgram });
  } catch (error) {
    throw new MiniprogramError('connection_lost', `Could not close the DevTools connection: ${error.message}`, { action_started: true });
  }
  session.status = 'finished';
  session.finished_at = now();
  return {
    receipt: receiptBase({ operation, session, status: 'ok', extra: { session_id: session.session_id, finished_at: session.finished_at } }),
    session
  };
}

async function withConnection(session, getBackend) {
  if (!session.ws_endpoint) fail('connection_lost', 'The session has no DevTools WebSocket endpoint; start a new session.');
  const backend = await getBackend();
  try {
    const connection = await backend.connect({ wsEndpoint: session.ws_endpoint });
    return connection.miniProgram;
  } catch (error) {
    throw new MiniprogramError('connection_lost', `Could not reconnect to WeChat DevTools: ${error.message}`, { action_started: false });
  }
}

async function handlerSnapshot({ runDirectory, operation, getBackend, session }) {
  const miniProgram = await withConnection(session, getBackend);
  const page = await safeCurrentPage(miniProgram);
  const snapshot = await captureSnapshot({ runDirectory, requestId: operation.request_id, page });
  const paths = [snapshot.path];
  if (operation.screenshot !== false) paths.push((await captureScreenshot({ runDirectory, requestId: operation.request_id, miniProgram })).path);
  session.page_path = snapshot.page_path;
  return {
    receipt: receiptBase({
      operation,
      session,
      status: 'ok',
      extra: {
        page_path: snapshot.page_path,
        element_count: snapshot.element_count,
        snapshot_path: snapshot.path,
        evidence_paths: imagePaths(paths)
      }
    }),
    session
  };
}

async function handlerTap({ runDirectory, operation, getBackend, session }) {
  const miniProgram = await withConnection(session, getBackend);
  const page = await safeCurrentPage(miniProgram);
  const element = await pickElement(page, operation.target, []);
  if (!element) fail('locator_not_found', `Target ${JSON.stringify(operation.target)} was not found on ${page.path ?? 'the current page'}.`);
  const described = await describeElement(element, operation.target, operation.target.index ?? 0);
  try { await element.tap(); }
  catch (error) { fail('tap_failed', `Tap failed after the target was found: ${error.message}`, { action_started: true, miniProgram, page }); }
  let assertionResult = null;
  let paths = [];
  try {
    if (operation.assertion) {
      assertionResult = await recordAssertion({
        runDirectory,
        requestId: operation.request_id,
        miniProgram,
        page: await safeCurrentPage(miniProgram),
        assertion: operation.assertion
      });
      paths = assertionResult.evidence_paths;
    } else {
      paths = [(await captureScreenshot({ runDirectory, requestId: operation.request_id, miniProgram })).path];
    }
  } catch (error) {
    error.details = { ...error.details, action_started: true, miniProgram, page: await safeCurrentPage(miniProgram).catch(() => page) };
    throw error;
  }
  const status = assertionResult ? assertionResult.case.status : 'ok';
  return {
    receipt: receiptBase({
      operation,
      session,
      status: status === 'passed' ? 'ok' : status,
      reason: assertionResult?.verdict.reason ?? null,
      failureCategory: assertionResult?.case.failure_category ?? 'none',
      extra: {
        action: 'tap',
        target: described,
        ...(assertionResult ? { case: assertionResult.case, actual: assertionResult.actual, timed_out: assertionResult.verdict.timed_out === true } : {}),
        evidence_paths: imagePaths(paths),
        missing_evidence: assertionResult?.missing ?? []
      }
    }),
    session
  };
}

async function handlerInput({ runDirectory, operation, getBackend, session }) {
  const miniProgram = await withConnection(session, getBackend);
  const page = await safeCurrentPage(miniProgram);
  const element = await pickElement(page, operation.target, operation.secret ? [operation.text] : []);
  if (!element) fail('locator_not_found', `Input target ${JSON.stringify(operation.target)} was not found on ${page.path ?? 'the current page'}.`);
  const described = await describeElement(element, operation.target, operation.target.index ?? 0, operation.secret ? [operation.text] : []);
  try { await element.input(operation.text); }
  catch (error) {
    fail('input_failed', `Input failed after the target was found: ${error.message}`, {
      action_started: true,
      miniProgram,
      page,
      secretText: operation.secret ? operation.text : undefined
    });
  }
  let assertionResult = null;
  let paths = [];
  try {
    if (operation.assertion) {
      assertionResult = await recordAssertion({
        runDirectory,
        requestId: operation.request_id,
        miniProgram,
        page: await safeCurrentPage(miniProgram),
        assertion: operation.assertion,
        secrets: operation.secret ? [operation.text] : []
      });
      paths = assertionResult.evidence_paths;
    } else {
      paths = [(await captureScreenshot({ runDirectory, requestId: operation.request_id, miniProgram })).path];
    }
  } catch (error) {
    error.details = { ...error.details, action_started: true, miniProgram, page: await safeCurrentPage(miniProgram).catch(() => page) };
    throw error;
  }
  const status = assertionResult ? assertionResult.case.status : 'ok';
  return {
    receipt: receiptBase({
      operation,
      session,
      status: status === 'passed' ? 'ok' : status,
      reason: assertionResult?.verdict.reason ?? null,
      failureCategory: assertionResult?.case.failure_category ?? 'none',
      extra: {
        action: 'input',
        target: described,
        secret: operation.secret === true,
        value_length: operation.text.length,
        value_sha256: sha256(operation.text),
        ...(assertionResult ? { case: assertionResult.case, actual: assertionResult.actual, timed_out: assertionResult.verdict.timed_out === true } : {}),
        evidence_paths: imagePaths(paths),
        missing_evidence: assertionResult?.missing ?? []
      }
    }),
    session
  };
}

async function handlerWait({ runDirectory, operation, getBackend, session }) {
  const miniProgram = await withConnection(session, getBackend);
  const page = await safeCurrentPage(miniProgram);
  const verdict = await pollCondition(miniProgram, operation.assertion, {
    timeoutMs: operation.assertion.timeout_ms ?? 10000,
    pollMs: operation.assertion.poll_ms ?? 250
  });
  const observed = await recordObservation({
    runDirectory,
    requestId: operation.request_id,
    miniProgram,
    page: await safeCurrentPage(miniProgram).catch(() => page),
    verdict,
    phase: 'wait'
  });
  return {
    receipt: receiptBase({
      operation,
      session,
      status: verdict.status === 'passed' ? 'ok' : verdict.status === 'failed' ? 'failed' : 'blocked',
      reason: verdict.reason,
      failureCategory: verdict.failure_category ?? (verdict.status === 'failed' ? 'needs_review' : 'environment_issue'),
      extra: {
        actual: scrubValue(verdict.actual ?? null),
        timed_out: verdict.timed_out === true,
        elapsed_ms: verdict.elapsed_ms ?? 0,
        evidence_paths: observed.evidence_paths,
        missing_evidence: observed.missing
      }
    }),
    session
  };
}

async function handlerAssert({ runDirectory, operation, getBackend, session }) {
  const miniProgram = await withConnection(session, getBackend);
  const page = await safeCurrentPage(miniProgram);
  const assertionResult = await recordAssertion({
    runDirectory,
    requestId: operation.request_id,
    miniProgram,
    page,
    assertion: operation.assertion
  });
  return {
    receipt: receiptBase({
      operation,
      session,
      status: assertionResult.case.status === 'passed' ? 'ok' : assertionResult.case.status,
      reason: assertionResult.verdict.reason,
      failureCategory: assertionResult.case.failure_category,
      extra: {
        case: assertionResult.case,
        actual: assertionResult.actual,
        timed_out: assertionResult.verdict.timed_out === true,
        evidence_paths: assertionResult.evidence_paths,
        missing_evidence: assertionResult.missing
      }
    }),
    session
  };
}

async function handlerScreenshot({ runDirectory, operation, getBackend, session }) {
  const miniProgram = await withConnection(session, getBackend);
  const file = await captureScreenshot({ runDirectory, requestId: operation.request_id, miniProgram });
  return {
    receipt: receiptBase({
      operation,
      session,
      status: 'ok',
      extra: { image: file, evidence_paths: [file.path], sha256: file.sha256 }
    }),
    session
  };
}

function summarizeCases(cases) {
  return {
    total: cases.length,
    passed: cases.filter(row => row.status === 'passed').length,
    failed: cases.filter(row => row.status === 'failed').length,
    skipped: cases.filter(row => row.status === 'skipped').length,
    blocked: cases.filter(row => row.status === 'blocked').length
  };
}

async function handlerFinish({ runDirectory, operation, getBackend, session }) {
  if (!session) fail('no_active_session', 'No mini program session exists to finish.');
  let finalEvidence = { paths: [], missing: [] };
  if (session.status === 'active' && operation.screenshot === true) {
    try {
      const miniProgram = await withConnection(session, getBackend);
      finalEvidence.paths.push((await captureScreenshot({ runDirectory, requestId: operation.request_id, miniProgram })).path);
    } catch (error) {
      finalEvidence.missing.push({ kind: 'screenshot', reason: error.message });
    }
  }
  const summary = summarizeCases(session.cases);
  const limitations = [...new Set([
    ...session.limitations,
    ...(operation.limitations ?? []),
    'Developer tools simulation only; real-device behavior, device compatibility and WeChat client differences are not verified.',
    ...(session.synthetic === true ? ['The backend for this run is an injected fake; no real WeChat DevTools process was launched.'] : []),
    'Assertions verify developer-tools UI state only; backend persistence, network services, other clients and performance are not proven.',
    'The adapter does not read or store WeChat account credentials.'
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
  appendEvidence(session, finalEvidence.paths);
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
    target: {
      kind: 'devtools',
      real_device: false,
      synthetic: session.synthetic === true,
      appid_masked: session.project?.appid_masked ?? null,
      projectname: session.project?.projectname ?? null
    },
    verification_scope: {
      layer: 'miniprogram_devtools_ui',
      does_not_prove: ['real device', 'backend persistence', 'network services', 'performance']
    },
    miniprogram: {
      version: 1,
      backend: session.backend,
      synthetic: session.synthetic === true,
      evidence_mode: 'devtools',
      project_directory: session.project?.directory ?? null,
      appid_masked: session.project?.appid_masked ?? null,
      synthetic_appid: session.project?.synthetic_appid ?? false,
      devtools_cli: session.devtools_cli,
      page_path: session.page_path,
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
  const paths = [...finalEvidence.paths, relativeRunPath(runDirectory, resultPath)];
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
        evidence_paths: imagePaths(paths),
        missing_evidence: finalEvidence.missing,
        session_id: session.session_id
      }
    }),
    session
  };
}

const handlers = {
  doctor: handlerDoctor,
  start: handlerStart,
  stop: handlerStop,
  snapshot: handlerSnapshot,
  tap: handlerTap,
  input: handlerInput,
  wait: handlerWait,
  assert: handlerAssert,
  screenshot: handlerScreenshot,
  finish: handlerFinish
};

export async function runMiniprogramOperation({
  runDirectory,
  operation: rawOperation,
  projectDirectory,
  devtoolsCli,
  targetKind = 'devtools',
  port = 9420,
  backend
} = {}) {
  if (typeof runDirectory !== 'string' || !runDirectory) throw new Error('runDirectory is required');
  const directory = resolve(runDirectory);
  if (!existsSync(directory)) throw new Error(`runDirectory does not exist: ${directory}`);
  const operation = validateMiniprogramOperation(rawOperation);
  operation.target_kind ??= targetKind;
  operation.port ??= loadSession(directory)?.port ?? port;
  const backendProvided = backend !== undefined;
  const getBackend = async () => backend ?? createDefaultBackend();
  const receiptDirectory = miniprogramReceiptDirectory(directory);
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
        const session = loadSession(directory);
        const receipt = receiptBase({
          operation,
          session,
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
      if (session) {
        session.status = 'blocked';
        session.disconnect = { at: now(), category: 'unknown_action_outcome', request_id: operation.request_id };
        saveSession(directory, session);
      }
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
  let session = operation.type === 'doctor' ? null : loadSession(directory);
  try {
    if (SESSION_REQUIRED.has(operation.type)) requireSession(session, operation);
    const result = await handlers[operation.type]({
      runDirectory: directory,
      operation,
      projectDirectory,
      devtoolsCli,
      port,
      targetKind,
      backendProvided,
      getBackend,
      session
    });
    if (operation.type === 'doctor') {
      const preflightPath = resolve(miniprogramEvidenceDirectory(directory), `${operation.request_id}.preflight.json`);
      atomicWriteJson(preflightPath, result.record);
      return publish({
        runDirectory: directory,
        operation,
        receipt: receiptBase({
          operation,
          session: null,
          status: result.blockers.length ? 'blocked' : 'ok',
          reason: result.blockers[0]?.reason ?? null,
          failureCategory: result.blockers.length ? 'environment_issue' : 'none',
          synthetic: backendProvided,
          extra: {
            target_kind: result.kind,
            blockers: result.blockers,
            warnings: result.warnings,
            preflight: result.record,
            preflight_path: relativeRunPath(directory, preflightPath),
            evidence_paths: [relativeRunPath(directory, preflightPath)]
          }
        }),
        session: null
      });
    }
    return publish({ runDirectory: directory, operation, receipt: result.receipt, session: result.session });
  } catch (error) {
    const failure = error instanceof MiniprogramError ? error : new MiniprogramError('command_failed', error.message);
    const actionStarted = failure.details?.action_started === true;
    if (failure.details?.session) session = failure.details.session;
    // A failed operation that never started may retry the same request id after correction.
    if (SIDE_EFFECT.has(operation.type) && !actionStarted) rmSync(intentPath, { force: true });
    let receipt;
    if (failure.category === 'duplicate_case_id') {
      receipt = receiptBase({
        operation,
        session,
        status: 'blocked',
        reason: failure.message,
        failureCategory: 'script_issue',
        extra: { diagnostic: { category: failure.category, phase: operation.type }, operation_started: false }
      });
    } else {
      receipt = await failureReceipt({
        runDirectory: directory,
        operation,
        session,
        error: failure,
        phase: operation.type,
        actionStarted,
        secrets: failure.details?.secretText ? [failure.details.secretText] : []
      });
    }
    return publish({ runDirectory: directory, operation, receipt, session });
  }
}

export { MiniprogramError } from './miniprogram-devtools.mjs';
