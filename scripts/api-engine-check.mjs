import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readRunFile } from './design-quality.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const implementationSha256 = hash(Buffer.concat([
  readFileSync(new URL('./api-engine.mjs', import.meta.url)),
  readFileSync(new URL('./api-worker.mjs', import.meta.url)),
]));

// Verify that a collected API run really produced sealed request evidence.
export function inspectApiEngineCheck(dir, runId) {
  const design = readRunFile(dir, 'execution/api/cases.json');
  const output = readRunFile(dir, 'execution/api/test_results.json');
  const prepared = JSON.parse(design.data);
  const result = JSON.parse(output.data);
  if (result.run_id !== runId || result.layer !== 'api' || !Array.isArray(result.cases) ||
      !Array.isArray(result.evidence) || !Number.isSafeInteger(result.statistics?.requests) ||
      result.design_sha256 !== prepared.source_sha256 || result.dispatch_id !== prepared.dispatch_id ||
      result.attempt_id !== prepared.attempt_id)
    throw new Error('API engine result has invalid run identity or statistics');
  const evidence = result.evidence.map(item => {
    if (!/^execution\/api\/evidence\/[A-Za-z0-9-]+\.json$/.test(item.path))
      throw new Error('API engine evidence path is invalid');
    const file = readRunFile(dir, item.path);
    if (file.sha256 !== item.sha256) throw new Error(`API engine evidence changed: ${item.path}`);
    return { path: file.path, sha256: file.sha256 };
  });
  if (new Set(evidence.map(item => item.path)).size !== evidence.length ||
      evidence.length !== result.statistics.requests)
    throw new Error('API engine request count differs from sealed evidence');
  const evidencePaths = new Set(evidence.map(item => item.path));
  if (result.cases.some(item => (item.evidence_paths ?? []).some(path => !evidencePaths.has(path))))
    throw new Error('API case references evidence outside the sealed request set');
  const total = result.cases.length;
  if (result.summary?.total !== total ||
      ['passed', 'failed', 'blocked', 'skipped'].some(status =>
        result.summary[status] !== result.cases.filter(item => item.status === status).length))
    throw new Error('API engine case summary differs from sealed results');
  const complete = result.status === 'completed' && result.statistics.requests > 0;
  return { tool_id: 'exec.api_engine', implementation: 'scripts/api-engine.mjs + scripts/api-worker.mjs',
    implementation_sha256: implementationSha256,
    status: complete ? 'completed' : result.status === 'completed' ? 'not_applicable' : 'partial',
    input: { path: design.path, sha256: design.sha256 },
    output: { path: output.path, sha256: output.sha256 },
    request_count: result.statistics.requests, case_count: total, evidence_count: evidence.length,
    ...(complete ? {} : { reason: result.status === 'completed' ? 'no_requests_executed' : 'execution_not_complete' }) };
}
