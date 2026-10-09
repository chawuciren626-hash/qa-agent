import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectDesign, runDirectory } from './design-quality.mjs';

const root = resolve(import.meta.dirname, '..');
const runId = process.argv.find(a => a.startsWith('--run-id='))?.slice(9);
const dir = runDirectory(root, runId);
const source = process.argv.find(a => a.startsWith('--cases='))?.slice(8) ?? resolve(dir, 'design/test_cases.json');
const result = inspectDesign({ root, runId, source, execution: !process.argv.includes('--draft') });
const { cases, ...report } = result;
const target = resolve(dir, 'quality/design-validation.json');
mkdirSync(resolve(dir, 'quality'), { recursive: true });
writeFileSync(target, JSON.stringify({ ...report, mode: process.argv.includes('--draft') ? 'draft' : 'execution', checked_at: new Date().toISOString() }, null, 2) + '\n');
console.log(JSON.stringify({ ...report, report: target }, null, 2));
process.exitCode = report.errors.length ? 2 : 0;
