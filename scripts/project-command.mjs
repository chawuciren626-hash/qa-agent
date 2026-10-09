import { resolve } from 'node:path';
import { inspectRuntime, runProjectCommand } from './command-runtime.mjs';
import { CommandUsageError, commandHelp, parseOptions, validateCommandArguments } from './command-contracts.mjs';
import { readControllerSession, reviewControllerSession, withControllerSession } from './controller-command-session.mjs';

const root = resolve(import.meta.dirname, '..');
const [action, ...argv] = process.argv.slice(2);
const readonly = new Set(['show-run-status.mjs', 'show-run-plan.mjs', 'get-run-resume-point.mjs']);
try {
  const separator = argv.indexOf('--');
  const rawHead = separator < 0 ? argv : argv.slice(0, separator);
  const sessionFlags = rawHead.filter(arg => arg.startsWith('--controller-session='));
  if (sessionFlags.length > 1) throw new CommandUsageError('Duplicate controller session; no identity selected');
  const sessionId = sessionFlags[0]?.slice('--controller-session='.length);
  const head = rawHead.filter(arg => !arg.startsWith('--controller-session='));
  const args = separator < 0 ? [] : argv.slice(separator + 1);
  if (['session-status', 'review-session'].includes(action) && separator >= 0) throw new CommandUsageError('Only run accepts -- and script arguments');
  let result;
  if (action === 'session-status') {
    if (head.length) throw new CommandUsageError('session-status takes only --controller-session');
    result = readControllerSession(root, sessionId);
  } else if (action === 'review-session') {
    result = reviewControllerSession(root, sessionId, parseOptions(head, ['expected-sha256','actor','reason','approval-ref','evidence']));
  } else {
    const diagnostic = ['help', '--help', 'doctor'].includes(action) || (action === 'run' && readonly.has(head[1]));
    const execute = async () => {
      if (action !== 'run' && separator >= 0) throw new CommandUsageError('Only run accepts -- and script arguments');
      if (action === 'help' || action === '--help') {
        if (head.length > 1) throw new CommandUsageError('help accepts at most one registered script basename');
        return commandHelp(head[0]);
      }
      if (action === 'doctor') {
        if (head.length) throw new CommandUsageError('doctor takes no positional arguments');
        const check = inspectRuntime(root);
        return { ...check, exit_code: check.status === 'ready' ? 0 : 2, automatic_retries: 0, next_action: check.status === 'ready' ? 'inspect_result' : 'stop_and_request_review' };
      }
      if (action !== 'run') throw new CommandUsageError('Use help, doctor, run, session-status or review-session');
      const [kind, script, ...flags] = head;
      const options = parseOptions(flags, ['run-id', 'timeout-ms']);
      validateCommandArguments(script, args, options['run-id']);
      const declaredParent = args.find(arg => arg.startsWith('--parent-session-id='))?.slice('--parent-session-id='.length);
      if (declaredParent && declaredParent !== sessionId) throw new CommandUsageError('Script parent session differs from controller session');
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
      try {
        return await runProjectCommand(root, { kind, script, args, runId: options['run-id'], timeoutMs: options['timeout-ms'] === undefined ? 120000 : Number(options['timeout-ms']), signal: controller.signal });
      } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
    };
    if (!sessionId && !diagnostic) throw new CommandUsageError('Mutating/unknown commands require --controller-session=<actual parent session> before --');
    // Failure closure is allowed while stopped, but never completion or redispatch.
    const closure = action === 'run' && head[1] === 'record-orchestration-event.mjs' && ['blocked', 'failed'].includes(args[1]);
    result = sessionId ? await withControllerSession(root, sessionId, execute, { diagnostic: diagnostic || closure }) : await execute();
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.exit_code ?? 0;
} catch (error) {
  console.log(JSON.stringify({ status: error instanceof CommandUsageError ? 'input_rejected' : 'runner_error', error: error.message, exit_code: 2, automatic_retries: 0, next_action: 'stop_and_request_review', help: 'node scripts/project-command.mjs help' }, null, 2));
  process.exitCode = 2;
}
