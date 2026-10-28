#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AndroidAdbError } from './android-adb.mjs';
import { androidOperations, runAndroidOperation } from './android-task.mjs';

function usage() {
  return [
    'Usage: node scripts/android-task-cli.mjs --run-dir <dir> --operation <json>',
    '       node scripts/android-task-cli.mjs --run-dir <dir> --operation-file <file>',
    '',
    'Options:',
    '  --run-dir <dir>          Run directory that holds execution/ (required)',
    '  --operation <json>       Structured Android operation JSON',
    '  --operation-file <file>  JSON file containing one operation',
    '  --sdk-root <dir>         Android SDK root for preflight checks',
    '  --allow-package <name>   Allowed package (repeatable or comma separated)',
    '  --no-java-check          Skip the Java probe during doctor',
    '',
    `Operations: ${androidOperations.join(', ')}`
  ].join('\n');
}

export function parseArgs(argv) {
  const options = { runDirectory: null, operation: null, sdkRoot: undefined, allowedPackages: [], checkJava: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--run-dir') options.runDirectory = next();
    else if (arg === '--operation') options.operation = next();
    else if (arg === '--operation-file') options.operationFile = next();
    else if (arg === '--sdk-root') options.sdkRoot = next();
    else if (arg === '--allow-package') options.allowedPackages.push(...next().split(',').map(value => value.trim()).filter(Boolean));
    else if (arg === '--no-java-check') options.checkJava = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readOperation(options) {
  const sources = [options.operation, options.operationFile].filter(value => value !== undefined && value !== null);
  if (sources.length !== 1) throw new Error('Provide exactly one of --operation or --operation-file');
  if (options.operation !== undefined) {
    try { return JSON.parse(options.operation); } catch (error) { throw new Error(`--operation is not valid JSON: ${error.message}`); }
  }
  const path = resolve(options.operationFile);
  if (!existsSync(path)) throw new Error(`Operation file does not exist: ${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`Operation file is not valid JSON: ${error.message}`); }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!options.runDirectory) {
    process.stderr.write(`--run-dir is required\n\n${usage()}\n`);
    return 2;
  }
  let operation;
  try {
    operation = readOperation(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    const result = await runAndroidOperation({
      runDirectory: options.runDirectory,
      operation,
      allowedPackages: options.allowedPackages,
      sdkRoot: options.sdkRoot,
      checkJava: options.checkJava
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'ok' && !result.duplicate ? 0 : 1;
  } catch (error) {
    const payload = {
      status: 'blocked',
      error: error.message,
      category: error instanceof AndroidAdbError ? error.category : 'command_failed'
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
