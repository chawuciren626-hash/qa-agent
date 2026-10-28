#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MiniprogramError } from './miniprogram-devtools.mjs';
import { miniprogramOperations, runMiniprogramOperation } from './miniprogram-task.mjs';

function usage() {
  return [
    'Usage: node scripts/miniprogram-task-cli.mjs --run-dir <dir> --operation <json>',
    '       node scripts/miniprogram-task-cli.mjs --run-dir <dir> --operation-file <file>',
    '',
    'Options:',
    '  --run-dir <dir>          Run directory that holds execution/ (required)',
    '  --operation <json>       Structured mini program operation JSON',
    '  --operation-file <file>  JSON file containing one operation',
    '  --project <dir>          Mini program project directory containing project.config.json',
    '  --devtools-cli <file>    WeChat DevTools CLI (defaults to WECHAT_DEVTOOLS_CLI or standard paths)',
    '  --target <kind>          devtools (default) or device (reported unsupported)',
    '  --port <number>          DevTools automation port (default 9420)',
    '',
    `Operations: ${miniprogramOperations.join(', ')}`
  ].join('\n');
}

export function parseArgs(argv) {
  const options = {
    runDirectory: null,
    operation: null,
    operationFile: null,
    projectDirectory: process.env.MINIPROGRAM_PROJECT,
    devtoolsCli: process.env.WECHAT_DEVTOOLS_CLI,
    targetKind: process.env.MINIPROGRAM_TARGET ?? 'devtools',
    port: process.env.MINIPROGRAM_DEVTOOLS_PORT ? Number(process.env.MINIPROGRAM_DEVTOOLS_PORT) : 9420
  };
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
    else if (arg === '--project') options.projectDirectory = next();
    else if (arg === '--devtools-cli') options.devtoolsCli = next();
    else if (arg === '--target') options.targetKind = next();
    else if (arg === '--port') options.port = Number(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readOperation(options) {
  const sources = [options.operation, options.operationFile].filter(value => value !== undefined && value !== null);
  if (sources.length !== 1) throw new Error('Provide exactly one of --operation or --operation-file');
  if (options.operation !== undefined) {
    try { return JSON.parse(options.operation); }
    catch (error) { throw new Error(`--operation is not valid JSON: ${error.message}`); }
  }
  const path = resolve(options.operationFile);
  if (!existsSync(path)) throw new Error(`Operation file does not exist: ${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Operation file is not valid JSON: ${error.message}`); }
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
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
    process.stderr.write('--port must be an integer between 1 and 65535\n');
    return 2;
  }
  let operation;
  try { operation = readOperation(options); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    const result = await runMiniprogramOperation({
      runDirectory: options.runDirectory,
      operation,
      projectDirectory: options.projectDirectory,
      devtoolsCli: options.devtoolsCli,
      targetKind: options.targetKind,
      port: options.port
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'ok' && !result.duplicate ? 0 : 1;
  } catch (error) {
    const payload = {
      status: 'blocked',
      error: error.message,
      category: error instanceof MiniprogramError ? error.category : 'command_failed'
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
