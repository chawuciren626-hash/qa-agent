import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installPenguinRuntime } from '../../scripts/install-penguin-runtime.mjs';
import { patchServer } from '../../scripts/install-penguin-workspace-adapter.mjs';
import { patchDeliveryBundle, patchDeliveryServer } from '../../scripts/install-penguin-delivery-ui.mjs';
import { libraryAnchor } from '../../scripts/client-library.mjs';
import { clientPatchPairs } from '../../scripts/client-ui-patches.mjs';
import { reliabilityPatches } from '../../scripts/penguin-reliability-patches.mjs';
import { hostPatchAnchors } from '../../scripts/host-observability.mjs';
import { humanActionAnchors } from '../../scripts/human-action-patches.mjs';

const root=resolve(import.meta.dirname,'../..');
const digest=bytes=>bytes===null?null:createHash('sha256').update(bytes).digest('hex');
const originalServer='    let workspaceDir2;\n    if (opts.workspaceDir) {\n    const sessionId = formatSessionId();\n    const spec = {\n        controlEnv: () => this.controlEnv({\n          projectId: this.state.projectId,\n          agentId: this.state.agentId,\n          sessionId\n        })\n      } : {},\n  app.post("/:sessionId/files/reveal", async (c7) => {'+'\n'+libraryAnchor+'\n'+reliabilityPatches.map(([before])=>before).join('\n')+'\n'+hostPatchAnchors.join('\n')+'\n'+humanActionAnchors.join('\n')+'\nsession.startRun(messages, { suppressDoneReport: true });\nsession.startRun(messages, { suppressDoneReport: true });';
const originalBundle=[
  'function lO({item:e,ctx:t}){',
  'case"assistant_text":return r.jsxs("div",{className:"md-body anim-msg my-3',
  'function Ale({items:e,ctx:t}){const n=[];',
  'for(const p of e)Cle(p)?a.push(p):(s(),n.push({type:"single",item:p}));s();',
  'o=Tle(e,t),[l,d]=f.useState(s),m=f.useRef(!1),p=f.useRef(null);f.useEffect(()=>{m.current||d(s)},[s]);',
  'children:s?c.chat.workRunning:c.chat.workDone}),x>0',
  't.origin.length===0&&t.onOpenFile&&t.statFiles&&e.assistantText.trim()!==""&&r.jsx(gN',
  'workspace:pe?.workspace??null,statFiles:ms,onFork:io}'
].concat(clientPatchPairs.map(([before])=>before)).join('\n');
const originalIndex='<script src="/assets/index-fixture.js"></script>';
function fixture() {
  const app=resolve(root,'output/acceptance/runtime-installer',randomUUID());
  const put=(path,bytes)=>{mkdirSync(dirname(resolve(app,path)),{recursive:true});writeFileSync(resolve(app,path),bytes);};
  put('package.json',JSON.stringify({version:'0.2.13'}));
  put('dist/server.js',originalServer);put('web-dist/index.html',originalIndex);put('web-dist/assets/index-fixture.js',originalBundle);
  return {app,put,get:path=>readFileSync(resolve(app,path),'utf8')};
}
function legacy(f) {
  const workspace=patchServer(originalServer,pathToFileURL(resolve(root,'scripts/penguin-workspace-adapter.mjs')).href);
  const server=patchDeliveryServer(workspace,pathToFileURL(resolve(root,'scripts/open-deliverable.mjs')).href);
  const module=readFileSync(resolve(root,'penguin/ui/delivery-ui.mjs'));
  const bundle=patchDeliveryBundle(originalBundle,digest(module).slice(0,16));
  const index=originalIndex.replace('index-fixture.js','index-fixture.js?qa-delivery='+digest(bundle).slice(0,16));
  f.put('dist/server.js',server);f.put('web-dist/assets/index-fixture.js',bundle);f.put('web-dist/index.html',index);f.put('web-dist/assets/qa-delivery-ui.js',module);
  f.put('dist/server.js.qa-workspace.original',originalServer);
  f.put('dist/server.js.qa-workspace.json',JSON.stringify({version:'0.2.13',original_sha256:digest(originalServer),patched_sha256:digest(workspace)}));
  f.put('dist/server.js.qa-delivery-original',workspace);f.put('web-dist/assets/index-fixture.js.qa-delivery-original',originalBundle);f.put('web-dist/index.html.qa-delivery-original',originalIndex);
  f.put('qa-delivery-install.json',JSON.stringify({targets:['web-dist/assets/index-fixture.js','dist/server.js','web-dist/assets/qa-delivery-ui.js'].map(p=>resolve(f.app,p)),original:[digest(originalBundle),digest(workspace)],installed:[digest(bundle),digest(server),digest(module)],index:{original:digest(originalIndex),installed:digest(index)}}));
}

test('unified check is read-only; apply is idempotent; restore and reapply maintain both patches',()=>{
  const f=fixture();
  assert.equal(installPenguinRuntime(f.app,root).status,'update_available');
  assert.equal(existsSync(resolve(f.app,'qa-runtime-install.json')),false);
  assert.equal(installPenguinRuntime(f.app,root,'apply').restart_required,true);
  assert.equal(installPenguinRuntime(f.app,root).status,'installed');
  assert.equal(installPenguinRuntime(f.app,root,'apply').changed,false);
  assert.match(f.get('dist/server.js'),/qaWorkspaceBind/);assert.match(f.get('dist/server.js'),/qaOpenDeliverable/);
  installPenguinRuntime(f.app,root,'restore');
  assert.equal(f.get('dist/server.js'),originalServer);assert.equal(f.get('web-dist/index.html'),originalIndex);assert.equal(f.get('web-dist/assets/index-fixture.js'),originalBundle);
  assert.equal(existsSync(resolve(f.app,'web-dist/assets/qa-delivery-ui.js')),false);
  assert.equal(installPenguinRuntime(f.app,root).status,'restored');
  assert.equal(installPenguinRuntime(f.app,root,'restore').changed,false);
  installPenguinRuntime(f.app,root,'apply');assert.equal(installPenguinRuntime(f.app,root).status,'installed');
});

test('legacy layered installation is adopted without losing originals; old CLI checks both layers',()=>{
  const f=fixture();legacy(f);
  assert.equal(installPenguinRuntime(f.app,root).migration_required,true);
  installPenguinRuntime(f.app,root,'apply');
  for(const script of ['install-penguin-workspace-adapter.mjs','install-penguin-delivery-ui.mjs']) {
    const child=spawnSync(process.execPath,[resolve(root,'scripts',script),f.app,'--check'],{encoding:'utf8',windowsHide:true});
    assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).status,'installed');
  }
  installPenguinRuntime(f.app,root,'restore');assert.equal(f.get('dist/server.js'),originalServer);
});

test('unknown edits, corrupt backups and incompatible versions fail before any installation write',()=>{
  for(const kind of ['server','backup','version','legacy-chain']) {
    const f=fixture();
    if(kind==='legacy-chain') {legacy(f);f.put('dist/server.js.qa-workspace.original','unknown');}
    else {
      installPenguinRuntime(f.app,root,'apply');
      f.put(kind==='server'?'dist/server.js':kind==='backup'?'dist/server.js.qa-runtime-original':'package.json',kind==='version'?'{"version":"0.3.0"}':'unknown');
    }
    const before=f.get('dist/server.js');
    assert.throws(()=>installPenguinRuntime(f.app,root,'apply'),/Checksum|supported/);
    assert.equal(f.get('dist/server.js'),before);assert.equal(existsSync(resolve(f.app,'qa-runtime-transaction.json')),false);
  }
});

test('failure at every write rolls back fresh installation, including backups, module and record',()=>{
  for(let failure=1;failure<=8;failure++) {
    const f=fixture();let writes=0;
    assert.throws(()=>installPenguinRuntime(f.app,root,'apply',{afterWrite:()=>{if(++writes===failure)throw new Error('injected failure');}}),/injected failure/);
    assert.equal(f.get('dist/server.js'),originalServer);assert.equal(f.get('web-dist/index.html'),originalIndex);assert.equal(f.get('web-dist/assets/index-fixture.js'),originalBundle);
    for(const path of ['qa-runtime-install.json','qa-runtime-transaction.json','web-dist/assets/qa-delivery-ui.js','dist/server.js.qa-runtime-original']) assert.equal(existsSync(resolve(f.app,path)),false,path);
    assert.equal(installPenguinRuntime(f.app,root,'apply').status,'installed');
  }
});

test('interrupted install is detected and recovered only for known before/after bytes',()=>{
  const f=fixture();
  const before=Buffer.from(originalServer),after=Buffer.from('partially installed');
  const journal={version:1,files:[{path:'dist/server.js',before:before.toString('base64'),before_sha256:digest(before),after_sha256:digest(after)}]};
  f.put('qa-runtime-transaction.json',JSON.stringify(journal));f.put('dist/server.js',after);
  assert.equal(installPenguinRuntime(f.app,root).status,'recovery_required');
  assert.throws(()=>installPenguinRuntime(f.app,root,'apply'),/Interrupted/);
  f.put('dist/server.js','foreign change');assert.throws(()=>installPenguinRuntime(f.app,root,'recover'),/Unknown changes/);
  f.put('dist/server.js',after);assert.equal(installPenguinRuntime(f.app,root,'recover').status,'recovered');
  assert.equal(f.get('dist/server.js'),originalServer);
  journal.files[0].path='../outside';f.put('qa-runtime-transaction.json',JSON.stringify(journal));
  assert.throws(()=>installPenguinRuntime(f.app,root,'recover'),/Invalid managed path/);
});

test('runtime helper changes and engine relocation require apply/restart without accepting app drift',()=>{
  const f=fixture();installPenguinRuntime(f.app,root,'apply');
  const engine=resolve(f.app,'engine');
  for(const path of ['penguin/ui/delivery-ui.mjs','penguin/ui/workspace-ui.mjs','penguin/ui/workspace-ui.css','penguin/ui/aith-logo.svg','penguin/ui/aith-logo-light.svg','scripts/penguin-workspace-adapter.mjs','scripts/open-deliverable.mjs','scripts/client-library.mjs','scripts/host-observability.mjs','scripts/protected-inputs.mjs','scripts/browser-human-action.mjs']) {
    mkdirSync(dirname(resolve(engine,path)),{recursive:true});cpSync(resolve(root,path),resolve(engine,path));
  }
  assert.equal(installPenguinRuntime(f.app,engine).restart_on_apply,true);
  installPenguinRuntime(f.app,engine,'apply');
  writeFileSync(resolve(engine,'scripts/open-deliverable.mjs'),'// changed runtime helper');
  assert.equal(installPenguinRuntime(f.app,engine).status,'update_available');
  assert.equal(installPenguinRuntime(f.app,engine,'apply').restart_required,true);
  assert.equal(installPenguinRuntime(f.app,engine).status,'installed');
});

test('restore failure rolls back installed bytes and installation record together',()=>{
  for(let failure=1;failure<=5;failure++) {
    const f=fixture();installPenguinRuntime(f.app,root,'apply');
    const record=f.get('qa-runtime-install.json'),server=f.get('dist/server.js');let writes=0;
    assert.throws(()=>installPenguinRuntime(f.app,root,'restore',{afterWrite:()=>{if(++writes===failure)throw Error('restore failure');}}),/restore failure/);
    assert.equal(f.get('qa-runtime-install.json'),record);assert.equal(f.get('dist/server.js'),server);
    assert.equal(installPenguinRuntime(f.app,root).status,'installed');
  }
});

test('real installer process interruption leaves recoverable journal and stale lock',()=>{
  const f=fixture();
  const code=`import {installPenguinRuntime} from ${JSON.stringify(pathToFileURL(resolve(root,'scripts/install-penguin-runtime.mjs')).href)}; installPenguinRuntime(${JSON.stringify(f.app)},${JSON.stringify(root)},'apply',{afterWrite:path=>{if(path==='dist/server.js')process.exit(17);}});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(child.status,17,child.stderr);
  assert.equal(installPenguinRuntime(f.app,root).status,'recovery_required');
  assert.equal(installPenguinRuntime(f.app,root,'recover').status,'recovered');
  assert.equal(f.get('dist/server.js'),originalServer);
  assert.equal(existsSync(resolve(f.app,'qa-runtime-install.lock')),false);
  assert.equal(installPenguinRuntime(f.app,root,'apply').status,'installed');
});
