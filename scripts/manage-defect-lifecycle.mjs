import { resolve } from 'node:path';
import { readLifecycle, transitionDefect } from './defect-lifecycle.mjs';

const [action, runId, ...args] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
if (action === 'show') console.log(JSON.stringify(readLifecycle(root, runId), null, 2));
else {
  const options = Object.fromEntries(args.map(arg => arg.replace(/^--/, '').split(/=(.*)/s)));
  console.log(JSON.stringify(transitionDefect(root, runId, { action, invocation_id: options.invocation, defect_id: options.defect, revision: Number(options.revision), actor: options.actor, reason: options.reason, category: options.category, evidence: (options.evidence ?? '').split(',').filter(Boolean), retest_invocation_id: options.retest, retest_run_id: options['retest-run'] }), null, 2));
}
