import { readFileSync } from 'node:fs';
import { dataPath } from './directory-context.mjs';
import { resolve } from 'node:path';
import { parseOptions, CommandUsageError } from './command-contracts.mjs';
import { actionCatalog, executeAction, actionFailureSummary } from './structured-actions.mjs';

const root=resolve(import.meta.dirname,'..');
const [action,...args]=process.argv.slice(2);
try {
  let result;
  if ([undefined,'catalog','help','--help'].includes(action)) {
    parseOptions(args,['controller-session']);
    result=actionCatalog(root);
  }
  else {
    const options=parseOptions(args,action === 'execute' ? ['controller-session','request'] : ['controller-session']);
    if (action === 'summary') result=actionFailureSummary(root,options['controller-session']);
    else if (action === 'execute') {
      const controller=new AbortController(); const stop=()=>controller.abort();
      process.on('SIGINT',stop); process.on('SIGTERM',stop);
      try { result=await executeAction(root,options['controller-session'],()=>{
        if (!options.request || /^[\s]*[\[{]/.test(options.request)) throw new Error('--request requires a JSON FILE path, not inline JSON. Write the request with the file tool, then pass --request=output/action-requests/<unique-name>.json');
        try { return readFileSync(dataPath(root,options.request)); }
        catch(error) {
          if(error.code==='ENOENT') throw new CommandUsageError(`Request JSON file does not exist (received path: ${JSON.stringify(options.request)}). First use write_file to save the intended action, wait for success, then execute the same --request path. Prefer --request=output/action-requests/<name>.json; for absolute paths use quoted forward slashes, e.g. --request="E:/workspace/output/action-requests/<name>.json". Bash strips unquoted Windows backslashes; correct the command path, do not recreate existing files or guess a replacement path. No action was launched. Do not guess contents, create another run or ask the user to unlock.`);
          throw error;
        }
      },{signal:controller.signal}); }
      finally { process.off('SIGINT',stop); process.off('SIGTERM',stop); }
    } else throw new CommandUsageError('Use catalog, execute or summary. Actions such as read_source belong inside the JSON request FILE; invoke execute --request=<file>.');
  }
  console.log(JSON.stringify(result,null,2)); process.exitCode=result.exit_code ?? 0;
} catch(error) {
  const sessions=args.filter(arg=>arg.startsWith('--controller-session='));
  let result={status:'input_rejected',error:error.message,exit_code:2,next_action:'stop_and_request_review'};
  if (error instanceof CommandUsageError && sessions.length===1) {
    try { result=await executeAction(root,sessions[0].slice('--controller-session='.length),()=>{throw new CommandUsageError(`${error.message}. Use node scripts/project-action.mjs execute --controller-session=<parent> --request=<JSON-file>; do not use action names as CLI subcommands or omit '='.`);}); }
    catch(identityError) { result.error=identityError.message; }
  }
  console.log(JSON.stringify(result,null,2));process.exitCode=result.exit_code ?? 2;
}
