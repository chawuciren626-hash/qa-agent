import { resolve } from 'node:path';
import { inspectStageArtifacts } from './artifact-contracts.mjs';

const [runId, stage, ...args] = process.argv.slice(2);
const options = Object.fromEntries(args.filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => arg.slice(2).split(/=(.*)/s)));
const result = inspectStageArtifacts(resolve(import.meta.dirname, '..'), runId, stage, { mode: options.mode ?? 'execute', artifacts: (options.artifacts ?? '').split(',').filter(Boolean) });
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'passed') process.exitCode = 2;
