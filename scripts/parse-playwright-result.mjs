import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attemptDirectory } from './execution-attempts.mjs';
import { parsePlaywrightResults } from './playwright-results.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s)));
if (!args['run-id'] || !args['invocation-id'] || !['0', '1'].includes(args['exit-code'])) throw new Error('Read-only parser: --run-id=<run> --invocation-id=<id> --exit-code=0|1; publishing belongs to the execution runner');
const dir = attemptDirectory(resolve(import.meta.dirname, '..'), args['run-id'], args['invocation-id']);
const read = path => JSON.parse(readFileSync(resolve(dir, path), 'utf8'));
console.log(JSON.stringify(parsePlaywrightResults({ raw: read('playwright/playwright-results.json'), plan: read('inputs/execution-plan.json'), runId: args['run-id'], invocationId: args['invocation-id'], attemptDir: dir, exitCode: Number(args['exit-code']) }), null, 2));
