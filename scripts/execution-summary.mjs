import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRunFile } from './design-quality.mjs';

// A derived view, never a rewrite of either execution branch.
export function executionSummary(dir, manifest, { partial = false } = {}) {
  const selected = manifest.orchestration?.plan?.execution_branches ?? manifest.orchestration?.plan?.stages?.filter(s => s.selected && ['execution','api_execution'].includes(s.id)).map(s => s.id) ?? [];
  const sources = [], limitations = [], cases = [];
  for (const stage of selected) {
    const path = stage === 'api_execution' ? 'execution/api/test_results.json' : 'execution/test_results.json';
    const dispatch = manifest.orchestration?.events?.filter(e => e.type === 'dispatched' && e.stage === stage).at(-1);
    const state = manifest.stages?.[stage]?.status;
    if (!existsSync(resolve(dir, path))) { limitations.push(`${stage}: no result`); continue; }
    const file = readRunFile(dir, path), value = JSON.parse(file.data);
    if (value.run_id !== manifest.run_id || stage === 'api_execution' && value.dispatch_id !== dispatch?.dispatch_id) throw new Error('Execution summary rejected stale branch identity');
    if (stage === 'execution') {
      const event = manifest.orchestration.events.filter(e => e.type === 'completed' && e.stage === stage && e.dispatch_id === dispatch?.dispatch_id).at(-1);
      const bound = event?.evidence?.artifact_contract?.files?.find(f => f.path === path);
      if (!bound || bound.sha256 !== file.sha256) { limitations.push('execution: unsealed UI result'); continue; }
    }
    if (!value.finished_at || !['completed','failed','blocked','cancelled'].includes(state) && stage !== 'api_execution') limitations.push(`${stage}: running or waiting`);
    if (value.status === 'partial') limitations.push(`${stage}: partial scope`);
    sources.push({ stage, path, sha256: file.sha256, dispatch_id: dispatch?.dispatch_id, status: value.status, statistics: value.statistics ?? null });
    for (const row of value.cases ?? []) cases.push({ ...row, source_branch: stage, source_path: path, source_sha256: file.sha256 });
  }
  const terminal = sources.length === selected.length && sources.every(s => JSON.parse(readRunFile(dir,s.path).data).finished_at);
  if (!partial && !terminal) throw new Error('Selected execution branches are not terminal; only a requested partial snapshot is available');
  return { version: 1, run_id: manifest.run_id, snapshot_at: new Date().toISOString(), status: terminal && !limitations.length ? 'completed' : 'partial', selected_branches: selected, sources, limitations, cases, summary: { total: cases.length, ...Object.fromEntries(['passed','failed','blocked','skipped'].map(s => [s,cases.filter(c => c.status === s).length])) } };
}
