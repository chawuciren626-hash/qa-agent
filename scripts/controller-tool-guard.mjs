import { dataPath } from './directory-context.mjs';
import { readFileSync, realpathSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve, relative, isAbsolute } from 'node:path';
import { guardSensitiveRead } from './sensitive-file-guard.mjs';

const parentActions=new Set(['reuse_design','diagnose_task','create_run','plan_run','set_review_mode','extend_plan','archive_input','extract_word','analysis_summary','apply_analysis_feedback','diagnose_analysis','diagnose_test_points','diagnose_test_cases','prepare_execution_plan','validate_execution_prepare','preview_revision','read_source','run_status','resolve_child','dispatch','handoff','complete','block','fail','request_confirmation','resolve_confirmation','revise_stage','validate_analysis','validate_artifacts']);

parentActions.add('resolve_child_handle');
parentActions.add('plan_test_tracks');
parentActions.add('configure_delivery');
parentActions.add('create_api_snapshot_report');

// This host-tool guard prevents accidental bypasses; it is not an OS security sandbox.
export function guardControllerTool(root,input) {
  const sensitive=guardSensitiveRead(root,input);
  if(sensitive.decision==='deny') return sensitive;
  if (!['exec_command','write_file','edit_file','apply_patch'].includes(input.tool_name)) return {};
  try {
    const args=typeof input.arguments==='string'?JSON.parse(input.arguments):input.arguments;
    if(input.tool_name==='exec_command') {
      const cmd=String(args?.cmd ?? '').trim();
      if(/[\r\n;&|`$<>]/.test(cmd)) throw new Error('Use one structured command, without shell composition');
      // Directory metadata is inspection, not professional work or product execution.
      const listing=/^ls\s+-la\s+(?:"([^"\\]+)"|'([^'\\]+)'|([^\s"'\\]+))$/.exec(cmd);
      if(listing) {
        if(args.qa_request!==undefined) throw new Error('qa_request is only valid with structured execute');
        const target=listing[1] ?? listing[2] ?? listing[3];
        if(/[\x00-\x1f*?\[\]{}!%]/.test(target) || target.startsWith('-')) throw new Error('Directory inspection needs one literal path');
        const base=dataPath(root);
        const cwd=args.workdir && args.workdir!=='CWD'?resolve(base,args.workdir):base;
        const actual=realpathSync(resolve(cwd,target));
        const rel=relative(realpathSync(base),actual).replaceAll('\\','/');
        if(!/^output\/runs\/run-[A-Za-z0-9-]+\/(?:analysis|design|execution|defects|report)\/?$/.test(rel) || !statSync(actual).isDirectory()) throw new Error('Directory inspection is limited to current-session run stage directories');
        return {};
      }
      const match=/^node(?:\.exe)?\s+(?:scripts[\\/])?project-action\.mjs\s+(catalog|summary|execute)(?:\s+(.*))?$/.exec(cmd);
      if(!match) throw new Error('Controller shell uses project-action.mjs catalog/summary/execute only; do not run maintenance, generators or ad hoc scripts. Use read_file for inspection');
      const workspace=dataPath(root);
      if(args.workdir && !(args.workdir==='CWD' && !existsSync(resolve(workspace,'CWD'))) && resolve(workspace,args.workdir)!==workspace) throw new Error('Structured commands must use the current session workspace; omit workdir');
      if(match[1]==='execute') {
        const flags=match[2] ?? '';
        const session=/--controller-session=([^\s]+)/.exec(flags)?.[1];
        if(session!==input.session_id) throw new Error(`Use the current controller session exactly: --controller-session=${input.session_id}. Do not append a task/tool suffix or omit the flag. Read catalog for the host-bound invocation; this rejection grants no approval`);
        const request=/--request=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s]+))/.exec(flags);
        const path=request?.[1] ?? request?.[2] ?? request?.[3];
        if(!path) throw new Error('A request JSON file is required');
        if(args.qa_request!==undefined) {
          // The model supplies the complete body. Persist it before execution, never infer it.
          if(flags.replace(/--controller-session=([^\s]+)/,'').replace(request[0],'').trim()) throw new Error('Unexpected or duplicate execute flags');
          const data=args.qa_request;
          if(!data || typeof data!=='object' || Array.isArray(data) || !parentActions.has(data.action)) throw new Error('qa_request must be a controller action object');
          const target=dataPath(root,path), base=realpathSync(dataPath(root,'output/action-requests'));
          if(resolve(target,'..')!==base || !/^[A-Za-z0-9._-]+\.json$/.test(relative(base,target))) throw new Error('Inline request must use a direct output/action-requests JSON file');
          if(realpathSync(resolve(target,'..'))!==base) throw new Error('Request directory is redirected');
          try { writeFileSync(target,JSON.stringify(data,null,2)+'\n',{flag:'wx'}); }
          catch(error) {
            if(error.code!=='EEXIST') throw error;
            if(realpathSync(target)!==target || !isDeepStrictEqual(JSON.parse(readFileSync(target,'utf8')),data)) throw new Error('Request file already exists with different content or redirection; use a new request filename, not overwrite');
          }
        }
        let actual;
        try { actual=realpathSync(dataPath(root,path)); }
        catch(error) {
          if(error.code==='ENOENT') throw new Error('Request JSON file does not exist. Prefer exec_command.qa_request with the complete action object in one call; the hook saves it. Only without qa_request support: First use write_file to save the intended action in output/action-requests, wait for success, then execute the same file path. No action was launched; do not create another run or ask the user to unlock. Never guess the request contents.');
          throw error;
        }
        const rel=relative(realpathSync(dataPath(root, 'output/action-requests')),actual);
        if(!rel || isAbsolute(rel) || rel.startsWith('..')) throw new Error('Request file must stay in output/action-requests');
        const data=JSON.parse(readFileSync(actual,'utf8'));
        if(!parentActions.has(data.action)) throw new Error('Professional generation/export actions belong to the dispatched child, not the controller');
      }
      else if(args.qa_request!==undefined) throw new Error('qa_request is only valid with structured execute');
      return {};
    }
    if(input.tool_name!=='write_file') throw new Error('Controller edits use write_file for request JSON or source text only');
    const path=dataPath(root,args?.file_path ?? '');
    const rel=relative(dataPath(root),path).replaceAll('\\','/');
    if(!/^output\/action-requests\/[A-Za-z0-9._-]+\.json$/.test(rel) && !/^output\/runs\/run-[A-Za-z0-9-]+\/inputs\/[A-Za-z0-9._-]+\.(?:md|txt|json)$/.test(rel)) throw new Error('Controller may write request JSON and run source text only; professional outputs, runtime state and engine code are owned by their tools/roles');
    const parent=realpathSync(resolve(path,'..'));
    if(parent!==resolve(path,'..')) throw new Error('Controller write directory is redirected');
    return {};
  } catch(error) { return {decision:'deny',reason:`QA controller boundary: ${error.message}`}; }
}
