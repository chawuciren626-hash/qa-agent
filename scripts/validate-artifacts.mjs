import { resolve } from 'node:path';
import { inspectStageArtifacts } from './artifact-contracts.mjs';
import { readFileSync } from 'node:fs';
import { runDirectory } from './design-quality.mjs';
import { wslTestList } from './wsl-test-list.mjs';

const [runId, stage, ...args] = process.argv.slice(2);
const options = Object.fromEntries(args.filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => arg.slice(2).split(/=(.*)/s)));
const result = inspectStageArtifacts(resolve(import.meta.dirname, '..'), runId, stage, { mode: options.mode ?? 'execute', artifacts: (options.artifacts ?? '').split(',').filter(Boolean) });
if (result.status === 'passed' && stage === 'execution' && options.mode === 'prepare') {
  const root = resolve(import.meta.dirname, '..');
  const plan = JSON.parse(readFileSync(resolve(runDirectory(root, runId), 'execution/execution-plan.json'), 'utf8'));
  if (plan.execution_policy?.sandbox_backend === 'wsl') {
    try { result.script_sandbox = await wslTestList(root, runId, plan); }
    catch (error) { result.status = 'blocked'; result.errors = [...(result.errors ?? []), error.message]; }
  }
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'passed') process.exitCode = 2;
