import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,readdirSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {releaseResources} from '../scripts/check-release-resources.mjs';
import {installProductDesktop,checkProductDesktop} from '../scripts/product-desktop-adapter.mjs';
import {assertPlainPath,within} from '../scripts/application-data.mjs';

export function finalizeWindowsStage(stage) {
  stage=assertPlainPath(resolve(stage));
  if(['data','workspaces','installation.json','product-payload.json'].some(name=>existsSync(resolve(stage,name))))throw Error('Only a fresh, unused build stage may be finalized');
  const root=resolve(import.meta.dirname,'..'),engine=resolve(stage,'app/engine'),hostApp=resolve(stage,'runtime/penguin/resources/app');
  const pins=JSON.parse(readFileSync(resolve(root,'packaging/runtime-sources.json'),'utf8'));
  if(JSON.parse(readFileSync(resolve(hostApp,'package.json'),'utf8')).version!==pins.host.version)throw Error('Staged host version mismatch');
  const policy=JSON.parse(readFileSync(resolve(root,'config/release-resources.json'),'utf8'));releaseResources(root,policy);
  // Embedded Python ignores PYTHONPATH and the script directory. Explicitly allow only our packaged helpers.
  writeFileSync(resolve(stage,'runtime/tools/python/python312._pth'),'python312.zip\n.\nLib/site-packages\n../../../app/engine/scripts\nimport site\n');
  const copy=(a,b)=>{mkdirSync(dirname(b),{recursive:true});copyFileSync(a,b);};
  for(const file of policy.files)copy(resolve(root,file),resolve(engine,file));
  copy(resolve(root,'config/release-resources.json'),resolve(engine,'config/release-resources.json'));
  if(existsSync(resolve(hostApp,'product-desktop.json')))checkProductDesktop(hostApp);else installProductDesktop(hostApp);
  for(const [target,source] of [['dist/icon.png','aith-icon.png'],['dist/tray/tray.png','aith-tray.png'],['dist/tray/tray@2x.png','aith-tray@2x.png'],['dist/aith-icon.ico','aith-icon.ico']])copy(resolve(root,'penguin/ui',source),resolve(hostApp,target));
  const browserRoot=resolve(stage,'runtime/tools/browsers'),links=resolve(browserRoot,'.links');
  if(existsSync(links)) {
    if(!within(stage,links)||realpathSync(links)!==links||lstatSync(links).isSymbolicLink()||readdirSync(links).some(name=>!lstatSync(resolve(links,name)).isFile()||lstatSync(resolve(links,name)).isSymbolicLink()))throw Error('Unexpected browser build-cache path');
    rmSync(links,{recursive:true}); // Verified, generated build cache only; contains the builder's absolute paths.
  }
  const layout=JSON.parse(readFileSync(resolve(root,'config/product-installation.example.json'),'utf8'));layout.root='.';layout.installation_id='aitestharness-desktop';
  writeFileSync(resolve(stage,'installation.json'),JSON.stringify(layout,null,2)+'\n',{flag:'wx'});
  const csc=resolve(process.env.SystemRoot??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const result=spawnSync(csc,['/nologo','/target:winexe','/reference:System.Windows.Forms.dll','/out:'+resolve(stage,'AITestHarness.exe'),'/win32icon:'+resolve(root,'penguin/ui/aith-icon.ico'),resolve(root,'packaging/Launcher.cs')],{windowsHide:true,encoding:'utf8',timeout:30000});
  if(result.error||result.status!==0)throw Error('Launcher compilation failed: '+result.stdout+result.stderr);
  for(const name of readdirSync(resolve(root,'packaging/licenses')))copy(resolve(root,'packaging/licenses',name),resolve(stage,'licenses',name));
  copy(resolve(root,'packaging/THIRD-PARTY-NOTICES.txt'),resolve(stage,'THIRD-PARTY-NOTICES.txt'));
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const manifest={version:1,product_version:pins.product_version,host_version:pins.host.version,upgrade:{protocol:1,data_version:1},distribution_ready:false,signature_status:'unsigned',files:{}};
  function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=resolve(dir,entry.name);if(lstatSync(file).isSymbolicLink())throw Error('Linked release payload');if(entry.isDirectory())walk(file);else manifest.files[file.slice(stage.length+1).replaceAll('\\','/')]=hash(readFileSync(file));}}
  for(const path of ['app','runtime','licenses'])walk(resolve(stage,path));
  for(const path of ['AITestHarness.exe','installation.json','THIRD-PARTY-NOTICES.txt'])manifest.files[path]=hash(readFileSync(resolve(stage,path)));
  writeFileSync(resolve(stage,'product-payload.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {status:'candidate_staged',stage,files:Object.keys(manifest.files).length,distribution_ready:false};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){if(process.argv.length!==3)throw Error('Usage: finalize-windows.mjs <unused build stage>');console.log(JSON.stringify(finalizeWindowsStage(process.argv[2])));}
