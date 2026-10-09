import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { governedDefects } from './defect-lifecycle.mjs';
import { verifyCurrentAttempt } from './execution-attempts.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
function runs(root) {
  const base = resolve(root, 'output/runs');
  return (existsSync(base) ? readdirSync(base, { withFileTypes: true }) : []).filter(entry => entry.isDirectory() && /^run-[A-Za-z0-9-]+$/.test(entry.name)).map(entry => ({ id: entry.name, dir: resolve(base, entry.name) })).filter(run => !existsSync(resolve(run.dir, 'inputs/fixture-origin.json')) && !existsSync(resolve(run.dir, 'inputs/acceptance.json')));
}
export function buildDefectIndex(root) {
  const groups = new Map(); const warnings = [];
  for (const run of runs(root)) {
    const path = resolve(run.dir, 'defects/defect-records.json');
    if (!existsSync(path)) continue;
    try {
      const data = read(path);
      if (data.run_id !== run.id) throw new Error('Defect run identity mismatch');
      const view = governedDefects(root, run.id, data);
      const seen = new Set();
      const pending = new Map();
      for (const record of [...view.current, ...view.history]) {
        if (!record.fingerprint || !record.defect_id) throw new Error('Defect identity missing');
        const occurrence = `${record.origin_invocation_id ?? data.invocation_id ?? 'legacy'}:${record.defect_id}`;
        if (seen.has(occurrence)) continue; seen.add(occurrence);
        const scope = record.scope_id ?? run.id;
        const key = JSON.stringify([scope, record.fingerprint]);
        const group = pending.get(key) ?? (groups.has(key) ? structuredClone(groups.get(key)) : { scope_id: scope, fingerprint: record.fingerprint, canonical_defect_id: record.defect_id, title: record.title, category: record.category, occurrences: [] });
        group.occurrences.push({ run_id: run.id, invocation_id: record.origin_invocation_id ?? data.invocation_id ?? null, defect_id: record.defect_id, lifecycle_status: record.lifecycle_status, confidence: record.confidence, related_cases: record.related_cases });
        pending.set(key, group);
      }
      for (const [key, group] of pending) groups.set(key, group);
    } catch (error) { warnings.push({ run_id: run.id, reason: error.message }); }
  }
  const defects = [...groups.values()].map(group => ({ ...group, occurrence_count: group.occurrences.length }));
  return { generated_at: new Date().toISOString(), grouping: 'scoped_duplicate_candidates_only', unique_defects: defects.length, repeated_defects: defects.filter(group => group.occurrence_count > 1).length, defects, warnings };
}
export function buildQualityTrends(root, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Trend limit must be a positive integer');
  const points = []; const skipped = [];
  for (const run of runs(root)) {
    const path = resolve(run.dir, 'report/quality-metrics.json');
    if (!existsSync(path)) continue;
    try {
      const metrics = read(path);
      if (metrics.run_id !== run.id) throw new Error('Metric run identity mismatch');
      const statePath = resolve(run.dir, 'execution/execution-state.json');
      const state = existsSync(statePath) ? read(statePath) : null;
      if (state && !isDeepStrictEqual(state, metrics.trust?.execution_state)) throw new Error('Stale execution metrics');
      if (state?.version === 2 && ['completed', 'failed'].includes(state.status)) verifyCurrentAttempt(root, run.id, state, read(resolve(run.dir, 'execution/test_results.json')));
      const data = read(resolve(run.dir, 'defects/defect-records.json'));
      const lifecycle = governedDefects(root, run.id, data);
      if (!isDeepStrictEqual(metrics.governance, { ...lifecycle, integrity_error: null })) throw new Error('Stale or missing lifecycle metrics');
      points.push({ run_id: run.id, invocation_id: state?.invocation_id ?? null, generated_at: metrics.generated_at, pass_rate: metrics.execution?.pass_rate, failed: metrics.execution?.failed, gate_status: metrics.quality_gate?.status, defects: metrics.defects?.total ?? 0, open_historical: lifecycle.open_historical.length });
    } catch (error) { skipped.push({ run_id: run.id, reason: error.message }); }
  }
  points.sort((a, b) => String(a.generated_at).localeCompare(String(b.generated_at)));
  return { generated_at: new Date().toISOString(), runs: points.slice(-limit), summary: { total_runs: points.length, skipped_runs: skipped.length }, skipped };
}
