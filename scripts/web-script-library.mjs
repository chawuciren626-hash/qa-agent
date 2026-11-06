import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { directoryContext, resourcePath } from './directory-context.mjs';
import { runDirectory } from './design-quality.mjs';
import { extractCases } from './execution-plan.mjs';
import { loadLatestExecution } from './execution-attempts.mjs';
import { assertExecutionTargets, executionScriptFiles } from './execution-targets.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const safePart = value => /^[A-Za-z0-9_-]+$/.test(value ?? '');
const inside = (base, target) => { const rel = relative(base, target); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'); };

function libraryRoot(root) {
  const context = directoryContext(root);
  if (context.mode !== 'isolated') return null;
  const dataRoot = process.env.QA_APP_DATA_ROOT;
  if (!dataRoot || !safePart(context.project_id)) return null;
  return resolve(dataRoot, 'projects', context.project_id, 'automation', 'web');
}
function caseFingerprints(root, runId, plan) {
  const source = json(resourcePath(root, plan.source));
  const cases = new Map(extractCases(source).map(item => [item.case_id, item]));
  return Object.fromEntries(plan.cases.map(item => {
    const original = cases.get(item.case_id);
    if (!original) throw new Error(`Missing designed case ${item.case_id}`);
    return [item.case_id, sha(Buffer.from(JSON.stringify(original)))];
  }));
}
function scriptInventory(dir) {
  const entries = [];
  const walk = (folder, prefix = '') => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Linked script cannot enter the library');
      const path = resolve(folder, entry.name), name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path, `${name}/`);
      else if (entry.isFile()) {
        if (!/\.[cm]?[jt]sx?$/.test(entry.name)) throw new Error(`Unsupported script dependency: ${name}`);
        const bytes = readFileSync(path);
        if (/(?:password|api[_-]?key|token|verification[_-]?code)\s*[:=]\s*["'`][^"'`]+["'`]/i.test(bytes.toString('utf8'))) throw new Error(`Potential embedded credential in ${name}`);
        entries.push({ path: name, sha256: sha(bytes) });
      }
    }
  };
  walk(dir);
  return entries.sort((a,b) => a.path.localeCompare(b.path));
}
function readIndex(lib) {
  const path = resolve(lib, 'index.json');
  if (!existsSync(path)) return { version: 1, bundles: [] };
  const index = json(path);
  if (index.version !== 1 || !Array.isArray(index.bundles)) throw new Error('Invalid web script library index');
  return index;
}
function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(temp, path);
}
function verifiedFiles(lib, bundle) {
  if (!/^[a-f0-9]{64}$/.test(bundle.id ?? '') || !Array.isArray(bundle.files)) throw new Error('Invalid archived bundle');
  const base = resolve(lib, 'bundles', bundle.id);
  for (const file of bundle.files) {
    if (typeof file.path !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..') || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid archived script path');
    const path = resolve(base, file.path);
    if (!inside(base, path) || !lstatSync(path).isFile() || sha(readFileSync(path)) !== file.sha256) throw new Error('Archived script checksum mismatch');
  }
  return base;
}

export function archiveVerifiedWebScripts(root, runId) {
  const lib = libraryRoot(root);
  if (!lib) return { status: 'unavailable', reason: 'Project script library context unavailable' };
  const dir = runDirectory(root, runId), manifest = json(resolve(dir, 'manifest.json'));
  const confirmation = manifest.confirmations?.filter(row => row.stage === 'execution' && row.kind === 'result').at(-1);
  if (confirmation?.status !== 'approved') return { status: 'pending_result_approval' };
  const { state, results } = loadLatestExecution(root, runId);
  if (state?.status !== 'completed' || results?.status !== 'completed' || results.cases?.some(row => row.status !== 'passed' || row.flaky)) return { status: 'not_eligible', reason: 'Only a sealed, fully passing non-flaky attempt can be verified' };
  if (!Number.isFinite(Date.parse(confirmation.resolved_at)) || Date.parse(confirmation.resolved_at) < Date.parse(results.finished_at)) return { status: 'not_eligible', reason: 'Result approval predates the latest attempt' };
  const plan = json(resolve(dir, 'execution/execution-plan.json'));
  if (plan.run_id !== runId || results.cases.length !== plan.cases.length) throw new Error('Plan/result case mismatch');
  const scripts = resourcePath(root, plan.execution_policy.test_dir);
  if (resolve(scripts) !== resolve(dir, 'execution/scripts')) throw new Error('Only run-local scripts can be archived');
  assertExecutionTargets(root, plan, executionScriptFiles(scripts));
  const files = scriptInventory(scripts);
  if (!files.some(row => /\.(spec|test)\.[cm]?[jt]sx?$/.test(row.path))) throw new Error('No test specs to archive');
  const authorization = manifest.confirmations?.filter(row => row.stage === 'execution' && row.status === 'approved' && row.execution_snapshot).at(-1);
  const approvedFiles = new Map((authorization?.execution_snapshot?.files ?? []).map(row => [row.path, row.sha256]));
  if (files.some(row => approvedFiles.get(resolve(scripts, row.path).replaceAll('\\', '/')) !== row.sha256)) return { status: 'not_eligible', reason: 'Scripts differ from the approved execution snapshot' };
  const declared = new Set(files.filter(row => /\.(spec|test)\.[cm]?[jt]sx?$/.test(row.path)).flatMap(row => [...readFileSync(resolve(scripts, row.path), 'utf8').matchAll(/\bTC-[A-Z0-9-]+\b/g)].map(match => match[0])));
  if (plan.cases.some(row => !declared.has(row.case_id))) throw new Error('A planned case ID is absent from archived specs');
  const fingerprints = caseFingerprints(root, runId, plan);
  const origin = new URL(json(resourcePath(root, plan.environment_config)).base_url).origin;
  const id = sha(Buffer.from(JSON.stringify({ files, fingerprints, origin })));
  mkdirSync(lib, { recursive: true });
  const lock = resolve(lib, 'archive.lock');
  const fd = openSync(lock, 'wx');
  try {
    const index = readIndex(lib);
    const prior = index.bundles.find(row => row.id === id);
    if (prior) { verifiedFiles(lib, prior); return { status: 'already_archived', bundle_id: id }; }
    const target = resolve(lib, 'bundles', id);
    if (existsSync(target)) throw new Error('Unindexed bundle exists; inspect before archiving');
    mkdirSync(target, { recursive: true });
    for (const file of files) {
      const dest = resolve(target, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(resolve(scripts, file.path), dest);
    }
    const bundle = { id, status: 'verified', source_run_id: runId, source_invocation_id: results.invocation_id, verified_at: new Date().toISOString(), origin, cases: fingerprints, files };
    verifiedFiles(lib, bundle);
    atomicJson(resolve(lib, 'index.json'), { version: 1, bundles: [...index.bundles, bundle] });
    return { status: 'archived', bundle_id: id, cases: Object.keys(fingerprints) };
  } finally { closeSync(fd); unlinkSync(lock); }
}

export function reuseWebScripts(root, runId) {
  const lib = libraryRoot(root);
  if (!lib) return { status: 'unavailable', reused: [], remaining: [] };
  const dir = runDirectory(root, runId), planPath = resolve(dir, 'execution/execution-plan.json');
  const plan = json(planPath), scripts = resolve(dir, 'execution/scripts');
  if (resolve(resourcePath(root, plan.execution_policy.test_dir)) !== scripts) throw new Error('Plan does not use run-local scripts');
  if (existsSync(scripts) && readdirSync(scripts).length) return { status: 'existing_drafts', reused: [], remaining: plan.cases.map(row => row.case_id) };
  const origin = new URL(json(resourcePath(root, plan.environment_config)).base_url).origin;
  const fingerprints = caseFingerprints(root, runId, plan);
  const pending = new Set(Object.keys(fingerprints)), selected = [];
  const bundles = readIndex(lib).bundles.filter(row => row.status === 'verified' && row.origin === origin).sort((a,b) => b.verified_at.localeCompare(a.verified_at));
  for (const bundle of bundles) {
    const matches = Object.keys(bundle.cases ?? {}).filter(id => pending.has(id) && bundle.cases[id] === fingerprints[id]);
    if (!matches.length || Object.keys(bundle.cases).some(id => !pending.has(id) && fingerprints[id] || pending.has(id) && bundle.cases[id] !== fingerprints[id])) continue;
    const base = verifiedFiles(lib, bundle);
    if (bundle.files.some(file => selected.some(item => item.bundle.files.some(previous => previous.path === file.path)))) continue;
    selected.push({ bundle, base, matches });
    matches.forEach(id => pending.delete(id));
  }
  mkdirSync(scripts, { recursive: true });
  for (const item of selected) for (const file of item.bundle.files) {
    const target = resolve(scripts, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(item.base, file.path), target);
  }
  if (selected.length) {
    assertExecutionTargets(root, plan, executionScriptFiles(scripts));
    plan.script_reuse = selected.map(item => ({ bundle_id: item.bundle.id, source_run_id: item.bundle.source_run_id, case_ids: item.matches, files: item.bundle.files }));
    atomicJson(planPath, plan);
  }
  return { status: 'prepared', reused: selected.flatMap(item => item.matches), remaining: [...pending], bundle_ids: selected.map(item => item.bundle.id) };
}
