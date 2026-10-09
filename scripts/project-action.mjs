import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOptions } from './command-contracts.mjs';
import { actionCatalog, executeAction, actionFailureSummary } from './structured-actions.mjs';

const root=resolve(import.meta.dirname,'..');
const [action,...args]=process.argv.slice(2);
try {
  let result;
  if (action === 'catalog' && !args.length) result=actionCatalog();
  else {
    const options=parseOptions(args,action === 'execute' ? ['controller-session','request'] : ['controller-session']);
    if (action === 'summary') result=actionFailureSummary(root,options['controller-session']);
    else if (action === 'execute') {
      const controller=new AbortController(); const stop=()=>controller.abort();
      process.on('SIGINT',stop); process.on('SIGTERM',stop);
      try { result=await executeAction(root,options['controller-session'],()=>readFileSync(resolve(root,options.request)),{signal:controller.signal}); }
      finally { process.off('SIGINT',stop); process.off('SIGTERM',stop); }
    } else throw new Error('Use catalog, execute or summary');
  }
  console.log(JSON.stringify(result,null,2)); process.exitCode=result.exit_code ?? 0;
} catch(error) { console.log(JSON.stringify({status:'input_rejected',error:error.message,exit_code:2,next_action:'stop_and_request_review'})); process.exitCode=2; }
