// Maintainer-only: copy a known host into a fresh laboratory; never update an installation.
import {readFileSync,writeFileSync,readdirSync,lstatSync,mkdirSync,copyFileSync,constants,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {assertPlainPath,within} from './application-data.mjs';
import {hostCompatibility,checkHostUpdate} from './product-updates.mjs';
import {installPenguinRuntime} from './install-penguin-runtime.mjs';
export function hostTreeDigest(root){
  const hash=createHash('sha256');
  function walk(dir){for(const name of readdirSync(dir).sort()){
    const file=resolve(dir,name),stat=lstatSync(file);
    if(stat.isSymbolicLink())throw Error('Linked host input refused');
    if(stat.isDirectory())walk(file);
    else if(stat.isFile()){
      if(/^(?:api-token|\.vault\.toml|\.project_config\.toml|web\.db)(?:$|\.)/.test(name))throw Error('User state in host input refused');
      hash.update(JSON.stringify(file.slice(root.length+1).replaceAll('\\','/'))+'\n');
      hash.update(createHash('sha256').update(readFileSync(file)).digest());
    }else throw Error('Unsupported host entry');
  }}walk(root);return hash.digest('hex');
}
export function copyHostTree(source,target){
  const stat=lstatSync(source);if(stat.isSymbolicLink())throw Error('Linked host input refused');
  if(stat.isDirectory()){mkdirSync(target);for(const name of readdirSync(source))copyHostTree(resolve(source,name),resolve(target,name));}
  else if(stat.isFile())copyFileSync(source,target,constants.COPYFILE_EXCL);
  else throw Error('Unsupported host entry');
}
export async function reviewHost(app,output,{checkUpdates=true}={}){
  app=assertPlainPath(resolve(app));output=assertPlainPath(resolve(output));
  if(within(app,output)||within(output,app)||existsSync(output))throw Error('Use a fresh, separate review directory');
  const version=JSON.parse(readFileSync(resolve(app,'package.json'),'utf8')).version;
  const compatibility=hostCompatibility(version);
  mkdirSync(output,{recursive:true});
  const report={version:1,host_version:version,compatibility,checked_at:new Date().toISOString(),status:'compatibility_review_required',automatic_install:false,distribution_ready:false,checks:[],pending:['real_model_business_regression','cross_host_data_migration','clean_windows_acceptance']};
  if(checkUpdates)report.upstream=await checkHostUpdate(version);
  if(compatibility.status==='supported'){
    const before=hostTreeDigest(app),candidate=resolve(output,'host-app');
    report.source_tree_sha256=before;
    try{
      copyHostTree(app,candidate);
      if(hostTreeDigest(candidate)!==before)throw Error('Isolated copy mismatch');
      report.checks.push({id:'isolated_copy',status:'passed'});
      installPenguinRuntime(candidate,resolve(import.meta.dirname,'..'),'apply');
      const state=installPenguinRuntime(candidate,resolve(import.meta.dirname,'..'),'check');
      if(state.status!=='installed'||state.changed)throw Error('Adapter not idempotent');
      report.checks.push({id:'adapter_idempotence',status:'passed'});
      const child=spawnSync(process.execPath,[resolve(import.meta.dirname,'verify-penguin-host.mjs'),candidate],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});
      if(child.error||child.status!==0)throw Error('Host contract verification failed');
      const contracts=JSON.parse(child.stdout);
      if(contracts.status!=='passed'||contracts.version!==version)throw Error('Invalid host contract report');
      report.checks.push({id:'host_contracts',status:'passed',checks:contracts.checks});
      report.status='technical_checks_passed';
    }catch(error){report.status='failed';report.error=error.message;}
    finally{
      const unchanged=hostTreeDigest(app)===before;
      report.checks.push({id:'source_unchanged',status:unchanged?'passed':'failed'});
      if(!unchanged)report.status='failed';
    }
  }
  writeFileSync(resolve(output,'host-review.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.length!==4)throw Error('Usage: host-compatibility-review.mjs <resources/app> <new-review-directory>');
  const report=await reviewHost(process.argv[2],process.argv[3]);console.log(JSON.stringify(report,null,2));
  if(report.status!=='technical_checks_passed')process.exitCode=1;
}
