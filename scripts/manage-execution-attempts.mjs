import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { recoverAttempt, verifyAttempt } from './execution-attempts.mjs';
import { runDirectory } from './design-quality.mjs';

const [command, runId, ...params] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
const output = resolve(runDirectory(root, runId), 'execution');
if (command === 'list') {
  const dir = resolve(output, 'attempts');
  const attempts = existsSync(dir) ? readdirSync(dir).map(id => {
    const file = resolve(dir, id, 'attempt.json');
    if (!existsSync(file)) return { invocation_id: id, status: 'unsealed' };
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return { invocation_id: id, status: value.status, started_at: value.started_at, finished_at: value.finished_at, duration_ms: value.duration_ms, reason: value.reason };
  }).sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? '')) : [];
  const lock = resolve(output, 'execution.lock.json');
  console.log(JSON.stringify({ run_id: runId, lock: existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf8')) : null, attempts }, null, 2));
} else if (command === 'verify') {
  const manifest = verifyAttempt(root, runId, params[0]);
  console.log(JSON.stringify({ run_id: runId, invocation_id: manifest.invocation_id, status: 'integrity_verified', files: manifest.files.length }));
} else if (command === 'recover') {
  const reason = params.find(arg => arg.startsWith('--reason='))?.slice(9);
  console.log(JSON.stringify(recoverAttempt(root, runId, reason, params.includes('--confirm-stopped')), null, 2));
} else throw new Error('Use list <run>, verify <run> <invocation>, or recover <run> --confirm-stopped --reason=<reason>');
