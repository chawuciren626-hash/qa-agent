import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { patchServer, patchDeliveryBundle, patchDeliveryServer } from './penguin-runtime-patches.mjs';
import { patchReliabilityServer } from './penguin-reliability-patches.mjs';
import { patchClientBundle, clientModule, brandDataUrl } from './client-ui-patches.mjs';
import { patchLibraryServer } from './client-library.mjs';
import { patchHostObservability } from './host-observability.mjs';
import { patchHumanActions } from './human-action-patches.mjs';
import { versionClientIndex } from './client-asset-identity.mjs';

const hash = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const read = path => existsSync(path) ? readFileSync(path) : null;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const recordName = 'qa-runtime-install.json', journalName = 'qa-runtime-transaction.json';
const managedPath = /^(?:dist\/server\.js|web-dist\/index\.html|web-dist\/assets\/(?:index-[\w-]+\.js|qa-delivery-ui\.js))(?:\.qa-runtime-original)?$|^qa-runtime-install\.json$/;
function target(app, relative) {
  if (!managedPath.test(relative)) throw new Error(`Invalid managed path: ${relative}`);
  return resolve(app, relative);
}
function equal(actual, expected, name) {
  if (hash(actual) !== expected) throw new Error(`Checksum mismatch: ${name}; refusing overwrite`);
}
function atomicWrite(path, bytes) {
  if (bytes === null) { if (existsSync(path)) unlinkSync(path); return; }
  const temporary = `${path}.qa-tmp-${randomUUID()}`;
  try { writeFileSync(temporary, bytes, { flag: 'wx' }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function withLock(app, action) {
  const path = resolve(app, 'qa-runtime-install.lock');
  if (existsSync(path)) {
    const owner = json(path);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid installation lock');
    try { process.kill(owner.pid, 0); throw new Error('Another installer is active'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(path);
  }
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); return action(); }
  finally { closeSync(fd); unlinkSync(path); }
}

function requireClosedApplication(app) {
  const executable=resolve(app,'../../PenguinHarness.exe');
  if(process.platform!=='win32' || !existsSync(executable)) return;
  const ids=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    'Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -eq "PenguinHarness" -and (-not $_.Path -or $_.Path -eq $env:QA_INSTALL_EXE) } | Select-Object -ExpandProperty Id'],
    {env:{...process.env,QA_INSTALL_EXE:executable},encoding:'utf8',windowsHide:true,timeout:10000}).trim();
  if(ids) throw new Error('PenguinHarness is running; exit from the tray before changing the installation');
}

// Persist pre-images before changing any owned file. Recovery never touches unknown bytes.
function recoverTransaction(app) {
  const path = resolve(app, journalName), journal = json(path);
  if (journal.version !== 1 || !Array.isArray(journal.files)) throw new Error('Invalid installation journal');
  const paths = new Set();
  for (const entry of journal.files) {
    if (paths.has(entry.path)) throw new Error('Duplicate journal path');
    paths.add(entry.path);
    const current = hash(read(target(app, entry.path)));
    const before = entry.before === null ? null : Buffer.from(entry.before, 'base64');
    equal(before, entry.before_sha256, entry.path);
    if (current !== entry.before_sha256 && current !== entry.after_sha256) throw new Error(`Unknown changes during recovery: ${entry.path}`);
  }
  for (const entry of [...journal.files].reverse()) atomicWrite(target(app, entry.path), entry.before === null ? null : Buffer.from(entry.before, 'base64'));
  unlinkSync(path);
  return { status: 'recovered', restart_required: true };
}
function transact(app, changes, afterWrite) {
  const files = [...changes].map(([path, bytes]) => {
    const before = read(target(app, path));
    return { path, before: before === null ? null : before.toString('base64'), before_sha256: hash(before), after_sha256: hash(bytes) };
  });
  const path = resolve(app, journalName);
  atomicWrite(path, Buffer.from(JSON.stringify({ version: 1, files })));
  try {
    for (const [relative, bytes] of changes) { atomicWrite(target(app, relative), bytes); afterWrite?.(relative); }
    unlinkSync(path);
  } catch (error) {
    try { recoverTransaction(app); }
    catch (recovery) { throw new Error(`${error.message}; recovery required: ${recovery.message}`); }
    throw error;
  }
}

function legacyOriginals(app, paths) {
  const originals = paths.map(path => read(target(app, path)));
  const deliveryPath = resolve(app, 'qa-delivery-install.json');
  if (existsSync(deliveryPath)) {
    const record = json(deliveryPath);
    const expected = [paths[2], paths[0], paths[3]].map(path => target(app, path));
    if (JSON.stringify(record.targets) !== JSON.stringify(expected) || !record.index) throw new Error('Unsupported legacy delivery record');
    record.targets.forEach((path, i) => equal(read(path), record.installed[i], path));
    equal(originals[1], record.index.installed, paths[1]);
    originals[2] = read(record.targets[0] + '.qa-delivery-original');
    originals[0] = read(record.targets[1] + '.qa-delivery-original');
    originals[1] = read(resolve(app, paths[1] + '.qa-delivery-original'));
    equal(originals[2], record.original[0], 'legacy bundle backup');
    equal(originals[0], record.original[1], 'legacy server backup');
    equal(originals[1], record.index.original, 'legacy index backup');
    originals[3] = null;
  } else if (originals[3] !== null) throw new Error('Unowned delivery module; refusing overwrite');
  const workspacePath = resolve(app, paths[0] + '.qa-workspace.json');
  if (existsSync(workspacePath)) {
    const record = json(workspacePath), original = read(resolve(app, paths[0] + '.qa-workspace.original'));
    equal(original, record.original_sha256, 'legacy workspace backup');
    if (![record.original_sha256, record.patched_sha256].includes(hash(originals[0]))) throw new Error('Workspace and delivery patch chain differs');
    originals[0] = original;
  }
  return originals;
}

function plan(app, root) {
  const version = json(resolve(app, 'package.json')).version;
  if (!['0.2.13','0.2.16'].includes(version)) throw new Error('Only inspected PenguinHarness 0.2.13 and 0.2.16 supported');
  const index = readFileSync(resolve(app, 'web-dist/index.html'), 'utf8');
  const asset = index.match(/src="\/assets\/(index-[\w-]+\.js)(?:\?[^" ]*)?"/)?.[1];
  if (!asset) throw new Error('Application bundle not found');
  const paths = ['dist/server.js', 'web-dist/index.html', `web-dist/assets/${asset}`, 'web-dist/assets/qa-delivery-ui.js'];
  const record = read(resolve(app, recordName)) === null ? null : json(resolve(app, recordName));
  let originals;
  if (record) {
    if (record.version !== 1 || record.app_version !== version || JSON.stringify(record.paths) !== JSON.stringify(paths)) throw new Error('Application assets or installation record changed');
    paths.forEach((path, i) => equal(read(target(app, path)), record.installed[i], path));
    originals = paths.map((path, i) => {
      const bytes = record.original[i] === null ? null : read(target(app, path + '.qa-runtime-original'));
      equal(bytes, record.original[i], `original ${path}`); return bytes;
    });
  } else originals = legacyOriginals(app, paths);
  if (originals.slice(0, 3).some(bytes => bytes === null)) throw new Error('Missing original application files');
  const module = Buffer.from(clientModule(...['penguin/ui/delivery-ui.mjs', 'penguin/ui/workspace-ui.mjs', 'penguin/ui/workspace-ui.css', 'penguin/ui/aith-logo.svg', 'penguin/ui/aith-logo-light.svg'].map(path => readFileSync(resolve(root, path), 'utf8'))));
  const bundle = Buffer.from(patchClientBundle(patchDeliveryBundle(originals[2].toString('utf8'), hash(module).slice(0, 16))).replace('from "./qa-delivery-ui.js"', `from "./qa-delivery-ui.js?v=${hash(module).slice(0, 16)}"`));
  const sourceIndex = originals[1].toString('utf8'), anchor = `src="/assets/${asset}"`;
  if (sourceIndex.split(anchor).length !== 2) throw new Error('Original application index anchor not unique');
  const adapter = pathToFileURL(resolve(root, 'scripts/penguin-workspace-adapter.mjs')).href;
  const opener = pathToFileURL(resolve(root, 'scripts/open-deliverable.mjs')).href;
  const library = pathToFileURL(resolve(root, 'scripts/client-library.mjs')).href;
  const next = [Buffer.from(patchHumanActions(patchHostObservability(patchLibraryServer(patchReliabilityServer(patchDeliveryServer(patchServer(originals[0].toString('utf8'), adapter), opener, version), version), library),pathToFileURL(resolve(root,'scripts/host-observability.mjs')).href),pathToFileURL(resolve(root,'scripts/browser-human-action.mjs')).href, version)),
    Buffer.from(versionClientIndex(sourceIndex,asset,hash(bundle).slice(0,16)).replace('<title>PenguinHarness</title>', '<title>AITestHarness</title>').replace('href="/penguin-logo.svg"', 'href="'+brandDataUrl(readFileSync(resolve(root, 'penguin/ui/aith-logo.svg'), 'utf8'))+'"')), bundle, module];
  const runtime = Object.fromEntries(['scripts/penguin-workspace-adapter.mjs', 'scripts/open-deliverable.mjs', 'scripts/client-library.mjs','scripts/host-observability.mjs','scripts/protected-inputs.mjs','scripts/browser-human-action.mjs'].map(path => [path, hash(readFileSync(resolve(root, path)))]));
  return { paths, originals, next, runtime, record, version };
}

export function installPenguinRuntime(app, root, mode = 'check', { afterWrite } = {}) {
  app = resolve(app); root = resolve(root);
  if (!['check', 'apply', 'restore', 'recover'].includes(mode)) throw new Error('Unknown installation mode');
  if(mode!=='check') requireClosedApplication(app);
  if (mode === 'recover') return withLock(app, () => existsSync(resolve(app, journalName)) ? recoverTransaction(app) : { status: 'no_recovery_needed', restart_required: false });
  if (existsSync(resolve(app, journalName))) {
    if (mode === 'check') return { status: 'recovery_required', changed: true, restart_required: false };
    throw new Error('Interrupted installation; use --recover before continuing');
  }
  const execute = () => {
    if (existsSync(resolve(app, journalName))) throw new Error('Interrupted installation; use --recover before continuing');
    const p = plan(app, root);
    const desired = mode === 'restore' ? p.originals : p.next;
    const fileChanges = p.paths.filter((path, i) => hash(read(target(app, path))) !== hash(desired[i]));
    const runtimeChanged = !p.record || JSON.stringify(p.runtime) !== JSON.stringify(p.record.runtime) || p.record.engine_root !== root;
    const changed = fileChanges.length > 0 || (mode !== 'restore' && runtimeChanged);
    if (mode === 'check') return { status: p.record?.state === 'restored' ? 'restored' : changed ? 'update_available' : p.record ? 'installed' : 'adoption_available', changed,
      migration_required: !p.record, components: ['workspace', 'delivery', 'reliability', 'client-ui'], restart_required: false, restart_on_apply: changed || !p.record };
    const changes = new Map();
    if (!p.record) p.paths.forEach((path, i) => {
      if (p.originals[i] === null) return;
      const backup = path + '.qa-runtime-original', existing = read(target(app, backup));
      if (existing !== null) equal(existing, hash(p.originals[i]), backup);
      else changes.set(backup, p.originals[i]);
    });
    p.paths.forEach((path, i) => { if (fileChanges.includes(path)) changes.set(path, desired[i]); });
    const state = mode === 'restore' ? 'restored' : 'installed';
    if (changes.size || runtimeChanged || p.record?.state !== state) changes.set(recordName, Buffer.from(JSON.stringify({ version: 1, app_version: p.version, engine_root: root,
      paths: p.paths, original: p.originals.map(hash), installed: desired.map(hash), runtime: p.runtime, state, updated_at: new Date().toISOString() }, null, 2)));
    if (changes.size) transact(app, changes, afterWrite);
    return { status: state, changed: changes.size > 0, components: ['workspace', 'delivery', 'reliability', 'client-ui'], restart_required: changed || !p.record,
      frontend_reload_required: fileChanges.some(path => path.startsWith('web-dist/')) };
  };
  if (mode === 'check' && existsSync(resolve(app, 'qa-runtime-install.lock'))) return { status: 'installer_busy', changed: false, restart_required: false };
  return mode === 'check' ? execute() : withLock(app, execute);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [app, mode = '--check'] = process.argv.slice(2);
  if (!app || app.startsWith('--') || !['--check', '--apply', '--restore', '--recover'].includes(mode)) throw new Error('Usage: <resources/app> [--check|--apply|--restore|--recover]');
  const result = installPenguinRuntime(app, resolve(import.meta.dirname, '..'), mode.slice(2));
  console.log(JSON.stringify(result));
  if (result.status === 'recovery_required') process.exitCode = 1;
}
