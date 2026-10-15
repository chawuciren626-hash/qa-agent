import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOptions, validateCommandArguments } from './command-contracts.mjs';
import { extendRunPlan } from './run-plan-extension.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
validateCommandArguments('extend-run-plan.mjs', args);
const options = parseOptions(args, ['run-id', 'stages', 'reason']);
const project = JSON.parse(readFileSync(resolve(root, 'config/project.json'), 'utf8'));
console.log(JSON.stringify(extendRunPlan(root, project, options['run-id'], options.stages.split(','), options.reason), null, 2));
