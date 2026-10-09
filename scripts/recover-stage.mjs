import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getRunContext, withRunLock, writeJson, recomputeRunStatus, assertStageHistory } from './orchestration-state.mjs';
import { readRunFile } from './design-quality.mjs';
import { assertParentSession, readSession } from './stage-evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const project = JSON.parse(readFileSync(resolve(root, 'config/project.json'), 'utf8'));
const [runId, stage, ...args] = process.argv.slice(2);
const allowed = new Set(['expected-sha256', 'actor', 'reason', 'approval-ref', 'evidence', 'parent-session-id']);
const options = {};
for (const arg of args) {
  const match = /^--([^=]+)=(.+)$/s.exec(arg);
  if (!match || !allowed.has(match[1]) || options[match[1]]) throw new Error('Invalid or duplicate recovery option');
  options[match[1]] = match[2];
}
for (const key of allowed) if (!options[key]?.trim()) throw new Error(`Recovery requires --${key}`);
withRunLock(root, project, runId, () => {
  const { manifestPath, manifest } = getRunContext(root, project, runId);
  const digest = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
  if (digest !== options['expected-sha256']) throw new Error('Manifest changed; review the current revision');
  const current = manifest.stages?.[stage];
  assertStageHistory(manifest, stage);
  if (!manifest.orchestration?.plan?.stages.some(item => item.id === stage && item.selected) || !['blocked', 'failed'].includes(current?.status)) throw new Error('Only a selected blocked/failed stage may recover');
  if (Object.values(manifest.stages).some(item => item.status === 'in_progress') || (manifest.confirmations ?? []).some(item => item.status === 'pending')) throw new Error('Active stage or pending confirmation prevents recovery');
  if ((manifest.confirmations ?? []).filter(item => item.stage === stage).at(-1)?.status === 'rejected') throw new Error('Rejected authorization cannot be recovered; create a newly approved run');
  const runDir = resolve(manifestPath, '..');
  const statePath = resolve(runDir, 'execution/execution-state.json');
  if (existsSync(resolve(runDir, 'execution/execution.lock.json')) || (existsSync(statePath) && JSON.parse(readFileSync(statePath, 'utf8')).status === 'running')) throw new Error('Execution may still be active; reconcile it before stage recovery');
  const dispatch = manifest.orchestration.events.filter(item => item.type === 'dispatched' && item.stage === stage).at(-1);
  if (!dispatch?.dispatch_id || dispatch['parent-session-id'] !== options['parent-session-id']) throw new Error('Legacy or unowned dispatch cannot be recovered; preserve it and create a new run');
  const parent = assertParentSession(root, runId, options['parent-session-id']);
  const agentRoot = process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents');
  // Check every child call for this run since dispatch, including calls missing the required token.
  const children = [];
  for (const [index, row] of parent.entries()) {
    if (row.payload?.type !== 'tool_call' || row.payload.name !== 'run_subagent' || Date.parse(row.timestamp) < Date.parse(dispatch.at)) continue;
    const call = typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments;
    if (!String(call?.prompt).split(/[^A-Za-z0-9-]+/).includes(runId)) continue;
    const end = parent.findIndex((item, position) => position > index && item.payload?.type === 'tool_call_output' && item.payload.tool_call_id === row.payload.tool_call_id);
    if (end < 0) throw new Error('Child call has no terminal tool response');
    for (const event of parent.slice(index + 1, end).filter(item => item.payload?.type === 'subagent')) {
      const child = readSession(agentRoot, call.agent_id, event.payload.session_id);
      const last = child.filter(item => ['request_begin', 'request_end'].includes(item.payload?.type)).at(-1);
      if (last?.payload.type !== 'request_end' || !['completed', 'interrupted', 'failed', 'cancelled', 'error'].includes(last.payload.status)) throw new Error('Child session is active or termination is unknown');
      children.push(event.payload.session_id);
    }
  }
  const evidence = readRunFile(runDir, options.evidence);
  if (!evidence.data.length) throw new Error('Recovery evidence is empty');
  const at = new Date().toISOString();
  manifest.orchestration.events.push({ type: 'stage_recovered', at, stage, from: current.status, to: 'revision_requested', previous_stage: structuredClone(current), dispatch_id: dispatch.dispatch_id, parent_session_id: options['parent-session-id'], manifest_sha256: digest, actor: options.actor, reason: options.reason, approval_ref: options['approval-ref'], evidence: { path: evidence.path, sha256: evidence.sha256 }, verified_children: children });
  manifest.stages[stage] = { ...current, status: 'revision_requested', updated_at: at, reason: options.reason };
  for (const confirmation of manifest.confirmations ?? []) if (confirmation.stage === stage && confirmation.status === 'approved') {
    confirmation.status = 'superseded'; confirmation.superseded_at = at; confirmation.superseded_reason = 'stage_recovered';
  }
  manifest.orchestration.resume_from = stage;
  manifest.status = recomputeRunStatus(manifest);
  manifest.updated_at = at;
  writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ run_id: runId, stage, status: 'revision_requested', starts_execution: false }));
});
