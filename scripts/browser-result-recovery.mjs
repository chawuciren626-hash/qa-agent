import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readRunFile } from './design-quality.mjs';
import { summarizeExecutionCounts, resolveCaseReference } from './execution-counts.mjs';
import { writeJson } from './orchestration-state.mjs';
import { summarizeHumanHandoff, summarizeBrowserPerformance } from './browser-performance.mjs';

const statuses = ['passed', 'failed', 'blocked', 'skipped'];
const digest = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

export function browserResultSnapshot(state, cases, readSource, origin = 'live') {
  return {
    version: 1, run_id: state.run_id, invocation_id: state.invocation_id,
    result_origin: origin, status: 'partial', started_at: state.started_at,
    finished_at: null, browser_closed: 'unknown',
    summary: {total: cases.length, ...Object.fromEntries(statuses.map(s => [s, cases.filter(r => r.status === s).length]))},
    cases, statistics: summarizeExecutionCounts(cases, {interactive: true, readSource}),
    ...(state.human_handoff_timing!==undefined?{human_handoff_summary:summarizeHumanHandoff(state.human_handoff_timing)}:{})
  };
}

// Called by the single worker only, after its completed receipt is committed.
// This is a replaceable checkpoint, not a second authoritative event log.
export function saveBrowserProgress(dir, state, committedCases, receipt) {
  const value = browserResultSnapshot(state, committedCases, path => readRunFile(dir, path));
  value.checkpoint = {request_id: receipt.request_id, request_sha256: receipt.request_sha256,
    receipt_path: `execution/browser-evidence/${receipt.request_id}.json`,
    completed_at: receipt.completed_at};
  writeJson(resolve(dir, 'execution/browser-progress.json'), value, {mode: 0o600});
}

// No worker connection, write, or product operation is performed by this reducer.
export function recoverBrowserResults(dir) {
  const sources = new Map(), problems = [], unknown = [], candidates = [], timedReceipts=[];
  const read = path => {
    const file = readRunFile(dir, path);
    const previous = sources.get(file.path);
    if (previous && previous.sha256 !== file.sha256) throw new Error('source_changed');
    sources.set(file.path, {path: file.path, sha256: file.sha256});
    return file;
  };
  const json = path => JSON.parse(read(path).data);
  const state = json('execution/browser-state.json');
  if (!id(state.run_id) || !id(state.invocation_id) || !id(state.dispatch_id)) throw new Error('Invalid browser identity');
  const groups = new Map();
  for (const name of readdirSync(resolve(dir, 'execution/browser-evidence')).sort()) {
    // Auxiliary observations have a second suffix; only operation receipts qualify.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(name)) continue;
    const path = `execution/browser-evidence/${name}`;
    let receipt;
    try { receipt = json(path); }
    catch { problems.push({path, reason: 'unreadable_receipt'}); continue; }
    if (!receipt || ![undefined,1,2].includes(receipt.version) || !id(receipt.request_id) || !id(receipt.command_id) ||
        typeof receipt.at!=='string' || !Number.isFinite(Date.parse(receipt.at)) || !/^[a-f0-9]{64}$/.test(receipt.request_sha256 ?? '')) {
      problems.push({path, reason: 'invalid_receipt'}); continue;
    }
    const key = receipt.request_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({path, receipt});
  }
  for (const entries of groups.values()) {
    // A conflicting copy never wins merely because it says "completed".
    if (new Set(entries.map(e => JSON.stringify(e.receipt))).size > 1) {
      problems.push({paths: entries.map(e => e.path), reason: 'conflicting_request_receipts'}); continue;
    }
    const canonical=entries.find(e=>e.path===`execution/browser-evidence/${e.receipt.request_id}.json`);
    if(!canonical) {problems.push({paths:entries.map(e=>e.path),reason:'missing_canonical_receipt'});continue;}
    const {path, receipt: r} = canonical;
    if (r.dispatch_id !== state.dispatch_id || (r.run_id !== undefined && r.run_id !== state.run_id) ||
        (r.invocation_id !== undefined && r.invocation_id !== state.invocation_id)) {
      problems.push({path, reason: 'foreign_attempt'}); continue;
    }
    let command;
    try { command = json(`audit/commands/${r.command_id}/command.json`); }
    catch { problems.push({path, reason: 'missing_command_identity'}); continue; }
    if (command.run_id !== state.run_id || command.script !== 'browser-task.mjs' || (command.command_id!==undefined && command.command_id!==r.command_id)) {
      problems.push({path, reason: 'foreign_command'}); continue;
    }
    if (r.status !== 'completed') {
      unknown.push({request_id: r.request_id, receipt_path: path, reason: 'no_completed_receipt'}); continue;
    }
    if(r.version===2 && r.run_id===state.run_id && r.invocation_id===state.invocation_id) timedReceipts.push(r);
    if(['fill','click','press','select','check'].includes(r.operation) && r.result?.operation_started!==false &&
        ['needs_inspection','observation_unavailable'].includes(r.result?.status)) {
      unknown.push({request_id:r.request_id,receipt_path:path,reason:'completed_receipt_does_not_establish_action_outcome'});
    }
    for (const key of ['assertion', 'response_assertion']) {
      const row = r.result?.[key];
      if (!row) continue;
      try {
        if (!id(row.case_id) || !statuses.includes(row.status) || !Array.isArray(row.evidence_paths) ||
            row.evidence_paths.length < 2 || !row.evidence_paths.includes(path) ||
            !(key === 'assertion' ? ['assert','click','press'] : ['click','press','api_check']).includes(r.operation)) throw new Error();
        for(const evidencePath of row.evidence_paths) {
          const file=read(evidencePath);
          if(r.version>=2 && evidencePath!==path && !r.assertion_evidence?.some(e=>e.path===file.path && e.sha256===file.sha256)) throw new Error();
        }
        candidates.push({row, path, at: r.at, command_status: command.status});
      } catch { problems.push({path, reason: 'invalid_or_missing_assertion_evidence'}); }
    }
  }
  if(existsSync(resolve(dir,'execution/browser-pending-operation.json'))) {
    try {
      const pending=json('execution/browser-pending-operation.json');
      if(!id(pending?.request_id) || pending.dispatch_id!==state.dispatch_id || !/^[a-f0-9]{64}$/.test(pending.request_sha256 ?? '')) throw new Error();
      const matches=groups.get(pending.request_id) ?? [];
      const acknowledged=matches.length && new Set(matches.map(e=>JSON.stringify(e.receipt))).size===1 && matches.every(({receipt:r})=>r.status==='completed' && r.request_sha256===pending.request_sha256 && r.dispatch_id===pending.dispatch_id && (r.run_id===undefined || r.run_id===state.run_id) && (r.invocation_id===undefined || r.invocation_id===state.invocation_id));
      if(!acknowledged && !unknown.some(r=>r.request_id===pending.request_id)) unknown.push({request_id:pending.request_id,reason:'transport_not_acknowledged'});
    } catch {problems.push({path:'execution/browser-pending-operation.json',reason:'invalid_pending_operation'});}
  }
  const duplicates = new Set(candidates.filter((c, i, all) => all.some((other, j) => j !== i && other.row.case_id === c.row.case_id)).map(c => c.row.case_id));
  for (const caseId of duplicates) problems.push({case_id: caseId, reason: 'conflicting_assertion_id'});
  const accepted = candidates.filter(c => !duplicates.has(c.row.case_id)).sort((a,b) => String(a.at).localeCompare(String(b.at)) || a.path.localeCompare(b.path));
  const originalRows = accepted.map(c => c.row);
  const result = browserResultSnapshot(state, originalRows, read, 'recovered');
  if(timedReceipts.some(r=>r.result?.performance!==undefined)) result.browser_performance_summary=summarizeBrowserPerformance(timedReceipts);
  // Old observations can contain credentials unknown to today's scrubber. Keep
  // provenance, not raw titles, expected values, DOM text, network bodies or URLs.
  result.cases = accepted.map(({row, path, command_status}) => {
    let caseRef;
    try {if(row.case_ref) {const ref=resolveCaseReference({source_path:row.case_ref.source_path,case_id:row.case_ref.case_id},read);if(ref.source_sha256===row.case_ref.source_sha256) caseRef=ref;}} catch {}
    return ({
    case_id: row.case_id, status: row.status,
    evidence_mode: ['real','simulated','simulation_affected'].includes(row.evidence_mode) ? row.evidence_mode : 'not_recorded',
    title: `Recovered assertion ${row.case_id}`, expected: 'See original restricted evidence',
    actual_result: `Recorded assertion status: ${row.status}`,
    evidence_paths: row.evidence_paths, receipt_path: path,
    ...(caseRef?{case_ref:caseRef}:{}),
    ...(id(row.recheck_of)?{recheck_of:row.recheck_of}:{}),
    ...(typeof row.check_fingerprint==='string' && /^[a-f0-9]{64}$/.test(row.check_fingerprint)?{check_fingerprint:row.check_fingerprint}:{}),
    ...(row.timing?.mode==='standalone_observation'?{timing:{mode:'standalone_observation'}}:{}),
    ...(['ui','api_contract'].includes(row.verification_scope?.layer)?{verification_scope:{layer:row.verification_scope.layer}}:{}),
    ...(['source_located','not_recorded','needs_correction'].includes(row.expectation_provenance?.status)?{expectation_provenance:{status:row.expectation_provenance.status,semantic_verified:false,approval_required:false,redacted:true}}:{}),
    ...(['exact_text','normalized_text','exact_value','visible','hidden','count','readonly','editable','enabled','disabled'].includes(row.comparison)?{comparison:row.comparison}:{}),
    command_completed: command_status === 'completed'
  });});
  result.unknown_operations = unknown;
  result.recovery = {version: 1, problems,
    statistics_basis: 'Source receipt assertions before free-text projection; re-run this reducer to verify statistics, not the redacted projection.',
    free_text_policy: 'Original free text excluded; recovery is not a new execution or completed command.',
    integrity_scope: 'Version 2 receipts bind assertion evidence hashes. Legacy receipt evidence is indexed as observed now; historical tampering cannot be ruled out. Source hashes are integrity checks, not authenticity signatures.',
    sources: [...sources.values()].sort((a,b) => a.path.localeCompare(b.path))};
  // Detect concurrent replacement; callers must retain this index with delivery.
  for (const source of result.recovery.sources) if (readRunFile(dir, source.path).sha256 !== source.sha256) throw new Error('Recovery source changed during read');
  result.recovery.source_index_sha256 = digest(JSON.stringify(result.recovery.sources));
  return result;
}
