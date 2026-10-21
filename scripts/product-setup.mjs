import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadProductLayout} from './product-layout.mjs';
import {installPenguinRuntime} from './install-penguin-runtime.mjs';
import {checkProductDesktop} from './product-desktop-adapter.mjs';

export function setupProduct(config) {
  const layout=loadProductLayout(config);
  if(layout.layout!=='unified'||layout.paths.engine!==resolve(import.meta.dirname,'..'))throw new Error('Setup must run from its own unified installation');
  checkProductDesktop(layout.host_app);
  // Engine config is generated here, never copied from the maintainer's machine.
  const workspaceFile=resolve(layout.paths.engine,'config/session-workspaces.json');
  const workspace={version:1,enabled:true,project_id:layout.project_id,controller_agent:'test_agent',default_workspace:layout.paths.workspaces};
  if(existsSync(workspaceFile)) {
    const old=JSON.parse(readFileSync(workspaceFile,'utf8'));
    if(old.project_id!==workspace.project_id||old.controller_agent!==workspace.controller_agent||old.default_workspace!==workspace.default_workspace)throw new Error('Existing workspace settings differ; run an explicit migration');
  } else writeFileSync(workspaceFile,JSON.stringify(workspace,null,2)+'\n',{flag:'wx'});
  for(const key of ['host_data','qa_data','desktop_profile','workspaces'])mkdirSync(layout.paths[key],{recursive:true});
  const assets=resolve(layout.paths.engine,'config/test-assets.json');
  if(!existsSync(assets))writeFileSync(assets,readFileSync(resolve(layout.paths.engine,'config/test-assets.example.json')),{flag:'wx'});
  const result=installPenguinRuntime(layout.host_app,layout.paths.engine,'apply');
  return {status:'configured',runtime:result,agents:'initialized_at_first_desktop_start',model_credentials:'user_supplied'};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {if(process.argv.length!==3)throw new Error('Usage: product-setup.mjs <installation.json>');console.log(JSON.stringify(setupProduct(resolve(process.argv[2]))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
