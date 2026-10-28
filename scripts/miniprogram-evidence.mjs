import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const EVIDENCE_DIRECTORY = 'execution/miniprogram-evidence';
export const RECEIPT_DIRECTORY = 'execution/miniprogram-receipts';

export function miniprogramEvidenceDirectory(runDirectory) {
  return resolve(runDirectory, EVIDENCE_DIRECTORY);
}

export function miniprogramReceiptDirectory(runDirectory) {
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

export function scrubValue(value, secrets = []) {
  if (typeof value === 'string') return scrubText(value, secrets);
  if (Array.isArray(value)) return value.map(item => scrubValue(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, secrets)]));
  return value;
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

export function fileEntry(runDirectory, path, kind) {
  const stat = statSync(path);
  return { path: relativeRunPath(runDirectory, path), kind, size: stat.size, sha256: sha256(readFileSync(path)) };
}

export function buildEvidenceIndex(runDirectory, session) {
  const entries = new Map();
  for (const listed of session.evidence ?? []) {
    const path = resolve(runDirectory, listed);
    try {
      if (!statSync(path).isFile()) continue;
      entries.set(relativeRunPath(runDirectory, path), fileEntry(runDirectory, path, 'listed'));
    } catch { /* Evidence outside the run or removed is never indexed. */ }
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}
