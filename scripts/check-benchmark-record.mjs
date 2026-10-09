import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkBenchmarkRecord } from './benchmark-record.mjs';

try {
  const file = process.argv.find(arg => arg.startsWith('--record='))?.slice(9);
  if (!file) throw new Error('--record=<JSON path> required');
  const result = checkBenchmarkRecord(JSON.parse(readFileSync(resolve(file), 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ passed: false, errors: [error.message] }));
  process.exitCode = 1;
}
