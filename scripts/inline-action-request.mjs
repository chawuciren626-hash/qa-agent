import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { dataPath } from './directory-context.mjs';

// Transport only: dispatch, authorization and action validation still run downstream.
export function prepareInlineAction(root, args, { runId, parentSession } = {}) {
  const match=/^node(?:\.exe)?\s+(?:scripts[\\/])?project-action\.mjs\s+execute\s+(.+)$/.exec(String(args.cmd ?? '').trim());
  if(!match || /[\r\n;&|`$<>]/.test(args.cmd)) throw new Error('qa_request requires one structured execute command');
  const flags=match[1],request=/--request=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s]+))/.exec(flags);
  const session=/--controller-session=([^\s]+)/.exec(flags);
  if(!request || !session || flags.replace(request[0],'').replace(session[0],'').trim()) throw new Error('Use exactly one parent controller-session and request path');
  if(parentSession && session[1]!==parentSession) throw new Error('Request must use the current dispatch parent session');
  const workspace=dataPath(root);
  if(args.workdir && args.workdir!=='CWD' && resolve(workspace,args.workdir)!==workspace) throw new Error('Omit workdir for structured requests');
  const data=args.qa_request;
  if(!data || Array.isArray(data) || typeof data!=='object' || typeof data.action!=='string') throw new Error('qa_request must be a complete action object');
  if(runId && data.run_id!==runId) throw new Error('Request must use the current dispatched run');
  const base=realpathSync(dataPath(root,'output/action-requests'));
  if(base!==resolve(workspace,'output/action-requests')) throw new Error('Request directory is redirected');
  const target=dataPath(root,request[1] ?? request[2] ?? request[3]);
  if(resolve(target,'..')!==base || !/^[A-Za-z0-9._-]+\.json$/.test(relative(base,target))) throw new Error('Use a direct output/action-requests JSON file');
  try {writeFileSync(target,JSON.stringify(data,null,2)+'\n',{flag:'wx'});}
  catch(error) {
    if(error.code!=='EEXIST') throw error;
    if(realpathSync(target)!==target || !isDeepStrictEqual(JSON.parse(readFileSync(target,'utf8')),data)) throw new Error('Request filename conflicts; existing content was not overwritten');
  }
  return target;
}
