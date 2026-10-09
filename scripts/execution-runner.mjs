import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertExecutionAuthorized } from './execution-authorization.mjs';
import { validatePlanDesign } from './design-quality.mjs';
import { validateExecutionPlan } from './execution-plan.mjs';
import { atomicJson, attemptEvent, beginAttempt, blockedResult, finishAttempt, stopTrackingProcess, trackAttemptProcess, updateAttempt } from './execution-attempts.mjs';
import { runManagedProcess } from './managed-process.mjs';
import { parsePlaywrightResults } from './playwright-results.mjs';

export async function executeAttempt(root, runId, { headed = false, signal, runProcess = runManagedProcess } = {}) {
  const context = beginAttempt(root, runId);
  let processesStopped = true;
  let authorization;
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  const block = (reason, kind = 'blocked') => {
    if (!processesStopped) {
      atomicJson(resolve(context.dir, 'partial-result.json'), blockedResult(context, reason));
      atomicJson(resolve(context.output, 'execution-blocked.json'), blockedResult(context, reason));
      attemptEvent(context, 'termination_unconfirmed', { reason });
      updateAttempt(context, 'termination_unconfirmed', { status: 'blocked', block_reason: reason, authorization, processes_stopped: false });
      return { code: 2, run_id: runId, invocation_id: context.invocationId, status: 'blocked', reason, attempt_dir: context.dir, recovery_required: true };
    }
    finishAttempt(context, { status: kind, result: blockedResult(context, reason), reason, details: { authorization, processes_stopped: processesStopped }, release: processesStopped });
    return { code: 2, run_id: runId, invocation_id: context.invocationId, status: kind, reason, attempt_dir: context.dir };
  };
  try {
    const planPath = resolve(context.output, 'execution-plan.json');
    if (!existsSync(planPath)) return block('Missing execution/execution-plan.json');
    const plan = read(planPath);
    if (!readFileSync(planPath).equals(readFileSync(resolve(context.dir, 'inputs/execution-plan.json')))) return block('Execution plan changed during attempt initialization');
    const errors = [...validateExecutionPlan(plan), ...validatePlanDesign(root, runId, plan)];
    if (errors.length) return block(errors.join('; '));
    if (!plan.cases.length) return block('No automated cases in execution plan');
    authorization = assertExecutionAuthorized(root, runId);
    const manifest = read(resolve(context.output, '../manifest.json'));
    const approval = manifest.confirmations.filter(row => row.stage === 'execution').at(-1);
    atomicJson(resolve(context.dir, 'inputs/approval-snapshot.json'), { confirmation_id: approval.id, snapshot: approval.execution_snapshot });
    const config = read(resolve(root, plan.environment_config));
    if (config.execution?.enabled !== true || !config.environment) return block('Execution switch or environment missing');
    const account = config.accounts?.normal_user ?? {};
    if (/example\.com|change_me|test_user/i.test([config.base_url, account.username, account.password, account.phone, account.verification_code].join(' '))) return block('Environment contains placeholder values');
    const playwright = resolve(root, 'node_modules/@playwright/test/cli.js');
    if (!existsSync(playwright)) return block('Local Playwright is unavailable; nothing was downloaded');
    const timeoutMs = plan.execution_policy.global_timeout_ms ?? 900000;
    const preflightTimeoutMs = plan.execution_policy.preflight_timeout_ms ?? 60000;
    const invoke = async (phase, args, env, limit) => {
      if (signal?.aborted) return { code: null, termination: 'interrupted', termination_confirmed: true };
      updateAttempt(context, phase, { authorization });
      atomicJson(resolve(context.dir, `${phase}-command.json`), { executable: process.execPath, args, timeout_ms: limit });
      const result = await runProcess({ command: process.execPath, args, cwd: root, env, timeoutMs: limit, logPath: resolve(context.dir, `${phase}.log`), signal, onSpawn: pid => trackAttemptProcess(context, pid, phase) });
      processesStopped = result.termination_confirmed === true;
      if (processesStopped && result.pid) stopTrackingProcess(context, result.pid);
      attemptEvent(context, 'process_ended', { phase, ...result });
      return result;
    };
    const preflightArgs = ['scripts/preflight-test-environment.mjs', `--environment=${config.environment}`, `--run-id=${runId}`, `--attempt-id=${context.invocationId}`];
    if (config.environment_registry) preflightArgs.push(`--registry=${config.environment_registry}`);
    const preflight = await invoke('preflight', preflightArgs, process.env, preflightTimeoutMs);
    if (preflight.code !== 0 || preflight.termination || preflight.error || !processesStopped) return block(`Environment preflight failed: ${preflight.termination ?? preflight.error ?? preflight.code}`, preflight.termination === 'interrupted' ? 'interrupted' : 'blocked');
    const preflightData = read(resolve(context.dir, 'environment/preflight.json'));
    if (preflightData.status !== 'ready' || preflightData.environment_id !== config.environment) return block('Preflight output does not confirm selected environment readiness');
    const ids = plan.cases.map(row => row.case_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const args = [playwright, 'test', '--grep', `(?:^|\\s)(${ids.join('|')})(?=\\s|$)`, `--workers=${plan.execution_policy.workers}`, '--retries=0', `--global-timeout=${timeoutMs}`];
    authorization = assertExecutionAuthorized(root, runId);
    if (signal?.aborted) return block('Execution interrupted before launch', 'interrupted');
    mkdirSync(resolve(context.dir, 'playwright'), { recursive: true });
    const test = await invoke('playwright', args, { ...process.env, QA_BASE_URL: config.base_url, QA_TEST_DIR: resolve(root, plan.execution_policy.test_dir), QA_RUN_DIR: context.dir.replaceAll('\\', '/'), QA_HEADED: headed ? 'true' : 'false', QA_TIMEOUT_MS: String(config.execution.timeout_ms ?? 30000), QA_WORKERS: String(plan.execution_policy.workers) }, timeoutMs + 10000);
    if (test.termination || test.error || !processesStopped || test.code === null) return block(`Execution stopped: ${test.termination ?? test.error ?? 'unknown termination'}`, test.termination === 'interrupted' ? 'interrupted' : 'blocked');
    const rawPath = resolve(context.dir, 'playwright/playwright-results.json');
    if (!existsSync(rawPath)) return block('Playwright produced no raw result in current attempt');
    const result = parsePlaywrightResults({ raw: read(rawPath), plan, runId, invocationId: context.invocationId, attemptDir: context.dir, exitCode: test.code });
    const finalAuthorization = assertExecutionAuthorized(root, runId);
    if (finalAuthorization.snapshot_sha256 !== authorization.snapshot_sha256 || finalAuthorization.confirmation_id !== authorization.confirmation_id) return block('Execution inputs or approval changed while tests were running');
    if (signal?.aborted) return block('Execution interrupted before result publication', 'interrupted');
    finishAttempt(context, { status: result.status, result, details: { authorization, processes_stopped: processesStopped } });
    return { code: test.code, run_id: runId, invocation_id: context.invocationId, status: result.status, attempt_dir: context.dir };
  } catch (error) {
    if (existsSync(resolve(context.dir, 'attempt.json'))) throw error;
    return block(error.message, signal?.aborted ? 'interrupted' : 'blocked');
  }
}
