import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getRunContext, withRunLock, writeJson, recomputeRunStatus, assertStageHistory } from './orchestration-state.mjs';
import { readRunFile } from './design-quality.mjs';
import { assertParentSession, readSession, requiredArtifacts } from './stage-evidence.mjs';
import { stageRequiredArtifacts } from './artifact-contracts.mjs';
import { normalizeInvalidation, assessStageArtifacts, describeStaleness } from './artifact-scope.mjs';
import { assertRequestEnded } from './session-lifecycle.mjs';
import { promptTokens } from './dispatch-binding.mjs';

const root = resolve(import.meta.dirname, '..');
const project = JSON.parse(readFileSync(resolve(root, 'config/project.json'), 'utf8'));
const [runId, stage, ...args] = process.argv.slice(2);
const required = new Set(['expected-sha256', 'actor', 'reason', 'approval-ref', 'evidence', 'parent-session-id']);
// `invalidate` 是可选的一条：不带它就是整阶段失效。把它塞进 required 会让每次都强制传一个空值，
// 那等于把「整阶段失效」这个默认行为变成需要显式声明的东西——多一个必须填的开关，就多一个填错的地方。
const allowed = new Set([...required, 'invalidate']);
const options = {};
for (const arg of args) {
  const match = /^--([^=]+)=(.+)$/s.exec(arg);
  if (!match || !allowed.has(match[1]) || options[match[1]]) throw new Error('Invalid or duplicate recovery option');
  options[match[1]] = match[2];
}
for (const key of required) if (!options[key]?.trim()) throw new Error(`Recovery requires --${key}`);
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
  const browserStatePath=resolve(runDir,'execution/browser-state.json');
  if(existsSync(browserStatePath) && !['closed','expired'].includes(JSON.parse(readFileSync(browserStatePath,'utf8')).status)) throw new Error('Interactive browser is still active; use human resume or finish, not failure recovery');
  if (existsSync(resolve(runDir, 'execution/execution.lock.json')) || existsSync(resolve(runDir,'execution/exploration.lock')) || (existsSync(statePath) && JSON.parse(readFileSync(statePath, 'utf8')).status === 'running')) throw new Error('Execution may still be active; reconcile it before stage recovery');
  const dispatch = manifest.orchestration.events.filter(item => item.type === 'dispatched' && item.stage === stage).at(-1);
  if (!dispatch?.dispatch_id || dispatch['parent-session-id'] !== options['parent-session-id']) throw new Error('Legacy or unowned dispatch cannot be recovered; preserve it and create a new run');
  const parent = assertParentSession(root, runId, options['parent-session-id']);
  const agentRoot = process.env.PENGUIN_AGENT_ROOT ?? resolve(homedir(), '.penguin/data/default_project/agents');
  // Check every child call for this run since dispatch, including calls missing the required token.
  const children = [];
  for (const [index, row] of parent.entries()) {
    if (row.payload?.type !== 'tool_call' || row.payload.name !== 'run_subagent' || Date.parse(row.timestamp) < Date.parse(dispatch.at)) continue;
    const call = typeof row.payload.arguments === 'string' ? JSON.parse(row.payload.arguments) : row.payload.arguments;
    if (!promptTokens(call?.prompt).includes(runId)) continue;
    const end = parent.findIndex((item, position) => position > index && item.payload?.type === 'tool_call_output' && item.payload.tool_call_id === row.payload.tool_call_id);
    if (end < 0) throw new Error('Child call has no terminal tool response');
    for (const event of parent.slice(index + 1, end).filter(item => item.payload?.type === 'subagent')) {
      const child = readSession(agentRoot, call.agent_id, event.payload.session_id);
      assertRequestEnded(child, ['completed', 'interrupted', 'failed', 'cancelled', 'error'], 'Child session is active or termination is unknown');
      children.push(event.payload.session_id);
    }
  }
  const evidence = readRunFile(runDir, options.evidence);
  if (!evidence.data.length) throw new Error('Recovery evidence is empty');
  // L-2：可选的产物子集失效。不给 `--invalidate` 就是整阶段失效（旧行为，一个字没变）；
  // 给了就只失效点名的那几条，报告要能说出「1500 条中 12 条基于旧版本」。
  // 参数走 JSON，因为它要表达 ids/kinds/selector 三种点名方式——拆成三个命令行开关会让
  // 「我到底失效了多少」变得需要读代码才能算清。
  const invalidation = options.invalidate === undefined ? null : normalizeInvalidation(parseInvalidation(options.invalidate, stage));
  const at = new Date().toISOString();
  // Preserve reviewed drafts before granting a new dispatch, without altering their working copies.
  const files=(stageRequiredArtifacts(root,runId,stage) ?? []).filter(p=>existsSync(resolve(runDir,p))).map(p=>readRunFile(runDir,p));
  const revisionId=`${stage}-${randomUUID()}`;
  const archive=`audit/revisions/${revisionId}`;
  const archiveDir=resolve(runDir,archive);
  mkdirSync(archiveDir,{recursive:true});
  if(realpathSync(archiveDir)!==archiveDir || realpathSync(runDir)!==runDir) throw new Error('Recovery archive redirected');
  for(const file of files) {
    const target=resolve(archiveDir,file.path);mkdirSync(resolve(target,'..'),{recursive:true});
    writeFileSync(target,file.data,{flag:'wx'});
  }
  manifest.orchestration.events.push({ type: 'stage_recovered', at, stage, from: current.status, to: 'revision_requested', previous_stage: structuredClone(current), dispatch_id: dispatch.dispatch_id, parent_session_id: options['parent-session-id'], manifest_sha256: digest, actor: options.actor, reason: options.reason, approval_ref: options['approval-ref'], evidence: { path: evidence.path, sha256: evidence.sha256 }, verified_children: children, archive, files:files.map(f=>({path:f.path,sha256:f.sha256})) });
  manifest.stages[stage] = { ...current, status: 'revision_requested', updated_at: at, reason: options.reason, revision_id:revisionId,revision_archive:archive };
  if (invalidation) {
    // 失效记录进 audit 事件，而不是写进 stages 的展示字段：谁在什么时候、因为什么、让哪几条
    // 失效，是复盘时要查的账，不是界面上的一句话。
    const assessment = assessStageArtifacts(registeredArtifacts(manifest, stage), invalidation);
    manifest.orchestration.events.push({
      type: 'artifacts_invalidated', at, stage,
      scope: invalidation.scope,
      subset: invalidation.subset,
      artifact_state: assessment.state,
      stale_ids: [...assessment.staleIds],
      valid_ids: [...assessment.validIds],
      summary: describeStaleness(assessment),
      reason: invalidation.reason,
    });
    manifest.stages[stage] = { ...manifest.stages[stage], artifact_state: assessment.state, artifact_summary: describeStaleness(assessment) };
  }
  for (const confirmation of manifest.confirmations ?? []) if (confirmation.stage === stage && confirmation.status === 'approved') {
    confirmation.status = 'superseded'; confirmation.superseded_at = at; confirmation.superseded_reason = 'stage_recovered';
  }
  manifest.orchestration.resume_from = stage;
  manifest.status = recomputeRunStatus(manifest);
  manifest.updated_at = at;
  writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ run_id: runId, stage, status: 'revision_requested', starts_execution: false,
    ...(invalidation ? { artifact_state: manifest.stages[stage].artifact_state, artifact_summary: manifest.stages[stage].artifact_summary } : {}) }));
});

/**
 * `--invalidate` 的取值：一段 JSON，形如
 *   {"ids":["TC-1","TC-2"],"kinds":["case"],"selector":{"module":"order"},"reason":"..."}
 * `stage` 由位置参数给出，这里补进去后再校验——命令行的位置参数和 JSON 各说各的，
 * 是这类参数最常见的出错方式。
 *
 * `ids`/`kinds`/`selector` 必须原样落进 `artifact_subset`：三个名字在顶层会被当成
 * 未知字段静默丢弃，于是「我点名了 1 条」变成「整阶段失效」——一个只改一个词就能
 * 让 L-2 完全失效的坑。
 */
function parseInvalidation(raw, stage) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Invalid --invalidate: expects JSON, e.g. {"ids":["TC-1"]}'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid --invalidate: expects a JSON object');
  if (parsed.stage !== undefined && parsed.stage !== stage) throw new Error('Invalid --invalidate: "stage" conflicts with the positional stage argument');
  const { reason, artifact_subset: nested, ...rest } = parsed;
  const inline = ['ids', 'kinds', 'selector'].filter(key => rest[key] !== undefined);
  if (inline.length && nested !== undefined) throw new Error('Invalid --invalidate: name the subset either inline or under artifact_subset, not both');
  const unknown = Object.keys(rest).filter(key => !['ids', 'kinds', 'selector'].includes(key));
  if (unknown.length) throw new Error(`Invalid --invalidate: unknown key(s) ${unknown.join(', ')}`);
  const subset = nested ?? (inline.length ? Object.fromEntries(inline.map(key => [key, rest[key]])) : {});
  // 给了 --invalidate 就必须点名：`{}` 会退化成整阶段失效，调用方却以为自己收窄了范围。
  return { stage, reason: reason ?? `recover-stage ${stage}`, artifact_subset: subset };
}

/**
 * 这个阶段已登记的产物记录。
 *
 * 数据源是 `manifest.artifacts`——record-orchestration-event 在每次派发/完成时把该阶段的产物
 * 路径累加进去，这是 run 目录里唯一完整可信的产物清单（run 目录本身没有独立的产物登记表）。
 * 一条都还原不出来时返回空数组，`assessStageArtifacts` 会如实回答 `unknown`，
 * 而不是假装「全部有效」——那正是 L-2 要避免的那种结论。
 */
function registeredArtifacts(manifest, stage) {
  const listed = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  return listed
    .map(value => String(value).trim())
    .filter(Boolean)
    .map(id => ({ id, kind: id.includes('/') ? 'file' : 'artifact', fields: {} }));
}
