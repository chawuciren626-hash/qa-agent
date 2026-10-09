import { resolve } from 'node:path';
import { atomicJson } from './execution-attempts.mjs';
import { buildDefectIndex } from './quality-index.mjs';

const root = resolve(import.meta.dirname, '..');
const output = buildDefectIndex(root);
const target = resolve(root, 'output/quality/defect-index.json');
atomicJson(target, output);
console.log(JSON.stringify({ unique_defects: output.unique_defects, repeated_defects: output.repeated_defects, warnings: output.warnings, output: target }, null, 2));
