import { existsSync, mkdirSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { assertStageHistory, getPlanStage, recomputeRunStatus, writeJson, assertDesignMutable } from './orchestration-state.mjs';
import { requiredArtifacts, assertCompletedArtifacts, stageRequiredArtifacts } from './artifact-contracts.mjs';

// Caller holds the run lock. A user revision is separate from bounded automatic draft repair.
export function requestAnalysisRevision(root, runId, manifest, reason, feedback) {
  assertDesignMutable(manifest,'analysis');
  // Build the next state separately; a failed revision must not mutate the caller's ledger.
  manifest = structuredClone(manifest);
  manifest.confirmations ??= [];
  if (!Array.isArray(manifest.confirmations) || !Array.isArray(manifest.orchestration?.events)) throw new Error('Invalid revision ledger');
  if (!reason?.trim()) throw new Error('Analysis revision requires the user modification request');
  if (!getPlanStage(manifest, 'analysis')?.selected) throw new Error('Analysis is outside the selected plan');
  assertStageHistory(manifest, 'analysis');
  const latest = (manifest.confirmations ?? []).filter(c => c.stage === 'analysis').at(-1);
  const autonomous = getPlanStage(manifest,'analysis').confirmation === 'none' && manifest.stages.analysis.status === 'completed' && (!latest || latest.status === 'not_required');
  if (!autonomous && (!latest || !['pending', 'approved'].includes(latest.status))) throw new Error('Analysis revision requires the current delivered version');
  if (!autonomous && manifest.stages.analysis.status !== (latest.status === 'pending' ? 'awaiting_confirmation' : 'completed')) throw new Error('Analysis state differs from current confirmation');
  if (autonomous) assertCompletedArtifacts(root,runId,manifest,'analysis');
  if (Object.values(manifest.stages).some(s => s.status === 'in_progress')) throw new Error('Wait for the active stage to finish before revising analysis');
  const dir = runDirectory(root, runId);
  if(feedback && (typeof feedback.text!=='string' || !feedback.text.trim() || !feedback.session_id || !feedback.timestamp)) throw new Error('Feedback requires exact user text and native session provenance');
  if (realpathSync(resolve(dir, 'analysis')) !== resolve(realpathSync(dir), 'analysis')) throw new Error('Analysis directory must not redirect writes');
  if (existsSync(resolve(dir, 'execution/execution.lock.json'))) throw new Error('Execution cleanup pending; revision not started');
  if (existsSync(resolve(dir, 'execution/execution-state.json'))) {
    const state = JSON.parse(readRunFile(dir, 'execution/execution-state.json').data);
    if (state.status === 'running' || state.processes_stopped === false || (state.version === 2 && state.processes_stopped !== true)) throw new Error('Execution termination is not confirmed');
  }
  const affected = new Set(['analysis']);
  const stages = manifest.orchestration.plan.stages.filter(s => s.selected);
  let changed;
  do {
    changed = false;
    for (const stage of stages) if (!affected.has(stage.id) && stage.depends_on?.some(id => affected.has(id))) {
      affected.add(stage.id); changed = true;
    }
  } while (changed);
  for (const stage of affected) assertStageHistory(manifest, stage);
  // Snapshot current bytes, even when the requested correction is a content/contract discrepancy.
  const snapshotPaths=[...affected].flatMap(stage => (stageRequiredArtifacts(root,runId,stage) ?? []).filter(path => stage === 'analysis' || existsSync(resolve(dir, path))));
  for(const [stage,path] of [['test_points','design/test_points.md'],['test_cases','design/test_cases.md']]) if(affected.has(stage) && existsSync(resolve(dir,path))) snapshotPaths.push(path);
  const files=[...new Set(snapshotPaths)].map(path => readRunFile(dir, path));
  const id = randomUUID();
  const archive = `audit/analysis-revisions/${id}`;
  const base = resolve(dir, archive);
  let input;
  if(feedback) {
    const bytes=Buffer.from(feedback.text,'utf8');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const path=`inputs/user-feedback-${id}.txt`;
    if(realpathSync(resolve(dir,'inputs'))!==resolve(realpathSync(dir),'inputs')) throw new Error('Feedback inputs directory redirected');
    input={path,sha256,session_id:feedback.session_id,timestamp:feedback.timestamp,kind:'user_confirmation'};
  }
  const at = new Date().toISOString();
  const previousStatus = latest?.status ?? 'not_required';
  if (latest?.status === 'pending') {
    Object.assign(latest, { status: 'revision_requested', resolved_at: at, reason, revision_id: id });
  } else {
    manifest.confirmations.push({ id: `revision-${id}`, stage: 'analysis', status: 'revision_requested', requested_at: at, resolved_at: at, reason, ...(latest?{supersedes:latest.id}:{}), revision_id: id });
  }
  const events = manifest.orchestration.events;
  events.push({ type: 'confirmation_resolved', at, stage: 'analysis', decision: 'revision_requested', reason, revision_id: id, archive, previous_status: previousStatus, affected_stages: [...affected], files: files.map(({ path, sha256 }) => ({ path, sha256 })), ...(input?{feedback_input:input}:{}) });
  manifest.stages.analysis = { ...manifest.stages.analysis, status: 'revision_requested', reason, revision_id: id, revision_archive: archive, updated_at: at, ...(input?{feedback_input:input}:{}) };
  for (const stage of affected) {
    if (stage === 'analysis') continue;
    const current = manifest.stages[stage];
    const decisions = manifest.confirmations.filter(c => c.stage === stage);
    const prior = decisions.at(-1);
    if (prior?.status === 'rejected') continue;
    if (prior?.status === 'pending') Object.assign(prior, { status: 'revision_requested', resolved_at: at, invalidated_by: id, reason: 'Upstream analysis changed; not a user approval' });
    else if (prior?.status === 'approved') manifest.confirmations.push({ id: `invalidated-${stage}-${id}`, stage, status: 'revision_requested', resolved_at: at, invalidated_by: id, supersedes: prior.id, reason: 'Upstream analysis changed; not a user approval' });
    if (!current || ['planned', 'skipped'].includes(current.status)) continue;
    events.push({ type: 'quality_revision_required', at, stage, reason: 'Upstream analysis revision', revision_id: id, archive });
    manifest.stages[stage] = { ...current, status: 'revision_requested', updated_at: at, reason: 'Upstream analysis revision', invalidated_by: id, revision_id: id, revision_archive: archive };
  }
  manifest.orchestration.resume_from = 'analysis';
  manifest.status = recomputeRunStatus(manifest);
  manifest.updated_at = at;
  // Keep the ledger as an editable starting point; remove only the snapshotted generated Markdown.
  const markdown = files.find(f => f.path === 'analysis/requirement_analysis.md');
  if (!markdown) throw new Error('Current analysis Markdown is required for revision');
  const target = resolve(dir, markdown.path);
  mkdirSync(base, { recursive: true });
  if (realpathSync(base) !== resolve(realpathSync(dir), archive)) throw new Error('Revision archive must not redirect writes');
  for (const file of files) {
    const path = resolve(base, file.path);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, file.data, { flag: 'wx' });
  }
  writeFileSync(resolve(base, 'manifest-before.json'), readRunFile(dir, 'manifest.json').data, { flag: 'wx' });
  const transactionPath = resolve(base, 'revision-state.json');
  writeJson(transactionPath, { status: 'prepared', revision_id: id, approval_granted: false });
  let removed = false;
  try {
    if (input) writeFileSync(resolve(dir,input.path),Buffer.from(feedback.text,'utf8'),{flag:'wx'});
    unlinkSync(target); removed = true;
    writeJson(resolve(dir, 'manifest.json'), manifest);
  } catch (error) {
    if (removed) writeFileSync(target, markdown.data, { flag: 'wx' });
    // Retain partial evidence, but never describe it as applied feedback or approval.
    writeJson(transactionPath, { status: 'failed', revision_id: id, error: error.message, approval_granted: false });
    throw error;
  }
  writeJson(transactionPath, { status: 'committed', revision_id: id, approval_granted: false });
  return { run_id: runId, stage: 'analysis', decision: 'revision_requested', resume_from: 'analysis', archive, affected_stages: [...affected], approval_granted: false, starts_execution: false, ...(input?{feedback_input:input}:{}) };
}
