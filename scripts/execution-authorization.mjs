import { resourcePath, directoryContext } from './directory-context.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { runDirectory, validatePlanDesign } from './design-quality.mjs';
import { validateExecutionPlan } from './execution-plan.mjs';
import { assertExecutionTargets, executionScriptFiles } from './execution-targets.mjs';

export function executionSnapshot(root, runId) {
  const dir = runDirectory(root, runId);
  const files = new Map();
  const capture = path => {
    const canonical = realpathSync(resourcePath(root, path));
    const rel = relative(realpathSync(root), canonical);
    const data = readFileSync(canonical);
    const key=isAbsolute(rel) || rel.startsWith('..') ? canonical : rel;
    files.set(key.replaceAll('\\', '/'), createHash('sha256').update(data).digest('hex'));
    return data;
  };
  const plan = JSON.parse(capture(resolve(dir, 'execution/execution-plan.json')));
  const errors = [...validateExecutionPlan(plan), ...validatePlanDesign(root, runId, plan)];
  if (errors.length) throw new Error(errors.join('; '));
  if (!plan.environment_config || !plan.execution_policy?.test_dir) throw new Error('Explicit environment and script directory required');
  const runtime = JSON.parse(capture(plan.environment_config));
  const configPath = realpathSync(resourcePath(root,plan.environment_config));
  const runRelative = relative(realpathSync(dir),configPath);
  const runLocal = directoryContext(root).mode === 'isolated' && runRelative && !isAbsolute(runRelative) && runRelative !== '..' && !runRelative.startsWith('..\\') && !runRelative.startsWith('../');
  if (!runtime.environment || runtime.execution?.enabled !== true) throw new Error('Environment is not enabled');
  if (runLocal && !runtime.environment_registry && !['chrome','chromium'].includes(runtime.execution?.browser)) throw new Error('Run-local environment must select a supported Chromium browser family');
  const target = new URL(runtime.base_url);
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid run environment URL');
  if (!runLocal || runtime.environment_registry) {
    const registry = JSON.parse(capture(runtime.environment_registry ?? 'config/test-environments.json'));
    const registered = registry.environments?.[runtime.environment];
    if (!registered || registered.authorized_for_execution !== true || registered.execution_enabled !== true) throw new Error('Environment is not enabled and authorized');
    if (target.href !== new URL(registered.base_url).href) throw new Error('Runtime URL differs from authorized environment');
  }
  const seen = new Set();
  const scan = path => {
    const canonical = realpathSync(resourcePath(root,path));
    const rel = relative(realpathSync(root), canonical);
    if (seen.has(canonical)) throw new Error('Duplicate or cyclic script directory');
    seen.add(canonical);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Symlink in execution inputs');
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) scan(child); else capture(child);
    }
  };
  scan(resourcePath(root, plan.execution_policy.test_dir));
  assertExecutionTargets(root, plan, executionScriptFiles(resourcePath(root, plan.execution_policy.test_dir)));
  if (![...files.keys()].some(path => /\.(spec|test)\.[cm]?[jt]sx?$/.test(path))) throw new Error('No executable test scripts');
  for (const path of ['tests/framework', 'scripts']) if (existsSync(resolve(root, path))) scan(resolve(root, path));
  for (const path of ['playwright.config.ts', 'tsconfig.playwright.json', 'package.json', 'package-lock.json']) capture(path);
  for (const file of plan.design_gate.files) capture(resolve(dir, file.path));
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  return { version: 1, sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), files: entries.map(([path, sha256]) => ({ path, sha256 })) };
}

export function assertExecutionAuthorized(root, runId) {
  const dir = runDirectory(root, runId);
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
  if (manifest.run_id !== runId) throw new Error('Manifest run mismatch');
  const stage = manifest.orchestration?.plan?.stages?.find(s => s.id === 'execution' && s.selected);
  if (!stage || manifest.stages?.execution?.mode === 'prepare' || !['planned', 'in_progress'].includes(manifest.stages?.execution?.status)) throw new Error('Execution stage not ready');
  for (const dependency of stage.depends_on ?? []) {
    const approval = manifest.confirmations?.filter(c => c.stage === dependency).at(-1);
    const dependencyPlan = manifest.orchestration?.plan?.stages.find(s => s.id === dependency);
    if (manifest.stages?.[dependency]?.status !== 'completed' || (dependencyPlan?.confirmation === 'after' && approval?.status !== 'approved')) throw new Error('Execution dependency not approved');
  }
  const confirmation = manifest.confirmations?.filter(c => c.stage === 'execution').at(-1);
  if (confirmation?.status !== 'approved' || !confirmation.execution_snapshot) throw new Error('Current execution approval required');
  if(manifest.orchestration?.plan?.workflow_mode!=='task' && (confirmation.approval_source?.kind!=='native_user_message' || !confirmation.approval_source.session_id || !Number.isFinite(Date.parse(confirmation.approval_source.timestamp)) || !/^[a-f0-9]{64}$/.test(confirmation.approval_source.sha256 ?? ''))) throw new Error('Verified native user approval source required');
  const actual = executionSnapshot(root, runId);
  if (actual.sha256 !== confirmation.execution_snapshot.sha256) throw new Error('Approved execution inputs changed; request approval again');
  return { confirmation_id: confirmation.id, snapshot_sha256: actual.sha256 };
}
