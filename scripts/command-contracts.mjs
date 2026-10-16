export class CommandUsageError extends Error {}
const requireUsage = (ok, message) => { if (!ok) throw new CommandUsageError(message); };
const run = value => /^run-[A-Za-z0-9-]+$/.test(value ?? '');

export function safeInputName(name) {
  return typeof name==='string' && name.length>0 && name.length<=180 && name===name.trim() &&
    !/^[.]|[. ]$|[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(name);
}
const stages = ['analysis', 'test_points', 'test_cases', 'execution', 'defects', 'report'];
const usages = {
  'run-ui-tests.mjs': '--run-id=<run_id> [--headed]',
  'extract-word-input.py': '<run_id> inputs/<archived-name>.docx',
  'create-run.mjs': '[--run-id=<new_run_id>]',
  'plan-run.mjs': '--run-id=<run_id> [--stages=analysis,test_points,...] [--review-mode=auto|staged] [--workflow-mode=task|lifecycle]',
  'extend-run-plan.mjs': '--run-id=<run_id> --stages=<stage,...> --reason=<user-continuation-request>',
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
  if (script === 'run-ui-tests.mjs') {
    requireUsage(args.filter(arg=>arg==='--headed').length<=1, 'Duplicate headed option');
    const options=parseOptions(args.filter(arg=>arg!=='--headed'),['run-id']);
    requireUsage(run(options['run-id']) && (!runId || options['run-id']===runId), 'Runner requires one matching --run-id'); return;
  }
  if (script === 'extend-run-plan.mjs') {
    const options = parseOptions(args, ['run-id', 'stages', 'reason']);
    const added = options.stages?.split(',') ?? [];
    requireUsage(run(options['run-id']) && (!runId || options['run-id'] === runId), 'Extension requires a matching run_id');
    requireUsage(added.length && added.every(id => stages.includes(id)) && new Set(added).size === added.length && options.reason, usages[script]);
    return;
  }
  if (['create-run.mjs', 'plan-run.mjs'].includes(script)) {
    const options = parseOptions(args, script === 'create-run.mjs' ? ['run-id'] : ['run-id', 'stages', 'review-mode', 'workflow-mode', 'source-mode']);
    requireUsage(script === 'create-run.mjs' || run(options['run-id']), 'plan-run requires --run-id');
    requireUsage(!options['run-id'] || run(options['run-id']), 'Invalid run ID');
    requireUsage(!runId || options['run-id'] === runId, 'Wrapper and script run_id differ');
    requireUsage(!options.stages || options.stages.split(',').every(id => stages.includes(id)), 'Unknown or empty planned stage');
    requireUsage(!options['review-mode'] || ['auto','staged'].includes(options['review-mode']), 'Invalid review mode');
    requireUsage(!options['workflow-mode'] || ['task','lifecycle'].includes(options['workflow-mode']), 'Invalid workflow mode');
    requireUsage(!options['source-mode'] || ['provided_materials','live_product'].includes(options['source-mode']), 'Invalid source mode');
    requireUsage(!options['source-mode'] || options['workflow-mode']==='task', 'source-mode applies only to independent tasks');
    return;
  }
  requireUsage(run(args[0]), `${script}: positional run_id required AFTER --; wrapper --run-id is not a script argument`);
  requireUsage(!runId || args[0] === runId, 'Wrapper and script run_id differ');
  if (script === 'extract-word-input.py') {
    requireUsage(args.length === 2 && typeof args[1]==='string' && args[1].startsWith('inputs/') && safeInputName(args[1].slice(7)) && /\.docx$/i.test(args[1]), usages[script]); return;
  }
  if (['generate-analysis-markdown.mjs', 'show-run-status.mjs', 'show-run-plan.mjs', 'get-run-resume-point.mjs'].includes(script)) { requireUsage(args.length === 1, usages[script]); return; }
  if (script === 'record-orchestration-event.mjs') {
    requireUsage(['dispatched', 'completed', 'failed', 'blocked'].includes(args[1]), 'Unknown stage event');
    const o = parseOptions(args.slice(2), ['stage','agent','skills','artifacts','reason','session-id','parent-session-id','dispatch-id','mode']);
    requireUsage(stages.includes(o.stage) && session(o['parent-session-id']), 'Stage and parent session required');
    if (args[1] === 'dispatched') {
      requireUsage(o.agent && o.skills && !o['dispatch-id'], 'Dispatch requires agent/skills; dispatch ID is generated');
      requireUsage(!o.mode || (['prepare','browser','resume_browser'].includes(o.mode) && o.stage === 'execution'), 'Invalid execution mode');
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
    if (args[1] === 'analysis' && args[2] === 'revision_requested') requireUsage(args.slice(3).join(' ').trim(), 'Analysis revision requires the user modification request as reason');
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
