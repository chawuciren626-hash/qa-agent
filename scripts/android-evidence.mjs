import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { AndroidAdbError, infrastructureCategories } from './android-adb.mjs';
import { captureScreenshot, dumpUi, readDeviceFacts, readLogcat } from './android-device.mjs';

export const EVIDENCE_DIRECTORY = 'execution/android-evidence';
export const RECEIPT_DIRECTORY = 'execution/android-receipts';

export function androidEvidenceDirectory(runDirectory) {
  return resolve(runDirectory, EVIDENCE_DIRECTORY);
}

export function androidReceiptDirectory(runDirectory) {
  return resolve(runDirectory, RECEIPT_DIRECTORY);
}

export function relativeRunPath(runDirectory, path) {
  const value = relative(resolve(runDirectory), resolve(path));
  if (!value || value === '..' || value.startsWith('..\\') || value.startsWith('../') || isAbsolute(value)) throw new Error('Evidence path escapes the run directory');
  return value.replaceAll('\\', '/');
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temp, path);
}

export function writeEvidenceBuffer(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, buffer, { flag: 'wx' });
  renameSync(temp, path);
  return { size: buffer.length, sha256: sha256(buffer) };
}

export function scrubText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/qa-secret:\/\/[A-Za-z0-9_-]+/g, '[REDACTED_SECRET_REF]')
    .replace(/\b(password|passwd|pwd|token|authorization|cookie)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function fileEntry(runDirectory, path, kind) {
  const stat = statSync(path);
  return { path: relativeRunPath(runDirectory, path), kind, size: stat.size, sha256: sha256(readFileSync(path)) };
}

export async function captureEvidence({
  runner,
  serial,
  requestId,
  runDirectory,
  secrets = [],
  kind = 'observation',
  phase = null,
  error = null,
  includeScreenshot = true,
  includeUi = true,
  includeLogcat = true,
  includeDevice = true
}) {
  const directory = androidEvidenceDirectory(runDirectory);
  mkdirSync(directory, { recursive: true });
  const files = [];
  const missing = [];
  let deviceUnavailable = null;
  const recordFailure = failure => {
    missing.push({ kind: failure.kind, reason: scrubText(failure.message, secrets).slice(0, 500) });
    if (failure.error instanceof AndroidAdbError && infrastructureCategories.has(failure.error.category)) deviceUnavailable = failure.error.category;
  };
  if (includeScreenshot) {
    try {
      const buffer = await captureScreenshot(runner, serial);
      const path = resolve(directory, `${requestId}.png`);
      writeEvidenceBuffer(path, buffer);
      files.push(fileEntry(runDirectory, path, 'screenshot'));
    } catch (failure) {
      recordFailure({ kind: 'screenshot', message: failure.message, error: failure });
    }
  }
  let uiText = null;
  if (includeUi && !deviceUnavailable) {
    try {
      const { xml, root } = await dumpUi(runner, serial, requestId);
      uiText = xml;
      const path = resolve(directory, `${requestId}.ui.xml`);
      writeEvidenceBuffer(path, Buffer.from(scrubText(xml, secrets), 'utf8'));
      files.push(fileEntry(runDirectory, path, 'ui_hierarchy'));
      if (!root) throw new Error('UI hierarchy was empty');
    } catch (failure) {
      recordFailure({ kind: 'ui_hierarchy', message: failure.message, error: failure });
    }
  } else if (includeUi) {
    missing.push({ kind: 'ui_hierarchy', reason: `skipped after ${deviceUnavailable}` });
  }
  if (includeLogcat && !deviceUnavailable) {
    try {
      const logcat = await readLogcat(runner, serial);
      const path = resolve(directory, `${requestId}.logcat.txt`);
      writeEvidenceBuffer(path, Buffer.from(scrubText(logcat, secrets), 'utf8'));
      files.push(fileEntry(runDirectory, path, 'logcat'));
    } catch (failure) {
      recordFailure({ kind: 'logcat', message: failure.message, error: failure });
    }
  } else if (includeLogcat) {
    missing.push({ kind: 'logcat', reason: `skipped after ${deviceUnavailable}` });
  }
  let facts = null;
  if (includeDevice && !deviceUnavailable) {
    try {
      facts = await readDeviceFacts(runner, serial);
      const path = resolve(directory, `${requestId}.device.json`);
      atomicWriteJson(path, { ...facts, captured_at: new Date().toISOString() });
      files.push(fileEntry(runDirectory, path, 'device'));
    } catch (failure) {
      recordFailure({ kind: 'device', message: failure.message, error: failure });
    }
  } else if (includeDevice) {
    missing.push({ kind: 'device', reason: `skipped after ${deviceUnavailable}` });
  }
  const record = {
    version: 1,
    request_id: requestId,
    kind,
    phase,
    captured_at: new Date().toISOString(),
    device_serial: serial,
    files,
    missing,
    device_unavailable: deviceUnavailable,
    error: error ? { category: error.category ?? 'command_failed', message: scrubText(error.message, secrets).slice(0, 1000) } : null
  };
  const recordPath = resolve(directory, `${requestId}.${kind}.json`);
  atomicWriteJson(recordPath, record);
  files.push(fileEntry(runDirectory, recordPath, 'evidence_record'));
  return { ...record, evidence_path: relativeRunPath(runDirectory, recordPath), ui_xml: uiText ? scrubText(uiText, secrets) : null };
}

export function buildEvidenceIndex(runDirectory, session) {
  const entries = new Map();
  for (const listed of session.evidence ?? []) {
    const path = resolve(runDirectory, listed);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    try {
      entries.set(relativeRunPath(runDirectory, path), fileEntry(runDirectory, path, 'listed'));
    } catch { /* Evidence outside the run is never indexed. */ }
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}
