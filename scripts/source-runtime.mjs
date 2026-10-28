/** Local source build staging and verification. This does not create an installer. */
import {copyFileSync,cpSync,existsSync,mkdirSync,readFileSync,readdirSync,lstatSync,writeFileSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadProductLayout} from './product-layout.mjs';
import {assertPlainPath,within} from './application-data.mjs';
import {releaseResources} from './check-release-resources.mjs';

const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const copy=(from,to)=>{mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);};
function inventory(root) {
  const files={};
  function walk(dir) { for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const file=resolve(dir,entry.name);
    if(lstatSync(file).isSymbolicLink()) throw Error('Linked source runtime file');
    if(entry.isDirectory()) walk(file);
    else files[relative(root,file).replaceAll('\\','/')]=digest(file);
  }}
  walk(root); return files;
}
export function checkSourceRuntime(app,engine) {
  const manifest=JSON.parse(readFileSync(resolve(app,'aitest-source-runtime.json'),'utf8'));
  if(manifest.version!==1||manifest.mode!=='source'||!manifest.files||!manifest.engine_files) throw Error('Invalid source runtime manifest');
  for(const [root,files] of [[app,manifest.files],[engine,manifest.engine_files]]) {
    for(const [name,hash] of Object.entries(files)) {
      if(isAbsolute(name)||name.includes('\\')||name.split('/').some(p=>!p||p==='..'||p==='.')||!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid source manifest path or hash');
      const file=assertPlainPath(resolve(root,name));
      if(!within(root,file)||!lstatSync(file).isFile()||digest(file)!==hash) throw Error('Source runtime checksum mismatch: '+name);
    }
  }
  for(const name of ['dist/main.js','dist/server.js','dist/penguin.js','web-dist/index.html','package.json']) if(!manifest.files[name]) throw Error('Incomplete source runtime: '+name);
  return {status:'source_runtime_verified',version:manifest.upstream.version,files:Object.keys(manifest.files).length,engine_files:Object.keys(manifest.engine_files).length};
}
export function stageSourceRuntime({source,installation,stage}) {
  source=assertPlainPath(resolve(source)); stage=assertPlainPath(resolve(stage));
  const installed=loadProductLayout(installation);
  if(existsSync(stage)||within(source,stage)||within(stage,source)||within(installed.root,stage)||within(stage,installed.root)) throw Error('Use a fresh separate staging directory');
  const desktop=resolve(source,'platform/packages/desktop');
  for(const file of ['dist/main.js','dist/server.js','dist/penguin.js','plugins/package.json']) if(!existsSync(resolve(desktop,file))) throw Error('Build source desktop first: '+file);
  const policy=JSON.parse(readFileSync(resolve(source,'config/release-resources.json'),'utf8'));
  releaseResources(source,policy);
  const extra=['scripts/qa-project-bootstrap.mjs','scripts/trace-outcome.mjs','scripts/source-runtime.mjs'];
  const engine=resolve(stage,'app/engine'),app=resolve(stage,'runtime/penguin/resources/app');
  mkdirSync(stage,{recursive:true});
  const config=JSON.parse(readFileSync(installation,'utf8'));
  config.root='.';
  // This routine stages only the inspected unified layout.
  if(config.paths.engine!=='app/engine'||config.paths.host_executable!=='runtime/penguin/PenguinHarness.exe') throw Error('Unsupported source staging layout');
  writeFileSync(resolve(stage,'installation.json'),JSON.stringify(config,null,2));
  const layout=loadProductLayout(resolve(stage,'installation.json'));
  cpSync(dirname(installed.paths.host_executable),dirname(layout.paths.host_executable),{recursive:true,filter:p=>!within(installed.host_app,p)&&!p.endsWith('.log')});
  cpSync(dirname(installed.paths.node),dirname(layout.paths.node),{recursive:true});
  // Runtime dependencies only; no installed data, agent state or task outputs.
  cpSync(resolve(installed.paths.engine,'node_modules'),resolve(engine,'node_modules'),{recursive:true});
  for(const file of new Set([...policy.files,...extra,'config/release-resources.json'])) copy(resolve(source,file),resolve(engine,file));
  writeFileSync(resolve(engine,'config/session-workspaces.json'),JSON.stringify({version:1,enabled:true,project_id:layout.project_id,controller_agent:'test_agent',default_workspace:layout.paths.workspaces}));
  copy(resolve(engine,'config/test-assets.example.json'),resolve(engine,'config/test-assets.json'));
  for(const folder of ['dist','bin','plugins']) cpSync(resolve(desktop,folder),resolve(app,folder),{recursive:true,filter:p=>!p.endsWith('.map')});
  cpSync(resolve(source,'platform/packages/web/dist'),resolve(app,'web-dist'),{recursive:true});
  const pkg=JSON.parse(readFileSync(resolve(desktop,'package.json'),'utf8'));
  writeFileSync(resolve(app,'package.json'),JSON.stringify({name:'aitestharness-desktop',version:pkg.version,private:true,type:'module',main:'dist/main.js',dependencies:pkg.dependencies},null,2));
  for(const name of Object.keys(pkg.dependencies)) {
    const plugin=resolve(desktop,'node_modules',name);
    const metadata=JSON.parse(readFileSync(resolve(plugin,'package.json'),'utf8'));
    const dest=resolve(app,'node_modules',name);
    copy(resolve(plugin,'package.json'),resolve(dest,'package.json'));
    for(const item of metadata.files ?? []) {
      if(item.includes('*')||item.includes('..')||isAbsolute(item)) throw Error('Unsupported plugin file pattern: '+item);
      const origin=resolve(plugin,item);
      if(existsSync(origin)) cpSync(origin,resolve(dest,item),{recursive:true,dereference:true});
    }
  }
  copy(resolve(source,'penguin/ui/aith-icon.png'),resolve(app,'dist/icon.png'));
  copy(resolve(source,'penguin/ui/aith-tray.png'),resolve(app,'dist/tray/tray.png'));
  copy(resolve(source,'penguin/ui/aith-tray@2x.png'),resolve(app,'dist/tray/tray@2x.png'));
  copy(resolve(source,'platform/LICENSE'),resolve(app,'LICENSE'));
  copy(resolve(source,'platform/THIRD-PARTY-NOTICES.md'),resolve(app,'THIRD-PARTY-NOTICES.md'));
  const engineFiles=Object.fromEntries([...new Set([...policy.files,...extra,'config/release-resources.json'])].map(name=>[name,digest(resolve(engine,name))]));
  const appFiles=inventory(app);
  delete appFiles['aitest-source-runtime.json']; // A staged copy may contain the previous manifest; it cannot hash itself.
  writeFileSync(resolve(app,'aitest-source-runtime.json'),JSON.stringify({version:1,mode:'source',upstream:JSON.parse(readFileSync(resolve(source,'platform/upstream-source.json'),'utf8')),files:appFiles,engine_files:engineFiles},null,2));
  return {stage,...checkSourceRuntime(app,engine)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [installation,stage]=process.argv.slice(2);
  if(!installation||!stage) throw Error('Usage: source-runtime.mjs <installation.json> <fresh-stage>');
  console.log(JSON.stringify(stageSourceRuntime({source:resolve(import.meta.dirname,'..'),installation:resolve(installation),stage:resolve(stage)})));
}
