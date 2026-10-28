import { execFile } from 'node:child_process';
import { AndroidAdbError, adbErrorText, adbText, assertAdbSuccess } from './android-adb.mjs';
import { parseUiHierarchy } from './android-ui-tree.mjs';

const MAX_UI_XML_BYTES = 4 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_LOGCAT_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function parsePropLines(text) {
  const props = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line);
    if (match) props[match[1]] = match[2];
  }
  return props;
}

export async function readProps(runner, serial) {
  const result = await runner.run(['-s', serial, 'shell', 'getprop'], { timeout: 15000 });
  assertAdbSuccess(result, 'read device properties');
  return parsePropLines(adbText(result));
}

const COMPONENT = /([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/;

function componentFrom(output) {
  const match = COMPONENT.exec(String(output ?? ''));
  if (!match) return null;
  return {
    component: `${match[1]}/${match[2]}`,
    package_name: match[1],
    activity: match[2].startsWith('.') ? `${match[1]}${match[2]}` : match[2]
  };
}

export async function readCurrentActivity(runner, serial) {
  const attempts = [
    { args: ['shell', 'dumpsys', 'activity', 'activities'], source: 'dumpsys_activity' },
    { args: ['shell', 'dumpsys', 'window', 'windows'], source: 'dumpsys_window' }
  ];
  for (const attempt of attempts) {
    const result = await runner.run(['-s', serial, ...attempt.args], { timeout: 20000 });
    if (result.code !== 0 || result.timedOut) continue;
    const text = adbText(result);
    for (const key of ['mResumedActivity', 'topResumedActivity', 'mFocusedActivity', 'mCurrentFocus']) {
      const line = text.split(/\r?\n/).find(row => row.includes(key));
      const found = componentFrom(line);
      if (found) return { ...found, source: attempt.source, key };
    }
    const found = componentFrom(text);
    if (found) return { ...found, source: attempt.source, key: 'first_component' };
  }
  return { component: null, package_name: null, activity: null, source: null, key: null };
}

function firstBoolean(patterns, text) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return { value: match[1].toLowerCase() === 'true', pattern: pattern.source };
  }
  return { value: null, pattern: null };
}

export async function readScreenState(runner, serial) {
  const power = await runner.run(['-s', serial, 'shell', 'dumpsys', 'power'], { timeout: 15000 });
  const policy = await runner.run(['-s', serial, 'shell', 'dumpsys', 'window', 'policy'], { timeout: 15000 });
  const powerText = power.code === 0 ? adbText(power) : '';
  const policyText = policy.code === 0 ? adbText(policy) : '';
  const wakefulness = /mWakefulness[=:]\s*(\w+)/i.exec(powerText)?.[1] ?? null;
  const displayState = /Display Power:\s*state[=:]\s*(\w+)/i.exec(powerText)?.[1] ?? null;
  const locked = firstBoolean([
    /mKeyguardShowing[=:]\s*(true|false)/i,
    /KeyguardShowing[=:]\s*(true|false)/i,
    /showing[=:]\s*(true|false)/i
  ], policyText);
  return {
    wakefulness,
    display_state: displayState,
    awake: wakefulness ? wakefulness.toLowerCase() === 'awake' : displayState ? displayState.toLowerCase() === 'on' : null,
    locked: locked.value,
    lock_source: locked.pattern,
    policy_available: policy.code === 0
  };
}

export async function readAppInfo(runner, serial, packageName) {
  const path = await runner.run(['-s', serial, 'shell', 'pm', 'path', packageName], { timeout: 15000 });
  const pathText = adbText(path).trim();
  const installed = path.code === 0 && pathText.startsWith('package:');
  if (!installed) {
    return { package_name: packageName, installed: false, paths: [], version_name: null, version_code: null };
  }
  const details = await runner.run(['-s', serial, 'shell', 'dumpsys', 'package', packageName], { timeout: 20000 });
  const text = details.code === 0 ? adbText(details) : '';
  return {
    package_name: packageName,
    installed: true,
    paths: pathText.split(/\r?\n/).filter(Boolean),
    version_name: /versionName=(\S+)/.exec(text)?.[1] ?? null,
    version_code: /versionCode=(\d+)/.exec(text)?.[1] ?? null
  };
}

export async function resolveLauncherActivity(runner, serial, packageName) {
  const result = await runner.run(['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', packageName], { timeout: 20000 });
  if (result.code !== 0 || result.timedOut) return null;
  const lines = adbText(result).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    const found = componentFrom(line);
    if (found && found.package_name === packageName) return found.component;
  }
  return null;
}

function safeRemoteName(requestId) {
  return `aitest-${String(requestId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}.xml`;
}

export async function dumpUi(runner, serial, requestId) {
  const remotePath = `/data/local/tmp/${safeRemoteName(requestId)}`;
  const dump = await runner.run(['-s', serial, 'shell', 'uiautomator', 'dump', remotePath], { timeout: 30000 });
  if (dump.code !== 0 || dump.timedOut) {
    const category = dump.timedOut ? 'adb_timeout' : /device offline|unauthorized|not found/i.test(`${adbText(dump)} ${adbErrorText(dump)}`) ? undefined : 'command_failed';
    if (category) throw new AndroidAdbError(category, `uiautomator dump failed: ${(adbErrorText(dump) || adbText(dump)).trim().slice(0, 400)}`);
    assertAdbSuccess(dump, 'uiautomator dump');
  }
  const cat = await runner.run(['-s', serial, 'exec-out', 'cat', remotePath], { timeout: 20000 });
  await runner.run(['-s', serial, 'shell', 'rm', '-f', remotePath], { timeout: 10000 }).catch(() => {});
  assertAdbSuccess(cat, 'read UI hierarchy');
  const xml = adbText(cat);
  if (Buffer.byteLength(xml, 'utf8') > MAX_UI_XML_BYTES) throw new AndroidAdbError('command_failed', 'UI hierarchy exceeds the 4 MiB evidence limit');
  const root = parseUiHierarchy(xml);
  return { xml, root, remote_path: remotePath };
}

export async function captureScreenshot(runner, serial) {
  const result = await runner.run(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 30000 });
  assertAdbSuccess(result, 'screencap');
  const buffer = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? []);
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new AndroidAdbError('command_failed', 'screencap did not return a PNG image');
  }
  if (buffer.length > MAX_SCREENSHOT_BYTES) throw new AndroidAdbError('command_failed', 'screenshot exceeds the 20 MiB evidence limit');
  return buffer;
}

export async function readLogcat(runner, serial, { lines = 400 } = {}) {
  const count = Math.max(1, Math.min(2000, Number(lines) || 400));
  const result = await runner.run(['-s', serial, 'shell', 'logcat', '-d', '-t', String(count)], { timeout: 20000 });
  assertAdbSuccess(result, 'read logcat');
  const text = adbText(result);
  if (Buffer.byteLength(text, 'utf8') <= MAX_LOGCAT_BYTES) return text;
  return `${Buffer.from(text, 'utf8').subarray(-MAX_LOGCAT_BYTES).toString('utf8')}\n[logcat truncated to the last ${MAX_LOGCAT_BYTES} bytes]`;
}

export async function readDeviceFacts(runner, serial) {
  const [props, activity, screen] = await Promise.all([
    readProps(runner, serial),
    readCurrentActivity(runner, serial),
    readScreenState(runner, serial)
  ]);
  return {
    serial,
    manufacturer: props['ro.product.manufacturer'] ?? null,
    model: props['ro.product.model'] ?? null,
    api_level: props['ro.build.version.sdk'] ?? null,
    android_release: props['ro.build.version.release'] ?? null,
    build_fingerprint: props['ro.build.fingerprint'] ?? null,
    boot_completed: props['sys.boot_completed'] ?? null,
    activity,
    screen
  };
}

export async function getBootCompleted(runner, serial) {
  const result = await runner.run(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 10000 });
  if (result.code !== 0 || result.timedOut) return null;
  return adbText(result).trim() === '1';
}

export function probeJava({ timeoutMs = 8000 } = {}) {
  return new Promise(done => {
    execFile('java', ['-version'], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
      if (error) return done({ available: false, version: null, detail: error.code === 'ENOENT' ? 'java was not found on PATH' : text.slice(0, 300) });
      done({ available: true, version: /version "([^"]+)"/.exec(text)?.[1] ?? text.split(/\r?\n/)[0] ?? null, detail: null });
    });
  });
}

export async function probeAppium(url, { timeoutMs = 2500 } = {}) {
  if (!url) return { checked: false, available: false, version: null, reason: 'not_requested' };
  let parsed;
  try { parsed = new URL(url); } catch { return { checked: true, available: false, version: null, reason: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { checked: true, available: false, version: null, reason: 'unsupported_protocol' };
  try {
    const response = await fetch(new URL('/status', parsed), { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) return { checked: true, available: false, version: null, reason: `http_${response.status}` };
    const body = await response.json().catch(() => null);
    return { checked: true, available: true, version: body?.value?.build?.version ?? null, reason: null };
  } catch (error) {
    return { checked: true, available: false, version: null, reason: error.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}
