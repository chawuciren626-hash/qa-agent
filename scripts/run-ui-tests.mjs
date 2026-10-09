import { resolve } from 'node:path';
import { executeAttempt } from './execution-runner.mjs';

const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9);
if (!runId) throw new Error('Use --run-id=<run_id> [--headed]');
const abort = new AbortController();
const cancel = () => abort.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  const outcome = await executeAttempt(resolve(import.meta.dirname, '..'), runId, { headed: process.argv.includes('--headed'), signal: abort.signal });
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.reason) console.error(outcome.reason);
  process.exitCode = outcome.code;
} catch (error) {
  console.error(error.message);
  process.exitCode = 3;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
