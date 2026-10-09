import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeRun } from './run-status-summary.mjs';

const [runId, ...extra] = process.argv.slice(2);
try {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '') || extra.length) throw new Error('Usage: show-run-status.mjs <run_id>');
  const root = resolve(import.meta.dirname, '..');
  const project = JSON.parse(readFileSync(resolve(root, 'config/project.json'), 'utf8'));
  const raw = readFileSync(resolve(root, project.run_root, runId, 'manifest.json'));
  console.log(JSON.stringify(summarizeRun(raw, runId), null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'summary_unavailable', error: error.message, next_action: 'stop_and_request_review' }, null, 2));
  process.exitCode = 2;
}
