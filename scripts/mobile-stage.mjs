import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { sessionWorkspaces } from './directory-context.mjs';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { assertParentSession, readSession } from './stage-evidence.mjs';
import { verifyAndroidExecutionResult, verifyMiniprogramExecutionResult } from './mobile-execution-evidence.mjs';

const fail = message => { throw new Error(`Mobile execution rejected: ${message}`); };
const hash = value => createHash('sha256').update(value).digest('hex');
const native = row => row.type === 'model_msg' && row.payload?.type === 'text' && row.payload.role === 'user' && row.payload.sender !== 'harness';
const stop = /不要(?:继续|执行|测试)|取消测试|停止测试|暂停测试|不执行|\b(?:stop|cancel)\b/i;

export function mobileAuthorization(root, runId, parent, rows, sourceText, platform) {
  const source = rows.filter(row => native(row) && row.payload.text === sourceText).at(-1);
  if (!source || !Number.isFinite(Date.parse(source.timestamp))) fail('exact native user request is required');
  if (!/(?:执行|开始|进行).{0,12}(?:App|安卓|Android|小程序)?.{0,8}测试|请测试|\b(?:run|perform|execute)\b.*\btests?\b/i.test(sourceText) || /仅分析|只分析|只(?:生成|编写)|不要(?:执行|测试)|不执行/i.test(sourceText)) fail('the native message does not request testing');
  if (rows.slice(rows.indexOf(source) + 1).some(row => native(row) && stop.test(row.payload.text))) fail('a later user stop overrides authorization');
  const targets = platform === 'android'
    ? [...new Set(sourceText.match(/\b[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){1,}\b/g) ?? [])]
    : [...new Set(sourceText.match(/\b(?:wx[0-9a-fA-F]{16}|touristappid)\b/g) ?? [])];
  if (!targets.length) fail(`native request must identify the ${platform === 'android' ? 'Android package' : 'mini program AppID'}`);
  if (platform === 'miniprogram' && targets.every(value => value === 'touristappid')) fail('touristappid is not an authorized real mini program target');
  const dir = runDirectory(root, runId);
  for (const path of ['execution/android-results.json', 'execution/miniprogram-results.json', 'execution/test_results.json']) if (existsSync(resolve(dir, path))) fail('existing execution cannot be restarted');
  return { kind: 'native_user_message', platform, session_id: parent, timestamp: source.timestamp,
    sha256: hash(sourceText), targets };
}

export function assertMobileDispatch(root, runId, parent, agentRoot, expectedPlatform) {
  const rows = assertParentSession(root, runId, parent, agentRoot);
  const dir = runDirectory(root, runId);
  const manifest = JSON.parse(readRunFile(dir, 'manifest.json').data);
  const dispatch = manifest.orchestration?.events?.filter(row => row.type === 'dispatched' && row.stage === 'execution').at(-1);
  if (manifest.orchestration?.plan?.execution_platform !== expectedPlatform || manifest.stages?.execution?.status !== 'in_progress' || dispatch?.['parent-session-id'] !== parent || dispatch?.dispatch_id !== manifest.stages.execution.dispatch_id) fail('current owned mobile execution dispatch required');
  const grant = dispatch.mobile_authorization;
  if (grant?.kind !== 'native_user_message' || grant.platform !== expectedPlatform || grant.session_id !== parent || !rows.some(row => native(row) && row.timestamp === grant.timestamp && hash(row.payload.text) === grant.sha256)) fail('native user authorization changed or missing');
  if (rows.some(row => native(row) && Date.parse(row.timestamp) > Date.parse(grant.timestamp) && stop.test(row.payload.text))) fail('user stopped execution');
  const childId = process.env.PENGUIN_SESSION_ID;
  if (!/^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(childId ?? '')) fail('native child session identity required');
  const child = readSession(agentRoot, dispatch.agent, childId);
  const meta = child.find(row => row.type === 'session_meta')?.payload;
  if (meta?.session_id !== childId || meta.source !== 'subagent' || resolve(meta.agent_state ?? '') !== resolve(agentRoot, dispatch.agent, 'agent_state') || !sessionWorkspaces(root, dir).includes(resolve(meta.workspace ?? ''))) fail('child agent or workspace identity mismatch');
  const event = rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'subagent' && row.payload.session_id === childId).at(-1);
  const launch = rows.filter(row => row.type === 'model_msg' && row.payload?.type === 'tool_call' && row.payload.name === 'run_subagent' && Date.parse(row.timestamp) <= Date.parse(event?.timestamp ?? 0)).at(-1);
  let args; try { args = typeof launch?.payload?.arguments === 'string' ? JSON.parse(launch.payload.arguments) : launch?.payload?.arguments; } catch { /* reject below */ }
  if (!event || !launch || args?.agent_id !== dispatch.agent || !String(args.prompt).includes(dispatch.dispatch_id) || Date.parse(event.timestamp) < Date.parse(dispatch.at)) fail('child is not bound to this dispatch');
  return { dir, manifest, dispatch, grant, childId };
}

export function assertMobileTarget(platform, operation, grant, dir) {
  if (platform === 'android') {
    const session = existsSync(resolve(dir, 'execution/android-session.json')) ? JSON.parse(readRunFile(dir, 'execution/android-session.json').data) : null;
    if (operation.type === 'start' && ['active','finished'].includes(session?.status) && !existsSync(resolve(dir, 'execution/android-receipts', `${operation.request_id}.json`))) fail('existing Android session cannot be restarted through a new request');
    const target = operation.package ?? session?.package;
    if (operation.type !== 'doctor' && (!target || !grant.targets.includes(target))) fail('package is outside the exact native user request');
    if (operation.type === 'start' && !operation.device) fail('start requires an explicit device serial');
    return operation.device ?? session?.device_serial ?? null;
  }
  if (operation.target_kind === 'device') fail('real-device mini program execution is unavailable');
  const session = existsSync(resolve(dir, 'execution/miniprogram-session.json')) ? JSON.parse(readRunFile(dir, 'execution/miniprogram-session.json').data) : null;
  if (operation.type === 'start' && ['active','finished'].includes(session?.status) && !existsSync(resolve(dir, 'execution/miniprogram-receipts', `${operation.request_id}.json`))) fail('existing mini program session cannot be restarted through a new request');
  if (session?.project?.directory && operation.project_dir && resolve(operation.project_dir) !== resolve(session.project.directory)) fail('project differs from the active session');
  if (session?.port && operation.port && operation.port !== session.port) fail('port differs from the active session');
  const project = operation.project_dir ?? session?.project?.directory;
  if (operation.type === 'start' && !project) fail('start requires an explicit mini program project');
  if (project) {
    const config = JSON.parse(readFileSync(resolve(project, 'project.config.json'), 'utf8'));
    if (!grant.targets.includes(config.appid) || config.appid === 'touristappid') fail('project AppID is outside the native user request');
  }
  return `port-${operation.port ?? session?.port ?? 9420}`;
}

export function acquireMobileResource(root, platform, key, owner, { start = false } = {}) {
  if (!key) fail('device or port identity required');
  const base = resolve(root, 'output/mobile-resources');
  mkdirSync(base, { recursive: true });
  const path = resolve(base, `${platform}-${hash(key)}.json`);
  if (start) {
    try { writeFileSync(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); return path; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!existsSync(path)) fail('resource has no active ownership; start the session first');
  const existing = JSON.parse(readFileSync(path, 'utf8'));
  if (existing.run_id !== owner.run_id || existing.dispatch_id !== owner.dispatch_id || existing.child_session !== owner.child_session || existing.key !== key) fail('device or port is owned by another execution');
  return path;
}

export function releaseMobileResource(path, owner) {
  if (!path || !existsSync(path)) return;
  const existing = JSON.parse(readFileSync(path, 'utf8'));
  if (existing.run_id === owner.run_id && existing.dispatch_id === owner.dispatch_id && existing.child_session === owner.child_session) unlinkSync(path);
}

export function sealMobileResult(dir, runId, platform, dispatchId, childId, grant = null) {
  const verified = platform === 'android' ? verifyAndroidExecutionResult(dir, runId) : verifyMiniprogramExecutionResult(dir, runId);
  const source = JSON.parse(readRunFile(dir, verified.source_path).data);
  if (platform === 'miniprogram' && verified.synthetic) fail('synthetic mini program evidence cannot enter a real report');
  if (grant && platform === 'android' && !grant.targets.includes(source.android?.package)) fail('result package differs from native authorization');
  if (grant && platform === 'miniprogram') {
    const project = source.miniprogram?.project_directory;
    if (!project || !grant.targets.includes(JSON.parse(readFileSync(resolve(project, 'project.config.json'), 'utf8')).appid)) fail('result AppID differs from native authorization');
  }
  const output = { ...source, dispatch_id: dispatchId, child_session: childId, source_result: { path: verified.source_path, sha256: verified.source_sha256 } };
  writeFileSync(resolve(dir, 'execution/test_results.json'), JSON.stringify(output, null, 2), { flag: 'wx', mode: 0o600 });
  return { verified, output };
}
