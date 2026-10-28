import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export const androidFailureCategories = Object.freeze([
  'adb_not_found',
  'adb_timeout',
  'adb_server_error',
  'adb_connection_lost',
  'device_not_found',
  'device_offline',
  'device_unauthorized',
  'device_permission_denied',
  'device_ambiguous',
  'device_locked',
  'device_not_booted',
  'app_error',
  'app_focus_timeout',
  'package_not_installed',
  'package_not_allowed',
  'launcher_unresolved',
  'no_active_session',
  'session_blocked',
  'duplicate_case_id',
  'unsupported_input',
  'locator_not_found',
  'locator_ambiguous',
  'precondition_failed',
  'command_failed'
]);

export class AndroidAdbError extends Error {
  constructor(category, message, details = {}) {
    super(message);
    this.name = 'AndroidAdbError';
    this.category = androidFailureCategories.includes(category) ? category : 'command_failed';
    this.details = details;
  }
}

export const infrastructureCategories = Object.freeze(new Set([
  'adb_not_found', 'adb_timeout', 'adb_server_error', 'adb_connection_lost',
  'device_not_found', 'device_offline', 'device_unauthorized', 'device_permission_denied', 'device_ambiguous'
]));

function validateArguments(args) {
  if (!Array.isArray(args) || !args.length) throw new Error('adb arguments must be a non-empty array');
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg || arg.length > MAX_ARGUMENT_LENGTH || /[\0\r\n]/.test(arg)) {
      throw new Error('adb argument is empty, too long, or contains a control character');
    }
  }
}

export function resolveAdbCommand({ explicit, env = process.env } = {}) {
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [];
  const add = value => {
    if (!value) return;
    candidates.push(/[\\/]/.test(value) ? resolve(value) : value);
  };
  add(explicit);
  add(env.ANDROID_ADB);
  for (const root of [env.ANDROID_SDK_ROOT, env.ANDROID_HOME]) {
    if (root) candidates.push(resolve(root, 'platform-tools', executable));
  }
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir) candidates.push(resolve(dir, executable));
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new AndroidAdbError('adb_not_found', 'adb executable was not found; set ANDROID_ADB or ANDROID_HOME');
}

export function createAdbRunner({ command, prefixArgs = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const executable = command ?? resolveAdbCommand();
  if (typeof executable !== 'string' || !executable) throw new Error('adb command is required');
  if (!Array.isArray(prefixArgs) || prefixArgs.some(arg => typeof arg !== 'string')) throw new Error('adb prefix args must be strings');
  return {
    command: executable,
    prefixArgs: [...prefixArgs],
    run(args, { timeout = timeoutMs } = {}) {
      validateArguments(args);
      return new Promise(resolveRun => {
        execFile(executable, [...prefixArgs, ...args], {
          windowsHide: true,
          timeout,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'buffer'
        }, (error, stdout, stderr) => {
          const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
          const failure = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
          const timedOut = Boolean(error) && (error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT');
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolveRun({
            code,
            stdout: output,
            stderr: failure,
            timedOut,
            errorCode: error?.code ?? null,
            signal: error?.signal ?? null
          });
        });
      });
    }
  };
}

export function adbText(result) {
  if (!result) return '';
  return Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout ?? '');
}

export function adbErrorText(result) {
  if (!result) return '';
  return Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
}

export function parseAdbDevices(text) {
  const devices = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^List of devices attached/i.test(line) || /^\*/.test(line)) continue;
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const serial = match[1];
    const rest = match[2].trim();
    let state;
    let details = '';
    if (/^no permissions\b/i.test(rest)) {
      state = 'no permissions';
      details = rest;
    } else {
      const parts = rest.split(/\s+/);
      state = parts.shift() ?? 'unknown';
      details = parts.join(' ');
    }
    devices.push({ serial, state, details });
  }
  return devices;
}

export function classifyAdbFailure(result, phase = 'adb') {
  const combined = `${adbText(result)}\n${adbErrorText(result)}`;
  if (result?.timedOut) return 'adb_timeout';
  if (result?.errorCode === 'ENOENT') return 'adb_not_found';
  if (/device offline/i.test(combined)) return 'device_offline';
  if (/unauthorized/i.test(combined)) return 'device_unauthorized';
  if (/no permissions/i.test(combined)) return 'device_permission_denied';
  if (/more than one (?:device|emulator)/i.test(combined)) return 'device_ambiguous';
  if (/no devices\/emulators found|device '[^']+' not found|device not found/i.test(combined)) return 'device_not_found';
  if (/failed to (?:start|connect to) (?:the )?adb server|adb server (?:version|didn't ack|is out of date)|cannot connect to daemon/i.test(combined)) return 'adb_server_error';
  if (/connection reset|connection closed|protocol fault|broken pipe|cannot connect/i.test(combined)) return 'adb_connection_lost';
  if (/INSTALL_FAILED|Error: Activity not started|Unknown package|does not exist/i.test(combined)) return 'app_error';
  return 'command_failed';
}

export function assertAdbSuccess(result, phase = 'adb', { actionStarted = false } = {}) {
  if (result && result.code === 0 && !result.timedOut) return result;
  const category = classifyAdbFailure(result, phase);
  const detail = (adbErrorText(result) || adbText(result)).trim().slice(0, 600);
  throw new AndroidAdbError(category, `${phase} failed${detail ? `: ${detail}` : ''}`, {
    phase,
    code: result?.code ?? null,
    timed_out: result?.timedOut === true,
    action_started: actionStarted
  });
}

export function selectDevice(devices, requested) {
  if (!Array.isArray(devices) || !devices.length) throw new AndroidAdbError('device_not_found', 'No Android device or emulator is connected');
  const bySerial = requested ? devices.filter(device => device.serial === requested) : devices;
  if (requested && !bySerial.length) throw new AndroidAdbError('device_not_found', `Requested device ${requested} is not connected`);
  const usable = bySerial.filter(device => device.state === 'device');
  if (!usable.length) {
    const first = bySerial[0];
    if (first.state === 'unauthorized') throw new AndroidAdbError('device_unauthorized', `Device ${first.serial} is unauthorized; confirm the USB debugging prompt on the device`);
    if (first.state === 'offline') throw new AndroidAdbError('device_offline', `Device ${first.serial} is offline`);
    if (first.state === 'no permissions') throw new AndroidAdbError('device_permission_denied', `Device ${first.serial} is not accessible: ${first.details}`);
    throw new AndroidAdbError('device_not_found', `Device ${first.serial} is not ready (state: ${first.state})`);
  }
  if (!requested && usable.length > 1) throw new AndroidAdbError('device_ambiguous', `Multiple Android devices are connected (${usable.map(device => device.serial).join(', ')}); specify a device serial`);
  return usable[0];
}

export async function listDevices(runner) {
  const result = await runner.run(['devices', '-l'], { timeout: 15000 });
  assertAdbSuccess(result, 'adb devices');
  return parseAdbDevices(adbText(result));
}

export async function ensureDeviceState(runner, serial) {
  const result = await runner.run(['-s', serial, 'get-state'], { timeout: 10000 });
  assertAdbSuccess(result, 'adb get-state');
  const state = adbText(result).trim();
  if (state !== 'device') {
    const category = state === 'offline' ? 'device_offline' : state === 'unauthorized' ? 'device_unauthorized' : 'device_not_found';
    throw new AndroidAdbError(category, `Device ${serial} state is ${state || 'unknown'}`);
  }
  return state;
}
