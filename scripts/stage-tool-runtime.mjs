import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, delimiter } from 'node:path';
import { pythonCandidates } from './command-runtime.mjs';
import { runDirectory, readRunFile } from './design-quality.mjs';
import { readRuntimeState, CALLABLE_STAGE_TOOL_IDS } from './tool-gate.mjs';
import { CommandUsageError } from './command-contracts.mjs';
import { assertUnlinked } from './skill-resources.mjs';

// Only tools with a callable, deterministic implementation belong here.
// Stage permissions are deliberately narrower than the admin category.
export const STAGE_TOOLS = Object.freeze({
  'requirement.testability': { stage: 'analysis', source: 'requirement/testability.py', payload: '{"requirement":{"id":string,"title":string,"description":string,"expected":string,"preconditions":string}}' },
  'requirement.acceptance': { stage: 'analysis', source: 'requirement/acceptance.py', payload: '{"requirement":{"acceptance":[{"observable":string}]}}' },
  'testpoint.coverage': { stage: 'test_points', source: 'testpoint/coverage.py', payload: '{"requirements":requirementIR[],"test_points":testPointIR[],"cases":caseIR[],"enforce":boolean}' },
  'irval.check': { stage: ['analysis', 'test_points', 'test_cases', 'execution', 'api_execution', 'defects', 'report'], source: 'irval/pipeline.py', payload: '{"document":IR}' },
  'plan.gates': { stage: ['test_cases', 'execution', 'api_execution'], source: 'plan/gates.py', payload: '{"plan":planIR,"case":caseIR}' },
  'report.reviewer': { stage: 'report', source: 'report/reviewer.py', payload: '{"execs":execIR[]}' },
  'defect.evidence': { stage: 'defects', source: 'defect/evidence.py', payload: '{"exec_ir":execIR,"failed_step":step?,"baseline":snapshot?,"history":execIR[]?}' },
  'defect.tools': { stage: 'defects', source: 'defect/tools.py', payload: '{"evidence_packs":evidencePack[],"existing":defectIR[]?,"history":execIR[]?}' },
  'regression.impact': { stage: ['execution', 'api_execution', 'report'], source: 'regression/impact.py', payload: '{"cases":caseIR[],"changed_requirements":string[]?,"changed_modules":string[]?,"explicit_ids":string[]?}' },
  'regression.select': { stage: ['execution', 'api_execution', 'report'], source: 'regression/selector.py', payload: '{"cases":caseIR[],"tier":"smoke"|"core"|"full","budget_s":number?}' },
});
// 浏览器阶段工具由 browser-task.mjs 执行，不能伪装成 Python 确定性工具；
// 但它们同样需要进入阶段回执，供回归和探索产物引用。
export const BROWSER_STAGE_TOOLS = Object.freeze({
  'dom.snapshot': { stage: 'execution', source: 'scripts/browser-task.mjs' },
  'login.captcha_chain': { stage: 'execution', source: 'scripts/browser-task.mjs' },
});

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const NODE_STAGE_CHECK_IDS = new Set(['requirement.parse', 'expected.provenance', 'requirement.completeness', 'testpoint.coverage', 'defects.cluster', 'coverage.split', 'm1.consistency']);
function packageFingerprint(packageRoot) {
  const sourceRoot = resolve(packageRoot, 'aitestharness_tools');
  const files = [];
  const visit = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '__pycache__') visit(resolve(folder, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.py')) files.push(resolve(folder, entry.name));
    }
  };
  visit(sourceRoot);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(relative(sourceRoot, file).replaceAll('\\', '/')); hash.update('\0');
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}
if (Object.keys(STAGE_TOOLS).sort().join() !== [...CALLABLE_STAGE_TOOL_IDS].sort().join()) throw new Error('Stage tool registry and gate bindings differ');
const allowedStage = (spec, stage) => [spec.stage].flat().includes(stage);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateToolPayload(toolId, payload) {
  const fail = detail => { throw new CommandUsageError(`Invalid ${toolId} payload: ${detail}`); };
  if (!object(payload)) fail('expected JSON object');
  const allowed = {
    'requirement.testability': ['requirement'], 'requirement.acceptance': ['requirement'],
    'testpoint.coverage': ['requirements', 'test_points', 'cases', 'enforce'],
    'irval.check': ['document'], 'plan.gates': ['plan', 'case'], 'report.reviewer': ['execs'],
    'defect.evidence': ['exec_ir', 'failed_step', 'baseline', 'history'],
    'defect.tools': ['evidence_packs', 'existing', 'history'],
    'regression.impact': ['explicit_ids', 'changed_requirements', 'changed_modules', 'changed_fragments', 'similar_cases', 'cases', 'quarantine_ids'],
    'regression.select': ['cases', 'tier', 'budget_s'],
  }[toolId];
  if (!allowed) fail('unknown tool');
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) fail(`unsupported ${key}`);
  const required = {
    'requirement.testability': ['requirement'], 'requirement.acceptance': ['requirement'],
    'testpoint.coverage': ['requirements', 'test_points'], 'irval.check': ['document'],
    'plan.gates': ['plan'], 'report.reviewer': ['execs'], 'defect.evidence': ['exec_ir'],
    'defect.tools': ['evidence_packs'], 'regression.select': ['cases'],
  }[toolId] ?? [];
  for (const key of required) if (!(key in payload)) fail(`missing ${key}`);
  for (const key of ['requirement', 'document', 'plan', 'case', 'exec_ir', 'failed_step', 'baseline']) {
    if (payload[key] !== undefined && !object(payload[key])) fail(`${key} must be an object`);
  }
  for (const key of ['requirements', 'test_points', 'cases', 'execs', 'evidence_packs', 'existing',
    'history', 'explicit_ids', 'changed_requirements', 'changed_modules', 'changed_fragments',
    'similar_cases', 'quarantine_ids']) {
    if (payload[key] !== undefined && !Array.isArray(payload[key])) fail(`${key} must be an array`);
  }
  for (const key of ['requirements', 'test_points', 'cases', 'execs', 'evidence_packs', 'existing', 'history']) {
    if (payload[key]?.some(item => !object(item))) fail(`${key} must contain objects`);
  }
  for (const key of ['explicit_ids', 'changed_requirements', 'changed_modules', 'changed_fragments', 'similar_cases', 'quarantine_ids']) {
    if (payload[key]?.some(item => typeof item !== 'string')) fail(`${key} must contain strings`);
  }
  if (payload.requirement) {
    for (const key of ['id', 'title', 'description', 'expected', 'preconditions']) {
      if (payload.requirement[key] !== undefined && typeof payload.requirement[key] !== 'string') fail(`requirement.${key} must be string`);
    }
    if (payload.requirement.acceptance !== undefined &&
      (!Array.isArray(payload.requirement.acceptance) || payload.requirement.acceptance.some(item => !object(item) || typeof item.observable !== 'string')))
      fail('requirement.acceptance must contain observable strings');
  }
  if (payload.enforce !== undefined && typeof payload.enforce !== 'boolean') fail('enforce must be boolean');
  if (payload.tier !== undefined && !['smoke', 'core', 'full'].includes(payload.tier)) fail('tier must be smoke, core or full');
  if (payload.budget_s !== undefined && (!Number.isSafeInteger(payload.budget_s) || payload.budget_s < 0)) fail('budget_s must be a nonnegative integer');
}

export function stageToolCatalog(stage) {
  return Object.entries(STAGE_TOOLS).filter(([, spec]) => allowedStage(spec, stage)).map(([id, spec]) => ({ id, implementation: `aitestharness_tools/${spec.source}`, payload: spec.payload }));
}

export function stageToolReceipts(root, runId, { beforeStage = null } = {}) {
  const dir = runDirectory(root, runId);
  const manifest = JSON.parse(readRunFile(dir, 'manifest.json').data);
  const folder = resolve(dir, 'audit/stage-tools');
  const rows = [];
  for (const name of (existsSync(folder) ? readdirSync(folder) : []).filter(name => /^[a-f0-9-]+\.json$/.test(name)).sort()) {
    const path = `audit/stage-tools/${name}`;
    try {
      const record = JSON.parse(readRunFile(dir, path).data);
      if (record.run_id !== runId || record.status !== 'completed' || (!STAGE_TOOLS[record.tool_id] && !BROWSER_STAGE_TOOLS[record.tool_id])) continue;
      if (beforeStage && record.stage === beforeStage) continue;
      if (manifest.stages?.[record.stage]?.status !== 'completed') continue;
      rows.push({ stage: record.stage, tool_id: record.tool_id, receipt_path: path,
        implementation_sha256: record.implementation_sha256, input_sha256: record.input_sha256,
        ...(record.input_source ? { input_source: record.input_source } : {}) });
    } catch { /* A corrupt receipt cannot become a downstream source. */ }
  }
  for (const [eventIndex, event] of (manifest.orchestration?.events ?? []).entries()) {
    if (event.type !== 'completed' || !event.stage || beforeStage === event.stage || manifest.stages?.[event.stage]?.status !== 'completed') continue;
    const contract = event.evidence?.artifact_contract;
    if (contract?.status !== 'passed' || contract.run_id !== runId || contract.stage !== event.stage || !Array.isArray(contract.files) || !contract.files.length) continue;
    try {
      if (!contract.files.every(file => readRunFile(dir, file.path).sha256 === file.sha256)) continue;
      for (const [checkIndex, check] of (contract.tool_checks ?? []).entries()) {
        if (!NODE_STAGE_CHECK_IDS.has(check.tool_id) || !['passed', 'completed'].includes(check.status)) continue;
        rows.push({ stage: event.stage, tool_id: check.tool_id, source: 'stage_completion_contract',
          receipt_path: 'manifest.json', completion_event_index: eventIndex, tool_check_index: checkIndex,
          implementation_sha256: check.implementation_sha256,
          input_source: check.input });
      }
    } catch { /* Changed or unsafe files cannot become downstream evidence. */ }
  }
  return rows.slice(-100);
}

export function runStageTool(root, { runId, stage, toolId, payload, sourcePath, env = process.env }) {
  const spec = STAGE_TOOLS[toolId];
  if (!spec || !allowedStage(spec, stage)) throw new CommandUsageError(`Tool ${toolId} is not callable in stage ${stage}`);
  if ((payload === undefined) === (sourcePath === undefined)) throw new CommandUsageError('Supply exactly one of payload or source_path');
  let inputSource = null;
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== 'string' || !/^(?:inputs|analysis|design|execution|defects|report)\/(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.json$/u.test(sourcePath))
      throw new CommandUsageError('source_path must be a run-local JSON input or stage artifact');
    const file = readRunFile(runDirectory(root, runId), sourcePath);
    if (file.data.length > 1024 * 1024) throw new CommandUsageError('Tool source exceeds 1 MiB');
    try { payload = JSON.parse(file.data.toString('utf8')); }
    catch { throw new CommandUsageError(`Tool source is not JSON: ${sourcePath}`); }
    inputSource = { path: sourcePath, sha256: file.sha256 };
  }
  validateToolPayload(toolId, payload);
  const runtimeState = readRuntimeState(root);
  if (runtimeState.disabled.has(toolId)) throw new CommandUsageError(`工具「${toolId}」已停用，本阶段不执行。`);
  const dir = runDirectory(root, runId);
  const manifest = JSON.parse(readRunFile(dir, 'manifest.json').data);
  if (manifest.run_id !== runId || manifest.stages?.[stage]?.status !== 'in_progress') throw new CommandUsageError('Tool requires an active stage in this run');
  const packageRoot = resolve(root, 'aitestharness-tools');
  const implementationSha256 = packageFingerprint(packageRoot);
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > 1024 * 1024) throw new CommandUsageError('Tool payload exceeds 1 MiB');
  const candidates = pythonCandidates(env, root);
  if (!candidates.length) throw new CommandUsageError('No configured Python runtime for deterministic stage tools');
  const version = spawnSync(candidates[0], ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'],
    { cwd: root, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000 });
  if (version.status !== 0 || version.error) throw new CommandUsageError('Deterministic stage tools require a configured Python 3.11+ runtime');
  const toolEnv = { ...env, PYTHONPATH: [packageRoot, env.PYTHONPATH].filter(Boolean).join(delimiter), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  // 安装包内置 Python 可能是 isolated 模式，会忽略 PYTHONPATH；通过受控启动代码
  // 显式加入本引擎自己的工具包，避免把工具运行误判为“模块未安装”。
  const bootstrap = `import sys,runpy; sys.path.insert(0,${JSON.stringify(packageRoot.replaceAll('\\', '/'))}); sys.argv=['aitestharness_tools.runtime_cli',${JSON.stringify(toolId)}]; runpy.run_module('aitestharness_tools.runtime_cli',run_name='__main__')`;
  const processResult = spawnSync(candidates[0], ['-c', bootstrap], {
    cwd: root, env: toolEnv, input, encoding: 'utf8', shell: false, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
  });
  let response;
  try { response = JSON.parse(processResult.stdout); } catch { response = null; }
  const status = processResult.status === 0 && response?.ok === true ? 'completed' : 'failed';
  const id = randomUUID();
  const relativePath = `audit/stage-tools/${id}.json`;
  const path = resolve(dir, relativePath);
  assertUnlinked(dir, path);
  mkdirSync(resolve(dir, 'audit/stage-tools'), { recursive: true });
  const receipt = {
    version: 1, id, run_id: runId, stage, tool_id: toolId, implementation: `aitestharness_tools/${spec.source}`,
    registry_version: Number.isSafeInteger(runtimeState.versions[toolId]) ? runtimeState.versions[toolId] : null,
    implementation_sha256: implementationSha256, input_sha256: sha(input), started_at: startedAt,
    execution_location: env.QA_STAGE_TOOL_EXECUTION === 'local' ? 'local_machine' : 'agent_process',
    ...(inputSource ? { input_source: inputSource } : {}),
    duration_ms: Math.round(performance.now() - started), status,
    error_code: status === 'completed' ? null : response?.error_code ?? (processResult.error?.code || 'TOOL_PROCESS_FAILED'),
    result: status === 'completed' ? response.result : null,
  };
  writeFileSync(path, JSON.stringify(receipt, null, 2));
  if (status !== 'completed') throw new CommandUsageError(`Tool ${toolId} failed (${receipt.error_code}); receipt: ${relativePath}`);
  return { status, tool_id: toolId, stage, result: response.result, tool_receipt: relativePath, implementation_sha256: implementationSha256,
    ...(inputSource ? { input_source: inputSource } : {}) };
}
