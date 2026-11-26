/** Scoped migration of an installed desktop to a remote business service. No business DB migration. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadProductLayout } from './product-layout.mjs';
import { remoteClientConnection, inspectRemoteService } from './client-connection.mjs';
import { checkSourceRuntime } from './source-runtime.mjs';
import { pauseLocalService, resumeLocalService, registerLocalService, servicePaths } from './local-service.mjs';

const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const positional = [];
let checkOnly = false;
let buildRoot = source;
for (const arg of process.argv.slice(2)) {
  if (arg === '--check') checkOnly = true;
  else if (arg.startsWith('--build-root=')) buildRoot = resolve(arg.slice('--build-root='.length));
  else if (arg.startsWith('--')) throw Error(`Unknown option: ${arg}`);
  else positional.push(arg);
}
const [installedArg, origin] = positional;
if (!installedArg || !origin || positional.length !== 2)
  throw Error('Usage: deploy-remote-client.mjs <installedDir> <remoteOrigin> [--check] [--build-root=<desktop-build-root>]');
const installed = resolve(installedArg);
const configPath = join(installed, 'installation.json');
const oldLayout = loadProductLayout(configPath);
const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
const connection = remoteClientConnection({ mode: 'remote', origin });
if (oldLayout.layout !== 'unified') throw Error('Remote desktop deployment requires the unified installation layout');
const app = oldLayout.host_app, engine = oldLayout.paths.engine;
const engineFiles = ['scripts/client-connection.mjs', 'scripts/product-layout.mjs',
  'scripts/product-entry.mjs', 'scripts/product-doctor.mjs', 'scripts/product-installed-start.mjs',
  'scripts/local-service.mjs', 'scripts/verify-product-installation.mjs',
  'schemas/product-installation.schema.json', 'config/release-resources.json'];
const mainSource = join(buildRoot, 'platform/packages/desktop/dist/main.js');
const workerSource = join(buildRoot, 'platform/packages/desktop/dist/execution-worker.js');
for (const name of engineFiles) if (!existsSync(join(source, name))) throw Error(`Missing source: ${name}`);
if (!existsSync(mainSource)) throw Error('Build the desktop before deployment');
if (!existsSync(workerSource)) throw Error('Build the local execution worker before deployment');
const mainBytes = readFileSync(mainSource);
if (!mainBytes.includes(Buffer.from('remoteSessionPartition')) ||
    !mainBytes.includes(Buffer.from('remote business client')) ||
    !mainBytes.includes(Buffer.from('connectionMode'))) {
  throw Error(`Desktop build does not contain the remote-client implementation: ${mainSource}`);
}
checkSourceRuntime(app, engine);
const health = await inspectRemoteService(connection);
if (health.status !== 'ready') throw Error(`Remote service is ${health.status}; installation was not modified`);

let desktopCount = 0;
if (process.platform === 'win32') {
  const code = '$target=[IO.Path]::GetFullPath($env:AITEST_DEPLOY_HOST_EXE); @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target }).Count';
  desktopCount = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, AITEST_DEPLOY_HOST_EXE: oldLayout.paths.host_executable },
  }).trim());
  if (!Number.isInteger(desktopCount) || desktopCount < 0) throw Error('Could not verify desktop processes');
}
if (checkOnly) {
  console.log(JSON.stringify({ status: 'preflight_passed', connection, desktopProcesses: desktopCount,
    buildRoot, mainSource, engineFiles, applicationFiles: ['dist/main.js', 'dist/execution-worker.js'], changesBusinessDatabase: false }));
  process.exit(0);
}
if (desktopCount) throw Error('请从托盘正常退出 AITestHarness 后再同步；不会强制关闭窗口或任务。');

const wasRunning = await pauseLocalService(configPath); // official busy/terminal/task admission guard
const backup = resolve(installed, '../backups', `remote-client-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(backup, { recursive: true });
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifestPath = join(app, 'aitest-source-runtime.json');
const mainTarget = join(app, 'dist/main.js');
const workerTarget = join(app, 'dist/execution-worker.js');
const rollback = [];
function save(target, name) {
  const file = join(backup, name);
  if (existsSync(target)) {
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(target, file);
    rollback.push({ target, file });
  } else rollback.push({ target, file: null });
}
let startup = null;
try {
  save(configPath, 'installation.json');
  save(manifestPath, 'aitest-source-runtime.json');
  save(mainTarget, 'dist/main.js');
  save(workerTarget, 'dist/execution-worker.js');
  for (const name of engineFiles) save(join(engine, name), `engine/${name}`);
  // Preserve the old business DB unchanged; never infer that legacy local rows belong in the server DB.
  for (const name of ['web.db', 'web.db-wal', 'web.db-shm', 'account-center.json']) {
    const file = join(oldLayout.paths.host_data, name);
    if (existsSync(file)) {
      mkdirSync(join(backup, 'legacy-data'), { recursive: true });
      copyFileSync(file, join(backup, 'legacy-data', name));
    }
  }
  if (process.platform === 'win32') {
    const paths = servicePaths(configPath);
    startup = resolve(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup', `AITestHarness-${paths.id}.vbs`);
    save(startup, 'startup.vbs');
    registerLocalService(configPath, { remove: true });
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const name of engineFiles) {
    const target = join(engine, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, name), target);
    manifest.engine_files[name] = sha(target);
  }
  // Management writes this file during runtime. Keep its contents, not a false immutable hash.
  delete manifest.engine_files['config/tool-runtime-state.json'];
  copyFileSync(mainSource, mainTarget);
  manifest.files['dist/main.js'] = sha(mainTarget);
  copyFileSync(workerSource, workerTarget);
  manifest.files['dist/execution-worker.js'] = sha(workerTarget);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  config.connection = connection;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const verification = checkSourceRuntime(app, engine);
  const installedLayout = loadProductLayout(configPath);
  const after = await inspectRemoteService(installedLayout.connection);
  if (after.status !== 'ready') throw Error('Remote service became unavailable during deployment');
  const result = { status: 'deployed', connection, backup, verification, mainSha256: sha(mainTarget),
    localBusinessServer: 'disabled', businessDatabase: 'preserved_without_migration',
    workerSha256: sha(workerTarget), authenticated: false, localExecutionBridge: 'reverse_poll_protocol_1' };
  writeFileSync(join(backup, 'deployment-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const failures = [];
  for (const { target, file } of rollback.reverse()) {
    try {
      if (file) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(file, target); }
      else if (existsSync(target)) unlinkSync(target);
    } catch (restoreError) { failures.push(restoreError.message); }
  }
  if (wasRunning && failures.length === 0) {
    try { await resumeLocalService(configPath); } catch (restoreError) { failures.push(restoreError.message); }
  }
  throw Error(`${error.message}; backup=${backup}; rollback=${failures.length ? failures.join('; ') : 'completed'}`);
}
