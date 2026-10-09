import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicJson, attemptDirectory, verifyAttempt } from './execution-attempts.mjs';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { recomputeRunStatus, withRunLock } from './orchestration-state.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const categories = ['product_defect', 'script_issue', 'environment_issue', 'test_data_issue'];
const initial = ['draft', 'needs_review'];
const terminal = ['closed', 'rejected'];
const location = (root, runId) => resolve(runDirectory(root, runId), 'defects/lifecycle.json');
const key = (invocation, defect) => `${invocation}:${defect}`;

function references(root, runId, paths) {
  requireValue(Array.isArray(paths) && paths.length > 0, 'Decision evidence is required');
  return paths.map(path => {
    const value = readRunFile(runDirectory(root, runId), path);
    return { path: value.path, sha256: value.sha256 };
  });
}
function sealed(root, runId, invocation) {
  const manifest = verifyAttempt(root, runId, invocation);
  const dir = attemptDirectory(root, runId, invocation);
  return { manifest, result: read(resolve(dir, 'test_results.json')), plan: read(resolve(dir, 'inputs/execution-plan.json')), manifest_sha256: hash(readFileSync(resolve(dir, 'attempt.json'))) };
}
function retestEvidence(root, runId, subject, invocation, after, targetRun = runId) {
  requireValue(invocation !== subject.invocation_id || targetRun !== runId, 'Retest must use an independent attempt');
  const origin = sealed(root, runId, subject.invocation_id);
  const target = sealed(root, targetRun, invocation);
  requireValue(['completed', 'failed'].includes(target.manifest.status), 'Retest is blocked or incomplete');
  requireValue(Date.parse(target.manifest.started_at) > Date.parse(after), 'Retest must start after the fix/reopen baseline');
  const comparableFiles = source => {
    const gate = source.plan.design_gate;
    // Full file hashes remain in approved/sealed plans. Only cross-run ledger identity excludes run_id.
    return gate?.files?.map(file => targetRun !== runId && file.path === 'analysis/requirement-ledger.json' && /^[a-f0-9]{64}$/.test(gate.provenance_sha256 ?? '')
      ? { ...file, sha256: gate.provenance_sha256 } : file);
  };
  requireValue(isDeepStrictEqual(comparableFiles(origin), comparableFiles(target)) && Array.isArray(origin.plan.design_gate?.files) && origin.plan.design_gate.files.length, 'Retest design basis differs; same case IDs alone are not sufficient');
  const environment = (source, sourceRun, sourceInvocation) => {
    const snapshot = read(resolve(attemptDirectory(root, sourceRun, sourceInvocation), 'inputs/approval-snapshot.json'));
    const path = relative(root, resolve(root, source.plan.environment_config)).replaceAll('\\', '/');
    const entry = snapshot.snapshot?.files?.find(file => file.path === path);
    requireValue(entry?.sha256, 'Retest requires archived environment approval hash');
    return entry;
  };
  requireValue(isDeepStrictEqual(environment(origin, runId, subject.invocation_id), environment(target, targetRun, invocation)), 'Retest environment differs from origin approval');
  const cases = subject.base.related_cases.map(id => {
    const before = origin.plan.cases.filter(row => row.case_id === id);
    const planned = target.plan.cases.filter(row => row.case_id === id);
    const outcomes = target.result.cases.filter(row => row.case_id === id);
    requireValue(before.length === 1 && planned.length === 1 && isDeepStrictEqual(before[0], planned[0]), `Retest plan omitted or changed ${id}`);
    requireValue(outcomes.length === 1 && ['passed', 'failed'].includes(outcomes[0].status), `Retest omitted, skipped or blocked ${id}`);
    return { case_id: id, status: outcomes[0].status };
  });
  return { run_id: targetRun, invocation_id: invocation, manifest_sha256: target.manifest_sha256, cases, passed: cases.every(row => row.status === 'passed') };
}
function replay(root, runId, subject) {
  const origin = sealed(root, runId, subject.invocation_id);
  requireValue(origin.manifest_sha256 === subject.origin_sha256, 'Origin attempt changed');
  requireValue(initial.includes(subject.base.lifecycle_status), 'Invalid lifecycle starting status');
  requireValue(subject.base.related_cases?.length && subject.base.related_cases.every(id => origin.result.cases.some(row => row.case_id === id && row.status === 'failed')), 'Lifecycle origin is not a failed observation');
  let record = structuredClone(subject.base);
  let previous = hash({ invocation_id: subject.invocation_id, origin_sha256: subject.origin_sha256, base: subject.base });
  let after = origin.manifest.finished_at;
  const used = new Set();
  for (const [index, event] of subject.events.entries()) {
    const { sha256, ...payload } = event;
    requireValue(event.seq === index + 1 && event.previous === previous && sha256 === hash(payload), 'Lifecycle event chain mismatch');
    requireValue(event.from === record.lifecycle_status && nonempty(event.actor) && nonempty(event.reason) && Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) >= Date.parse(after), 'Invalid lifecycle event context');
    const evidence = references(root, runId, event.evidence.map(file => file.path));
    requireValue(isDeepStrictEqual(evidence, event.evidence), 'Lifecycle decision evidence changed');
    let to;
    if (event.action === 'confirm') {
      requireValue(initial.includes(record.lifecycle_status) && categories.includes(event.category), 'Invalid confirmation transition');
      record.category = event.category; to = 'confirmed';
    } else if (event.action === 'reject') {
      requireValue(initial.includes(record.lifecycle_status), 'Only an unconfirmed observation can be rejected'); to = 'rejected';
    } else if (event.action === 'fixed') {
      requireValue(record.lifecycle_status === 'confirmed', 'Fix requires confirmed issue'); to = 'fixed';
    } else if (event.action === 'retest') {
      requireValue(['fixed', 'closed'].includes(record.lifecycle_status) && !used.has(event.retest?.invocation_id), 'Retest requires fixed/closed issue and unused attempt');
      const actual = retestEvidence(root, runId, subject, event.retest.invocation_id, after, event.retest.run_id);
      requireValue(isDeepStrictEqual(actual, event.retest), 'Retest evidence changed');
      requireValue(!(record.lifecycle_status === 'closed' && actual.passed), 'Closed issue needs a failing retest to reopen');
      used.add(actual.invocation_id); to = actual.passed ? 'closed' : 'confirmed';
    } else throw new Error('Unknown lifecycle action');
    requireValue(event.to === to, 'Lifecycle target status mismatch');
    record.lifecycle_status = to;
    previous = sha256; after = event.at;
  }
  requireValue(subject.revision === subject.events.length, 'Lifecycle revision mismatch');
  return { ...record, origin_invocation_id: subject.invocation_id, lifecycle_revision: subject.revision };
}

export function readLifecycle(root, runId) {
  const path = location(root, runId);
  if (!existsSync(path)) return { version: 1, run_id: runId, subjects: [] };
  const data = read(path);
  requireValue(data.version === 1 && data.run_id === runId && Array.isArray(data.subjects), 'Invalid lifecycle ledger');
  const ids = new Set();
  for (const subject of data.subjects) {
    const id = key(subject.invocation_id, subject.base.defect_id);
    requireValue(!ids.has(id), 'Duplicate lifecycle subject'); ids.add(id);
    replay(root, runId, subject);
  }
  return data;
}
function locked(root, runId, operation) {
  const path = location(root, runId);
  mkdirSync(resolve(path, '..'), { recursive: true });
  const lock = `${path}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
  try { return operation(path); } finally { unlinkSync(lock); }
}
function reportRevision(root, runId, revisionReason) {
  const path = resolve(runDirectory(root, runId), 'manifest.json');
  if (!existsSync(path)) return;
  const manifest = read(path);
  if (!manifest.orchestration?.plan?.stages?.some(stage => stage.id === 'report' && stage.selected)) return;
  if (manifest.stages?.report?.status !== 'completed') return;
  manifest.stages.report = { ...manifest.stages.report, status: 'revision_requested', reason: revisionReason, updated_at: new Date().toISOString() };
  manifest.status = recomputeRunStatus(manifest);
  manifest.updated_at = new Date().toISOString();
  manifest.orchestration.resume_from = 'report';
  manifest.orchestration.events ??= [];
  manifest.orchestration.events.push({ type: 'quality_revision_required', stage: 'report', at: new Date().toISOString(), reason: revisionReason });
  atomicJson(path, manifest);
}

export function registerObservations(root, runId, data) {
  return locked(root, runId, path => {
    const ledger = readLifecycle(root, runId);
    const origin = data.records.length ? sealed(root, runId, data.invocation_id) : null;
    for (const record of data.records) {
      requireValue(initial.includes(record.lifecycle_status), 'Normalization cannot set an advanced lifecycle status');
      const existing = ledger.subjects.find(subject => subject.invocation_id === data.invocation_id && subject.base.defect_id === record.defect_id);
      if (existing) { requireValue(isDeepStrictEqual(existing.base, record), 'Registered observation changed; preserve the original and use an explicit new observation'); continue; }
      const subject = { invocation_id: data.invocation_id, origin_sha256: origin.manifest_sha256, base: record, revision: 0, events: [] };
      replay(root, runId, subject);
      ledger.subjects.push(subject);
    }
    const registered = ledger.subjects.filter(subject => subject.invocation_id === data.invocation_id).map(subject => subject.base.defect_id).sort();
    requireValue(isDeepStrictEqual(registered, data.records.map(record => record.defect_id).sort()), 'Normalization cannot silently remove registered observations');
    atomicJson(path, ledger);
    return ledger;
  });
}

export function transitionDefect(root, runId, options) {
  return withRunLock(root, read(resolve(root, 'config/project.json')), runId, () => locked(root, runId, path => {
    const manifestPath = resolve(runDirectory(root, runId), 'manifest.json');
    if (existsSync(manifestPath)) requireValue(read(manifestPath).stages?.report?.status !== 'in_progress', 'Report generation is active; review after it finishes');
    const ledger = readLifecycle(root, runId);
    const subject = ledger.subjects.find(item => item.invocation_id === options.invocation_id && item.base.defect_id === options.defect_id);
    requireValue(subject, 'Registered defect not found for origin invocation');
    requireValue(Number.isSafeInteger(options.revision) && subject.revision === options.revision, 'Stale lifecycle revision; inspect the latest state');
    const current = replay(root, runId, subject);
    requireValue(nonempty(options.actor) && nonempty(options.reason), 'Actor and reason required');
    const event = { seq: subject.revision + 1, at: new Date().toISOString(), action: options.action, actor: options.actor, reason: options.reason, from: current.lifecycle_status, evidence: references(root, runId, options.evidence), previous: subject.events.at(-1)?.sha256 ?? hash({ invocation_id: subject.invocation_id, origin_sha256: subject.origin_sha256, base: subject.base }) };
    if (options.action === 'confirm') { event.category = options.category; event.to = 'confirmed'; }
    else if (options.action === 'reject') event.to = 'rejected';
    else if (options.action === 'fixed') event.to = 'fixed';
    else if (options.action === 'retest') {
      event.retest = retestEvidence(root, runId, subject, options.retest_invocation_id, subject.events.at(-1)?.at ?? sealed(root, runId, subject.invocation_id).manifest.finished_at, options.retest_run_id ?? runId);
      event.to = event.retest.passed ? 'closed' : 'confirmed';
    }
    event.sha256 = hash(event);
    subject.events.push(event); subject.revision++;
    const projected = replay(root, runId, subject);
    atomicJson(path, ledger);
    reportRevision(root, runId, `Lifecycle updated: ${subject.base.defect_id} revision ${subject.revision}`);
    return { run_id: runId, defect: projected, event };
  }));
}

export function governedDefects(root, runId, data) {
  const ledger = readLifecycle(root, runId);
  const current = (data.records ?? []).map(record => {
    const subject = ledger.subjects.find(item => item.invocation_id === data.invocation_id && item.base.defect_id === record.defect_id);
    if (subject) {
      requireValue(isDeepStrictEqual(subject.base, record), 'Current defect differs from registered observation');
      return replay(root, runId, subject);
    }
    requireValue(initial.includes(record.lifecycle_status), 'Advanced lifecycle state has no verified decision ledger');
    return record;
  });
  const history = ledger.subjects.filter(subject => subject.invocation_id !== data.invocation_id).map(subject => replay(root, runId, subject));
  const sameInvocation = ledger.subjects.filter(subject => subject.invocation_id === data.invocation_id);
  requireValue(sameInvocation.every(subject => current.some(record => record.defect_id === subject.base.defect_id)), 'Registered current defects disappeared');
  const path = location(root, runId);
  return { version: 1, ledger_sha256: existsSync(path) ? hash(readFileSync(path)) : null, current, history, open_historical: history.filter(record => !terminal.includes(record.lifecycle_status)) };
}

export function lifecycleReferences(root, runId) {
  const ledger = readLifecycle(root, runId);
  const files = new Set();
  if (existsSync(location(root, runId))) files.add('defects/lifecycle.json');
  for (const subject of ledger.subjects) {
    files.add(`execution/attempts/${subject.invocation_id}/attempt.json`);
    for (const event of subject.events) {
      event.evidence.forEach(file => files.add(file.path));
      if (event.retest?.run_id === runId) files.add(`execution/attempts/${event.retest.invocation_id}/attempt.json`);
    }
  }
  return [...files];
}
