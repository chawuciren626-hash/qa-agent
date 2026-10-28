/** Verify a mobile worker's sealed evidence before it can enter a shared report. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { schemaCache } from './versioned-schema-cache.mjs';

const schema = schemaCache();
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = message => { throw new Error(`Android evidence rejected: ${message}`); };
const isInside = (root, target) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

export function verifyAndroidExecutionResult(runDirectory, expectedRunId) {
  const root = realpathSync(resolve(runDirectory));
  const sourcePath = resolve(root, 'execution/android-results.json');
  const source = readFileSync(sourcePath);
  const result = JSON.parse(source.toString('utf8'));
  const compiled = schema(resolve(import.meta.dirname, '../schemas/test_result.schema.json'));
  if (!compiled.validate(result)) fail(`result schema: ${compiled.errors()}`);
  if (result.run_id !== expectedRunId) fail('run identity mismatch');
  if (result.android?.backend !== 'adb' || result.android?.evidence_mode !== 'real') fail('unsupported source or evidence mode');
  if (!['completed', 'failed', 'blocked'].includes(result.status)) fail('invalid terminal status');
  if (!Number.isFinite(Date.parse(result.started_at)) || !Number.isFinite(Date.parse(result.finished_at)) || Date.parse(result.finished_at) < Date.parse(result.started_at)) fail('invalid time range');
  const cases = result.cases;
  if (new Set(cases.map(row => row.case_id)).size !== cases.length) fail('duplicate assertion ID');
  if (result.status === 'completed' && cases.length === 0) fail('completed without assertions');
  const counts = Object.fromEntries(['passed', 'failed', 'skipped', 'blocked'].map(key => [key, cases.filter(row => row.status === key).length]));
  if (result.summary.total !== cases.length || Object.entries(counts).some(([key, value]) => result.summary[key] !== value)) fail('case summary mismatch');
  if (!Array.isArray(result.evidence_index)) fail('missing evidence index');
  const indexed = new Map();
  for (const entry of result.evidence_index) {
    const name = entry?.path;
    if (typeof name !== 'string' || !/^execution\/android-(?:evidence|receipts|sessions)\/[A-Za-z0-9_.\/-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || indexed.has(name)) fail('invalid or duplicate indexed path');
    const file = resolve(root, name);
    if (!isInside(root, file) || !lstatSync(file).isFile() || realpathSync(file) !== file) fail(`non-file or linked evidence: ${name}`);
    const bytes = readFileSync(file);
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) fail(`evidence changed: ${name}`);
    indexed.set(name, entry);
  }
  for (const row of cases) {
    if (row.evidence_mode !== 'real' || row.verification_scope?.layer !== 'android_ui' || !Array.isArray(row.evidence_paths) || !row.evidence_paths.length) fail(`unverifiable assertion: ${row.case_id}`);
    for (const name of row.evidence_paths) if (!indexed.has(name)) fail(`assertion evidence missing from index: ${name}`);
  }
  for (const name of result.android.evidence_paths ?? []) if (!indexed.has(name)) fail(`run evidence missing from index: ${name}`);
  return {
    source_path: 'execution/android-results.json', source_sha256: hash(source),
    run_id: result.run_id, invocation_id: result.invocation_id,
    status: result.status, summary: result.summary,
    device: { model: result.android.device?.model ?? null, api_level: result.android.device?.api_level ?? null, android_release: result.android.device?.android_release ?? null },
    package: result.android.package, evidence_files: indexed.size,
    limitations: result.android.limitations ?? [], cases,
  };
}

export function verifyMiniprogramExecutionResult(runDirectory, expectedRunId, { allowSynthetic = false } = {}) {
  const root = realpathSync(resolve(runDirectory));
  const sourcePath = resolve(root, 'execution/miniprogram-results.json');
  const source = readFileSync(sourcePath);
  const result = JSON.parse(source.toString('utf8'));
  const reject = message => { throw new Error(`Miniprogram evidence rejected: ${message}`); };
  const compiled = schema(resolve(import.meta.dirname, '../schemas/test_result.schema.json'));
  if (!compiled.validate(result)) reject(`result schema: ${compiled.errors()}`);
  if (result.run_id !== expectedRunId) reject('run identity mismatch');
  if (result.target?.kind !== 'devtools' || result.target.real_device !== false) reject('unsupported target kind');
  if (result.target.synthetic === true && !allowSynthetic) reject('synthetic result cannot prove a real product run');
  if (typeof result.target.synthetic !== 'boolean') reject('missing synthetic provenance');
  if (!['completed','failed','blocked'].includes(result.status)) reject('invalid terminal status');
  if (!Number.isFinite(Date.parse(result.started_at)) || !Number.isFinite(Date.parse(result.finished_at)) || Date.parse(result.finished_at) < Date.parse(result.started_at)) reject('invalid time range');
  const cases = result.cases;
  if (new Set(cases.map(row=>row.case_id)).size !== cases.length) reject('duplicate assertion ID');
  if (result.status === 'completed' && cases.length === 0) reject('completed without assertions');
  const counts = Object.fromEntries(['passed','failed','skipped','blocked'].map(key=>[key,cases.filter(row=>row.status===key).length]));
  if (result.summary.total !== cases.length || Object.entries(counts).some(([key,value])=>result.summary[key]!==value)) reject('case summary mismatch');
  if (!Array.isArray(result.evidence_index)) reject('missing evidence index');
  const indexed = new Map();
  for (const entry of result.evidence_index) {
    const name=entry?.path;
    if (typeof name!=='string' || !/^execution\/miniprogram-(?:evidence|receipts|sessions)\/[A-Za-z0-9_.\/-]+$/.test(name) || name.split('/').some(part=>!part||part==='.'||part==='..') || indexed.has(name)) reject('invalid or duplicate indexed path');
    const file=resolve(root,name);
    if (!isInside(root,file) || !lstatSync(file).isFile() || realpathSync(file)!==file) reject(`non-file or linked evidence: ${name}`);
    const bytes=readFileSync(file);
    if (bytes.length!==entry.size || hash(bytes)!==entry.sha256) reject(`evidence changed: ${name}`);
    indexed.set(name,entry);
  }
  for (const row of cases) {
    if (row.evidence_mode!=='devtools' || row.verification_scope?.layer!=='miniprogram_devtools_ui' || !Array.isArray(row.evidence_paths) || !row.evidence_paths.length) reject(`unverifiable assertion: ${row.case_id}`);
    for (const name of row.evidence_paths) if (!indexed.has(name)) reject(`assertion evidence missing from index: ${name}`);
  }
  return { source_path:'execution/miniprogram-results.json',source_sha256:hash(source),run_id:result.run_id,invocation_id:result.invocation_id,status:result.status,summary:result.summary,synthetic:result.target.synthetic,real_device:false,evidence_files:indexed.size,cases };
}
