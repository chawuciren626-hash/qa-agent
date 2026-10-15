import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export function parsePlaywrightResults({ raw, plan, runId, invocationId, attemptDir, exitCode }) {
  if (!raw || !Array.isArray(raw.suites) || !raw.stats || !Number.isFinite(Date.parse(raw.stats.startTime))) throw new Error('Malformed Playwright report');
  if (raw.errors?.length) throw new Error('Playwright reported global errors; inspect raw result');
  const planned = new Map(plan.cases.map(row => [row.case_id, row]));
  const cases = new Map();
  const walk = suite => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const caseId = (spec.title ?? '').match(/\bTC-[A-Z0-9-]+\b/)?.[0] ?? spec.title;
      if (!planned.has(caseId)) throw new Error(`Unexpected executed case: ${caseId}`);
      if (!Array.isArray(test.results) || !test.results.length) throw new Error(`Missing test outcome: ${caseId}`);
      const last = test.results.at(-1);
      if (!['passed', 'failed', 'timedOut', 'skipped'].includes(last.status)) throw new Error(`Interrupted/unknown case status: ${caseId}`);
      const attachments = test.results.flatMap(result => result.attachments ?? []).map(item => item.path).filter(Boolean);
      for (const path of attachments) {
        const target = resolve(attemptDir, path);
        if (!existsSync(target)) throw new Error(`Missing evidence: ${path}`);
        const rel = relative(realpathSync(attemptDir), realpathSync(target));
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Evidence outside current attempt');
        if (!readFileSync(target).length) throw new Error(`Empty evidence: ${path}`);
      }
      const status = last.status === 'passed' ? 'passed' : last.status === 'skipped' ? 'skipped' : 'failed';
      const previous = cases.get(caseId);
      const result = { case_id: caseId, status, duration_ms: test.results.reduce((sum, item) => sum + (item.duration ?? 0), 0), error_message: last.error?.message ?? '', failure_category: status === 'failed' ? 'needs_review' : 'none', evidence_paths: [...new Set(attachments.map(path => resolve(attemptDir, path)))], retries: test.results.map(item => ({ retry: item.retry ?? 0, status: item.status, duration_ms: item.duration ?? 0 })), flaky: status === 'passed' && test.results.some(item => ['failed', 'timedOut'].includes(item.status)), asset_refs: planned.get(caseId).asset_refs ?? [], execution_contract: planned.get(caseId).execution_contract ?? null };
      if (!previous) cases.set(caseId, result);
      else cases.set(caseId, {
        ...previous,
        status: previous.status === 'failed' || status === 'failed' ? 'failed' : previous.status === 'passed' || status === 'passed' ? 'passed' : 'skipped',
        duration_ms: previous.duration_ms + result.duration_ms,
        error_message: [previous.error_message, result.error_message].filter(Boolean).join('\n'),
        failure_category: previous.status === 'failed' || status === 'failed' ? 'needs_review' : 'none',
        evidence_paths: [...new Set([...previous.evidence_paths, ...result.evidence_paths])],
        retries: [...previous.retries, ...result.retries],
        flaky: previous.flaky || result.flaky
      });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  raw.suites.forEach(walk);
  if (cases.size !== planned.size) throw new Error('Execution omitted planned cases');
  const mergedCases = [...cases.values()];
  const summary = { total: mergedCases.length, passed: 0, failed: 0, skipped: 0, blocked: 0 };
  for (const item of mergedCases) summary[item.status]++;
  if (!summary.passed && !summary.failed) throw new Error('No executed cases');
  if ((exitCode === 0 && summary.failed) || (exitCode !== 0 && !summary.failed) || ![0, 1].includes(exitCode)) throw new Error('Process exit code conflicts with case outcomes');
  return { run_id: runId, invocation_id: invocationId, status: summary.failed ? 'failed' : 'completed', started_at: raw.stats.startTime, finished_at: new Date().toISOString(), summary, cases: mergedCases, asset_refs: [...new Map(mergedCases.flatMap(row => row.asset_refs).map(asset => [`${asset.id}@${asset.version}`, asset])).values()] };
}
