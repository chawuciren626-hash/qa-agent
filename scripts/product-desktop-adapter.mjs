import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const digest=b=>createHash('sha256').update(b).digest('hex');
const once=(text,before,after)=>{if(text.split(before).length!==2)throw new Error('Unsupported product desktop anchor');return text.replace(before,after);};
export function patchProductDesktop(source,version) {
  if(version!=='0.2.16')throw new Error('Only inspected desktop 0.2.16 is supported');
  source=once(source,'app6.setName(identity.name);',`// AITestHarness distribution adapter v1: keeps upstream runtime, owns product identity.
var qaProductRoot = path27.resolve(app6.getAppPath(), "../../../..");
var qaLayoutModule = await import((await import("node:url")).pathToFileURL(path27.join(qaProductRoot, "app/engine/scripts/product-layout.mjs")).href);
var qaProductLayout = qaLayoutModule.loadProductLayout(path27.join(qaProductRoot, "installation.json"));
var qaProductEnv = qaLayoutModule.productEnvironment(qaProductLayout);
for (const key of Object.keys(process.env)) if (!(key in qaProductEnv)) delete process.env[key];
Object.assign(process.env, qaProductEnv);
process.env.PENGUIN_UPDATE_CHECK = "off";
identity.name = "AITestHarness";
identity.appUserModelId = "org.aitestharness.desktop";
app6.setName(identity.name);
app6.setPath("userData", qaProductLayout.paths.desktop_profile);
app6.setPath("sessionData", qaProductLayout.paths.desktop_profile);`);
  source=once(source,'  const url3 = desktopLoginUrl(started.origin, started.token);',`  const { initializeProductAgents } = await import((await import("node:url")).pathToFileURL(path27.join(qaProductRoot, "app/engine/scripts/product-bootstrap.mjs")).href);
  await initializeProductAgents(qaProductLayout);
  const url3 = desktopLoginUrl(started.origin, started.token);`);
  source=once(source,'      initUpdater(() => win);','      // Product upgrades are coordinated by AITestHarness; do not initialize the upstream installer.');
  source=once(source,'async function checkForUpdatesManually() {',`async function checkForUpdatesManually() {
  await (await import("electron")).dialog.showMessageBox({type:"info", title:"AITestHarness", message:"请通过 AITestHarness 的兼容版本更新入口检查更新。"});
  return;
  // Upstream implementation retained below for version review.`);
  return source;
}
export function installProductDesktop(app) {
  const marker=resolve(app,'product-desktop.json'),main=resolve(app,'dist/main.js');
  if(existsSync(marker))throw new Error('Product shell already staged; use a fresh official image');
  const version=JSON.parse(readFileSync(resolve(app,'package.json'),'utf8')).version;
  const original=readFileSync(main);const next=Buffer.from(patchProductDesktop(original.toString('utf8'),version));
  writeFileSync(main+'.product-original',original,{flag:'wx'});writeFileSync(main,next);
  writeFileSync(marker,JSON.stringify({version:1,host_version:version,adapter_version:1,original_sha256:digest(original),installed_sha256:digest(next)},null,2)+'\n',{flag:'wx'});
  return {status:'staged',host_version:version};
}
export function checkProductDesktop(app) {
  const record=JSON.parse(readFileSync(resolve(app,'product-desktop.json'),'utf8'));
  const source=readFileSync(resolve(app,'dist/main.js.product-original'));
  if(record.version!==1||record.host_version!=='0.2.16'||record.original_sha256!==digest(source)||record.installed_sha256!==digest(readFileSync(resolve(app,'dist/main.js')))||record.installed_sha256!==digest(patchProductDesktop(source.toString('utf8'),record.host_version)))throw new Error('Product shell verification failed');
  return {status:'installed',changed:false};
}
