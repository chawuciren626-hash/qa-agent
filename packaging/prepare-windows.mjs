import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,readdirSync,lstatSync,renameSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {releaseResources} from '../scripts/check-release-resources.mjs';
import {finalizeWindowsStage} from './finalize-windows.mjs';

const root=resolve(import.meta.dirname,'..'),options={};
for(const arg of process.argv.slice(2)){const m=/^--(stage|installer|python-archive|tooling|npm-cli|build-python)=(.+)$/.exec(arg);if(!m||options[m[1]])throw Error('Unknown or duplicate build argument');options[m[1]]=resolve(m[2]);}
for(const key of ['stage','installer','python-archive','tooling','npm-cli','build-python'])if(!options[key])throw Error('Missing --'+key);
if(process.platform!=='win32')throw Error('Windows packaging requires a Windows build host');
const pins=JSON.parse(readFileSync(resolve(root,'packaging/runtime-sources.json'),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const [key,expected] of [['installer',pins.host.sha256],['python-archive',pins.python.sha256]])if(hash(readFileSync(options[key]))!==expected)throw Error('Archive checksum mismatch: '+key);
if(existsSync(options.stage))throw Error('Build staging directory already exists; select a fresh directory');
const stage=options.stage,engine=resolve(stage,'app/engine'),host=resolve(stage,'runtime/penguin'),toolsRoot=resolve(stage,'runtime/tools');
const seven=resolve(options.tooling,'node_modules/7zip-bin/win/x64/7za.exe'),nodeSource=resolve(options.tooling,'node_modules/node-win-x64/bin/node.exe');
const policy=JSON.parse(readFileSync(resolve(root,'config/release-resources.json'),'utf8'));releaseResources(root,policy);
function run(exe,args,env=process.env,cwd=root){return new Promise((done,reject)=>{const child=spawn(exe,args,{cwd,env,windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('close',code=>code===0?done():reject(Error('Build step failed: '+exe+' (exit '+code+')')));});}
const copy=(a,b)=>{mkdirSync(dirname(b),{recursive:true});copyFileSync(a,b);};
mkdirSync(stage,{recursive:true});
const extract=resolve(stage,'build-only-extract');
await run(seven,['x',options.installer,'-o'+extract,'-y','-bso0','-bsp0']);
// Supported extractors either expose NSIS's nested archive or expand its application directly.
if(existsSync(resolve(extract,'PenguinHarness.exe'))&&existsSync(resolve(extract,'resources/app/package.json'))) {
  mkdirSync(dirname(host),{recursive:true});renameSync(extract,host);mkdirSync(extract);
} else await run(seven,['x',resolve(extract,'$PLUGINSDIR/app-64.7z'),'-o'+host,'-y','-bso0','-bsp0']);
for(const file of policy.files)copy(resolve(root,file),resolve(engine,file));
copy(resolve(root,'config/release-resources.json'),resolve(engine,'config/release-resources.json'));
copy(nodeSource,resolve(toolsRoot,'node/node.exe'));
const node=resolve(toolsRoot,'node/node.exe');
await run(node,[options['npm-cli'],'ci','--prefix',engine,'--omit=dev','--ignore-scripts','--no-audit','--no-fund']);
const python=resolve(toolsRoot,'python');
await run(seven,['x',options['python-archive'],'-o'+python,'-y','-bso0','-bsp0']);
const wheels=resolve(extract,'wheels');mkdirSync(wheels,{recursive:true});
await run(options['build-python'],['-m','pip','download','--only-binary=:all:','--platform','win_amd64','--python-version','312','--implementation','cp','--abi','cp312','--dest',wheels,'-r',resolve(root,'packaging/requirements-runtime.txt')]);
await run(options['build-python'],['-c','import pathlib,zipfile,sys; dest=pathlib.Path(sys.argv[2]); dest.mkdir(parents=True,exist_ok=True); [zipfile.ZipFile(p).extractall(dest) for p in pathlib.Path(sys.argv[1]).glob("*.whl")]',wheels,resolve(python,'Lib/site-packages')]);
writeFileSync(resolve(python,'python312._pth'),'python312.zip\n.\nLib/site-packages\n../../../app/engine/scripts\nimport site\n');
await run(resolve(python,'python.exe'),['-c','import docx,reportlab,lxml,PIL,tomllib; print("Bundled Python document runtime ready")']);
await run(node,[resolve(engine,'node_modules/playwright/cli.js'),'install','chromium'],{...process.env,PLAYWRIGHT_BROWSERS_PATH:resolve(toolsRoot,'browsers')});
console.log(JSON.stringify(finalizeWindowsStage(stage)));
