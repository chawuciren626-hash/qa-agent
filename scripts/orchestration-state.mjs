import { dataPath, directoryContext, assertRunContext } from './directory-context.mjs';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { assertUnlinked } from './skill-resources.mjs';
import { resolve } from "node:path";

export const stageStatuses = new Set([
  "planned", "in_progress", "completed", "awaiting_confirmation",
  "revision_requested", "blocked", "failed", "skipped"
]);

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value, { mode } = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    // Windows readers can briefly prevent replacement. Retry only the rename;
    // never truncate the existing document or replay the operation producing it.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 9) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function lockBusy(message) {
  return Object.assign(new Error(message), { code: 'EEXIST' });
}

function recoverManifestLock(root, runId, lock) {
  let raw;
  try { raw = readFileSync(lock, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let owner;
  try { owner = JSON.parse(raw); } catch { throw lockBusy('Manifest lock is unreadable; preserve it for engineering diagnosis, not user approval'); }
  if (owner?.version !== 2 || owner.host !== hostname() || owner.run_id !== runId ||
      !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      !/^[a-f0-9-]{36}$/.test(owner.token ?? '') || !Number.isFinite(Date.parse(owner.at))) {
    throw lockBusy('Manifest lock ownership cannot be verified; no automatic takeover');
  }
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code !== 'ESRCH') throw lockBusy('Manifest lock owner status is unknown; no automatic takeover');
    const runDir = resolve(lock, '..');
    assertUnlinked(directoryContext(root).session_root, resolve(runDir, 'manifest.json'));
    const manifest = readJson(resolve(runDir, 'manifest.json'));
    if (manifest.run_id !== runId) throw new Error('Manifest identity mismatch during lock recovery');
    assertRunContext(root, manifest);
    const auditDir = resolve(runDir, 'audit/manifest-lock-recovery');
    assertUnlinked(directoryContext(root).session_root, auditDir);
    mkdirSync(auditDir, { recursive: true });
    const digest = createHash('sha256').update(raw).digest('hex');
    const claim = resolve(auditDir, `${digest}.json`);
    assertUnlinked(directoryContext(root).session_root, claim);
    // Exactly one contender may remove these lock bytes. Keep the claim permanently:
    // a second contender must never remove a replacement owner's lock.
    const record = { version: 1, run_id: runId, status: 'claimed', at: new Date().toISOString(),
      recovery_pid: process.pid, previous_lock: raw, previous_sha256: digest, reason: 'owner_process_absent',
      product_actions_replayed: false };
    try { writeFileSync(claim, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) {
      if (error.code === 'EEXIST') throw lockBusy('Manifest lock recovery already claimed; no competing takeover or product replay');
      throw error;
    }
    assertUnlinked(directoryContext(root).session_root, lock);
    if (readFileSync(lock, 'utf8') !== raw) throw lockBusy('Manifest lock changed during recovery; preserved current owner');
    unlinkSync(lock);
    writeJson(claim, { ...record, status: 'lock_removed', removed_at: new Date().toISOString() });
    return;
  }
  throw lockBusy('Manifest lock owner is still running; no takeover regardless of lock age');
}

export function withRunLock(root, project, runId, operation) {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '')) throw new Error('Invalid run ID');
  const lock = dataPath(root, project.run_root, runId, 'manifest.json.lock');
  assertUnlinked(directoryContext(root).session_root, lock);
  const raw = JSON.stringify({ version: 2, run_id: runId, host: hostname(), token: randomUUID(), pid: process.pid, at: new Date().toISOString() });
  try { writeFileSync(lock, raw, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    recoverManifestLock(root, runId, lock);
    writeFileSync(lock, raw, { flag: 'wx' });
  }
  try { return operation(); }
  finally {
    assertUnlinked(directoryContext(root).session_root, lock);
    if (!existsSync(lock) || readFileSync(lock, 'utf8') !== raw) throw new Error('Manifest lock ownership changed; current lock preserved for engineering diagnosis');
    unlinkSync(lock);
  }
}

export function getRunContext(root, project, runId) {
  const manifestPath = dataPath(root, project.run_root, runId, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`找不到运行清单: ${manifestPath}`);
  const manifest=readJson(manifestPath);assertRunContext(root,manifest);
  return { manifestPath, manifest };
}

export function getPlanStage(manifest, stageId) {
  return manifest.orchestration?.plan?.stages?.find((stage) => stage.id === stageId);
}

export function selectedPlanStages(manifest) {
  return manifest.orchestration?.plan?.stages?.filter((stage) => stage.selected) ?? [];
}

export function hasApprovedConfirmation(manifest, stageId) {
  return (manifest.confirmations ?? []).filter((item) => item.stage === stageId).at(-1)?.status === 'approved';
}

export function hasPendingConfirmation(manifest, stageId) {
  return (manifest.confirmations ?? []).some((item) => item.stage === stageId && item.status === "pending");
}

export function stageDependencyScope(manifest, stageId) {
  const scope = new Set();
  const visit = id => {
    if (scope.has(id)) return;
    scope.add(id);
    for (const dependency of getPlanStage(manifest, id)?.depends_on ?? []) visit(dependency);
  };
  visit(stageId);
  return scope;
}

export function currentStageDecision(manifest, stageId) {
  const decision = (manifest.confirmations ?? []).filter(item => item.stage === stageId).at(-1);
  if (!decision || decision.status !== 'revision_requested') return decision ?? null;
  const events = manifest.orchestration?.events ?? [];
  const resolved = events.findLastIndex(event => event.type === 'confirmation_resolved' && event.stage === stageId && event.decision === 'revision_requested');
  const dispatch = events.findLastIndex(event => event.type === 'dispatched' && event.stage === stageId);
  // A recorded revision dispatch consumes the old request, never an unresolved rejection.
  if (resolved >= 0 && dispatch > resolved && events[dispatch].revision_context?.archive &&
      events[dispatch].dispatch_id === manifest.stages?.[stageId]?.dispatch_id) return null;
  return decision;
}

export function assertRecoveryDecisions(manifest, stageId) {
  if ((manifest.confirmations ?? []).some(item => typeof item.stage !== 'string')) throw new Error('Human decision stage is missing; preserve the decision for diagnosis');
  for (const id of stageDependencyScope(manifest, stageId)) {
    const decision = currentStageDecision(manifest, id);
    if (['pending', 'rejected', 'revision_requested'].includes(decision?.status)) {
      throw new Error(`Human decision must be respected: ${id} ${decision.status}`);
    }
  }
}

export function recomputeRunStatus(manifest) {
  const stages = selectedPlanStages(manifest);
  if (!stages.length) return manifest.status ?? "created";
  const states = stages.map((stage) => manifest.stages?.[stage.id]?.status ?? "planned");
  if (states.includes("failed")) return "failed";
  if (states.includes("blocked")) return "blocked";
  if (states.includes("awaiting_confirmation")) return "awaiting_confirmation";
  if (states.every((status) => ["completed", "skipped"].includes(status))) return "completed";
  return "in_progress";
}

export function assertStageReady(manifest, stageId) {
  assertStageHistory(manifest, stageId);
  const stage = getPlanStage(manifest, stageId);
  if (!stage?.selected) throw new Error(`阶段未在本次运行计划中启用: ${stageId}`);
  const state = manifest.stages?.[stageId]?.status ?? "planned";
  if (!["planned", "revision_requested"].includes(state)) {
    throw new Error(`阶段 ${stageId} 当前状态为 ${state}，不能派发。`);
  }
  const unfinished = (stage.depends_on ?? []).filter((dependency) =>
    !["completed", "skipped"].includes(manifest.stages?.[dependency]?.status));
  if (unfinished.length) throw new Error(`阶段 ${stageId} 的前置阶段未完成: ${unfinished.join(", ")}`);
  const unapprovedDependencies = (stage.depends_on ?? []).filter((dependency) => {
    const dependencyPlan = getPlanStage(manifest, dependency);
    return dependencyPlan?.confirmation === "after" && !hasApprovedConfirmation(manifest, dependency);
  });
  if (unapprovedDependencies.length) {
    throw new Error(`阶段 ${stageId} 的前置阶段尚未批准: ${unapprovedDependencies.join(", ")}`);
  }
  if (stage.confirmation === "before" && !hasApprovedConfirmation(manifest, stageId)) {
    throw new Error(`阶段 ${stageId} 需要执行前人工批准。`);
  }
  return stage;
}

export function assertDispatchScheduling(manifest, stageId, { resumeBrowser = false } = {}) {
  const active=Object.entries(manifest.stages ?? {}).filter(([,s])=>s.status==='in_progress');
  if(resumeBrowser) return;
  if(manifest.orchestration?.plan?.workflow_mode==='task') {
    if(active.some(([id])=>id===stageId)) throw new Error('This task already has an active dispatch; continue it without dispatching twice');
    return;
  }
  if(active.length) throw new Error('Another lifecycle stage is active; continue the existing dispatch before scheduling this stage');
}

export function assertStageHistory(manifest, stageId) {
  const last = (manifest.orchestration?.events ?? []).filter(event => event.stage === stageId).at(-1);
  if (!last) return;
  const expected = { dispatched: 'in_progress', completed: 'completed', preparation_completed: 'planned', failed: 'failed', blocked: 'blocked', stage_recovered: 'revision_requested', quality_revision_required: 'revision_requested', confirmation_requested: 'awaiting_confirmation', review_mode_continued: 'completed' }[last.type]
    ?? (last.type === 'stage_added_to_plan' ? 'planned' : null)
    ?? (last.type === 'confirmation_resolved' ? (last.decision === 'approved' ? (getPlanStage(manifest, stageId)?.confirmation === 'before' ? 'planned' : 'completed') : last.decision === 'rejected' ? 'blocked' : 'revision_requested') : null);
  if (expected && manifest.stages?.[stageId]?.status !== expected) throw new Error('Stage status differs from its latest audit event; refusing manual state override');
}
