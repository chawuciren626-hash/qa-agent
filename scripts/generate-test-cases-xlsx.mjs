import { resolve } from "node:path";
import { spawnSync } from 'node:child_process';
import { probePython } from './command-runtime.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("用法: node scripts/generate-test-cases-xlsx.mjs <test_cases.json> <test_cases.xlsx>");

const python = probePython();
if (python.status !== 'ready') throw new Error(python.reason);
const result = spawnSync(python.executable, [resolve(import.meta.dirname, 'generate-test-cases-workbook.py'), resolve(input), resolve(output)], {
  shell: false, windowsHide: true, encoding: 'utf8', timeout: 120000,
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
});
if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
console.log(result.stdout.trim());
