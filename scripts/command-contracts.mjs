export class CommandUsageError extends Error {}
const requireUsage = (ok, message) => { if (!ok) throw new CommandUsageError(message); };
const run = value => /^run-[A-Za-z0-9-]+$/.test(value ?? '');
const stages = ['analysis', 'test_points', 'test_cases', 'execution', 'defects', 'report'];
const usages = {
  'create-run.mjs': '[--run-id=<new_run_id>]',
  'plan-run.mjs': '--run-id=<run_id> [--stages=analysis,test_points,...]',
  'record-orchestration-event.mjs': '<run_id> <dispatched|completed|failed|blocked> --stage=<stage> --parent-session-id=<session> [--agent=... --skills=... --dispatch-id=... --session-id=... --artifacts=... --reason=... --mode=prepare]',
  'request-stage-confirmation.mjs': '<run_id> <stage> [run-relative-artifact ...]',
  'resolve-stage-confirmation.mjs': '<run_id> <stage> <approved|revision_requested|rejected> [reason ...]',
  'show-run-plan.mjs': '<run_id>',
  'get-run-resume-point.mjs': '<run_id>',
  'show-run-status.mjs': '<run_id>',
  'validate-artifacts.mjs': '<run_id> <stage> [--mode=execute|prepare] [--artifacts=path,...]',
  'generate-analysis-markdown.mjs': '<run_id>',
  'recover-stage.mjs': '<run_id> <stage> --expected-sha256=<hash> --actor=<actor> --reason=<reason> --approval-ref=<ref> --evidence=<run-relative-path> --parent-session-id=<session>'
};
export function commandHelp(script) {
  requireUsage(!script || Object.hasOwn(usages, script), 'No registered help for this script; inspect its source without executing it');
  return { status: 'help', launches_child: false, wrapper: 'project-command.mjs run <node|python> <script-basename> --controller-session=<parent-session> [--run-id=...] [--timeout-ms=...] -- <script arguments>',
    note: 'Wrapper --run-id archives logs only; pass required script run_id again after --. No automatic retries.', usages: script ? { [script]: usages[script] } : usages };
}
export function validateCommandArguments(script, args, runId) {
  if (!Object.hasOwn(usages, script)) return;
  if (['create-run.mjs', 'plan-run.mjs'].includes(script)) {
    const options = parseOptions(args, script === 'create-run.mjs' ? ['run-id'] : ['run-id', 'stages']);
    requireUsage(script === 'create-run.mjs' || run(options['run-id']), 'plan-run requires --run-id');
    requireUsage(!options['run-id'] || run(options['run-id']), 'Invalid run ID');
    requireUsage(!runId || options['run-id'] === runId, 'Wrapper and script run_id differ');
    requireUsage(!options.stages || options.stages.split(',').every(id => stages.includes(id)), 'Unknown or empty planned stage');
    return;
  }
  requireUsage(run(args[0]), `${script}: positional run_id required AFTER --; wrapper --run-id is not a script argument`);
  requireUsage(!runId || args[0] === runId, 'Wrapper and script run_id differ');
  if (['generate-analysis-markdown.mjs', 'show-run-status.mjs', 'show-run-plan.mjs', 'get-run-resume-point.mjs'].includes(script)) { requireUsage(args.length === 1, usages[script]); return; }
  if (script === 'record-orchestration-event.mjs') {
    requireUsage(['dispatched', 'completed', 'failed', 'blocked'].includes(args[1]), 'Unknown stage event');
    const o = parseOptions(args.slice(2), ['stage','agent','skills','artifacts','reason','session-id','parent-session-id','dispatch-id','mode']);
    requireUsage(stages.includes(o.stage) && session(o['parent-session-id']), 'Stage and parent session required');
    if (args[1] === 'dispatched') {
      requireUsage(o.agent && o.skills && !o['dispatch-id'], 'Dispatch requires agent/skills; dispatch ID is generated');
      requireUsage(!o.mode || (o.mode === 'prepare' && o.stage === 'execution'), 'Invalid preparation mode');
    } else {
      requireUsage(o['dispatch-id'] && !o.mode, 'Terminal event requires dispatch ID and no mode');
      requireUsage(args[1] === 'completed' ? session(o['session-id']) && o.artifacts : o.reason, 'Completion requires child session/artifacts; failure requires reason');
    }
    return;
  }
  requireUsage(stages.includes(args[1]), 'Valid positional stage required');
  if (script === 'request-stage-confirmation.mjs') {
    requireUsage(args.slice(2).every(p => p && !p.startsWith('-') && !/^(?:[A-Za-z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..')), 'Artifacts must be run-relative paths'); return;
  }
  if (script === 'resolve-stage-confirmation.mjs') {
    requireUsage(['approved', 'revision_requested', 'rejected'].includes(args[2]), 'Invalid confirmation decision');
    requireUsage(args.slice(3).every(p => !p.startsWith('--')), 'Confirmation reason is positional text, not options'); return;
  }
  const options = {};
  for (const arg of args.slice(2)) {
    const match = /^--([^=]+)=(.+)$/s.exec(arg);
    requireUsage(match && !Object.hasOwn(options, match[1]) && match[2].trim(), 'Invalid or duplicate script option');
    options[match[1]] = match[2];
  }
  if (script === 'validate-artifacts.mjs') {
    requireUsage(Object.keys(options).every(key => ['mode', 'artifacts'].includes(key)), 'Unknown validator option');
    requireUsage(!options.mode || options.mode === 'execute' || (options.mode === 'prepare' && args[1] === 'execution'), 'Invalid validation mode');
  } else {
    const keys = ['expected-sha256', 'actor', 'reason', 'approval-ref', 'evidence', 'parent-session-id'];
    requireUsage(keys.every(key => options[key]) && Object.keys(options).every(key => keys.includes(key)), `Recovery requires exactly: ${keys.join(', ')}`);
    requireUsage(/^[a-f0-9]{64}$/.test(options['expected-sha256']), 'Reviewed SHA256 must be lowercase hexadecimal');
  }
}

const session = value => /^session-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]+$/.test(value ?? '');
export function parseOptions(args, allowed) {
  const options = {};
  for (const arg of args) {
    const match = /^--([^=]+)=(.+)$/s.exec(arg);
    requireUsage(match && allowed.includes(match[1]) && !Object.hasOwn(options, match[1]) && match[2].trim(), 'Unknown, empty or duplicate option');
    options[match[1]] = match[2];
  }
  return options;
}
