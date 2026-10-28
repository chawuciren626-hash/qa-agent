import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export class MiniprogramError extends Error {
  constructor(category, message, details = {}) {
    super(message);
    this.name = 'MiniprogramError';
    this.category = category;
    this.details = details;
  }
}

const DEVTOOLS_DIR_NAMES = ['微信web开发者工具', 'WeChatDevTools', 'wechatwebdevtools'];

function candidateRoots(env) {
  const roots = [
    env['ProgramFiles(x86)'],
    env.ProgramFiles,
    env.LOCALAPPDATA ? resolve(env.LOCALAPPDATA, 'Programs') : null
  ].filter(Boolean);
  return [...new Set(roots)];
}

export function devtoolsCandidates(env = process.env, platform = process.platform) {
  if (env.WECHAT_DEVTOOLS_CLI) return [{ path: resolve(env.WECHAT_DEVTOOLS_CLI), source: 'WECHAT_DEVTOOLS_CLI' }];
  if (platform === 'darwin') {
    return ['/Applications/wechatwebdevtools.app/Contents/MacOS/cli', '/Applications/微信开发者工具.app/Contents/MacOS/cli']
      .map(path => ({ path, source: 'default_macos_path' }));
  }
  if (platform === 'win32') {
    return candidateRoots(env).flatMap(root => DEVTOOLS_DIR_NAMES.map(name => ({
      path: resolve(root, 'Tencent', name, 'cli.bat'),
      source: 'default_windows_path'
    })));
  }
  return [];
}

export function detectDevtoolsCli({ env = process.env, platform = process.platform, explicit } = {}) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const path = resolve(explicit);
    return { path, found: existsSync(path), source: 'explicit' };
  }
  const candidates = devtoolsCandidates(env, platform);
  const found = candidates.find(candidate => existsSync(candidate.path));
  return found ? { ...found, found: true } : { path: null, found: false, source: null, candidates: candidates.map(candidate => candidate.path) };
}

export function detectAutomator(projectRoot = resolve(import.meta.dirname, '..')) {
  try {
    const require = createRequire(resolve(projectRoot, 'package.json'));
    return { available: true, resolved: require.resolve('miniprogram-automator'), source: 'node_modules' };
  } catch {
    return { available: false, source: null, install_hint: 'npm install --save-dev miniprogram-automator' };
  }
}

export async function loadAutomator() {
  try {
    const module = await import('miniprogram-automator');
    return module.default ?? module;
  } catch (error) {
    throw new MiniprogramError(
      'automator_not_installed',
      'miniprogram-automator is not installed. Install it in the project before starting the developer-tools backend; no product action was executed.',
      { cause: error.message, install_hint: 'npm install --save-dev miniprogram-automator' }
    );
  }
}

export function readProjectConfig(projectDirectory) {
  const directory = resolve(projectDirectory);
  const configPath = resolve(directory, 'project.config.json');
  if (!existsSync(configPath)) {
    throw new MiniprogramError('project_invalid', `project.config.json was not found in ${directory}; pass --project or operation.project_dir.`);
  }
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch (error) { throw new MiniprogramError('project_invalid', `project.config.json is not valid JSON: ${error.message}`); }
  const appid = typeof config.appid === 'string' ? config.appid.trim() : '';
  if (!appid) throw new MiniprogramError('project_invalid', 'project.config.json does not declare an appid.');
  const root = config.miniprogramRoot ? resolve(directory, config.miniprogramRoot) : directory;
  const appPath = resolve(root, 'app.json');
  if (!existsSync(appPath)) {
    throw new MiniprogramError('project_invalid', `app.json was not found under the miniprogram root ${root}.`);
  }
  return {
    directory,
    config_path: configPath,
    app_path: appPath,
    miniprogram_root: root,
    appid,
    appid_masked: maskAppid(appid),
    projectname: typeof config.projectname === 'string' ? config.projectname : null,
    synthetic_appid: appid === 'touristappid'
  };
}

export function maskAppid(appid) {
  const value = String(appid);
  if (value.length <= 6) return `${value.slice(0, 1)}***${value.slice(-1)}`;
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

export function createDevtoolsBackend(automator) {
  return {
    kind: 'miniprogram-automator',
    async launch({ cliPath, projectPath, port, timeoutMs }) {
      const miniProgram = await automator.launch({
        cliPath,
        projectPath,
        port,
        timeout: timeoutMs,
        trustProject: true
      });
      return { miniProgram, wsEndpoint: `ws://127.0.0.1:${port}` };
    },
    async connect({ wsEndpoint }) {
      const miniProgram = await automator.connect({ wsEndpoint });
      return { miniProgram };
    },
    async close({ miniProgram }) {
      if (typeof miniProgram?.close === 'function') await miniProgram.close();
    }
  };
}

export async function createDefaultBackend() {
  const automator = await loadAutomator();
  return createDevtoolsBackend(automator);
}
