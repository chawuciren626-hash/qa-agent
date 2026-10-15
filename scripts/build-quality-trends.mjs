import { dataPath } from './directory-context.mjs';
import { resolve } from 'node:path';
import { atomicJson } from './execution-attempts.mjs';
import { buildQualityTrends } from './quality-index.mjs';

const root = resolve(import.meta.dirname, '..');
const limit = Number(process.argv.find(arg => arg.startsWith('--limit='))?.slice(8) ?? 20);
const output = buildQualityTrends(root, limit);
const target = dataPath(root, 'output/quality/quality-trends.json');
atomicJson(target, output);
console.log(JSON.stringify({ ...output.summary, skipped: output.skipped, output: target }, null, 2));
