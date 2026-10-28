import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {checkSourceRuntime} from '../../scripts/source-runtime.mjs';
import {syncSourceRuntime,assertSourceTargetStopped} from '../../scripts/sync-source-runtime.mjs';
import {loadProductLayout} from '../../scripts/product-layout.mjs';

const write=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value));};
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
  const root=mkdtempSync(resolve(tmpdir(),'qa-source-sync-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5}));
  const config={version:1,installation_id:'qa-source-test',layout:'unified',root:'.',project_id:'default_project',paths:{engine:'app/engine',host_executable:'runtime/penguin/PenguinHarness.exe',host_data:'data/penguin',qa_data:'data/qa',desktop_profile:'data/profile',workspaces:'workspaces',node:'runtime/node/node.exe'}};
  for(const dir of ['installed','stage'])write(resolve(root,dir,'installation.json'),config);
  const installed=loadProductLayout(resolve(root,'installed/installation.json')),stage=loadProductLayout(resolve(root,'stage/installation.json'));
  write(resolve(installed.paths.engine,'scripts/engine.mjs'),'old');
  write(resolve(installed.paths.engine,'config/local-only.json'),'preserve');
  write(resolve(installed.host_app,'old.txt'),'old-shell');
  write(resolve(installed.paths.host_data,'default_project/qa-project.json'),{status:'ready'});
  write(resolve(installed.paths.host_data,'private-test.json'),'synthetic-private-setting');
  write(resolve(installed.paths.qa_data,'audit.json'),'synthetic-audit');
  write(resolve(installed.paths.desktop_profile,'Preferences'),'synthetic-preferences');
  const files={};for(const file of ['dist/main.js','dist/server.js','dist/penguin.js','web-dist/index.html','package.json']){const value=file==='package.json'?'{"version":"0.2.17"}':'fixture';write(resolve(stage.host_app,file),value);files[file]=hash(value);}
  write(resolve(stage.paths.engine,'scripts/engine.mjs'),'new');
  write(resolve(stage.host_app,'aitest-source-runtime.json'),{version:1,mode:'source',upstream:{version:'0.2.17'},files,engine_files:{'scripts/engine.mjs':hash('new')}});
  return {root,installed,stage,args:{installation:resolve(root,'installed/installation.json'),stage:stage.root,backupRoot:resolve(root,'backups')}};
}
test('source sync preserves local configuration and data with verified recovery copies',async t=>{
  const f=fixture(t),result=await syncSourceRuntime(f.args);
  assert.equal(result.status,'synchronized');
  assert.equal(readFileSync(resolve(f.installed.paths.engine,'scripts/engine.mjs'),'utf8'),'new');
  assert.equal(readFileSync(resolve(f.installed.paths.engine,'config/local-only.json'),'utf8'),'preserve');
  assert.equal(readFileSync(resolve(f.installed.paths.host_data,'private-test.json'),'utf8'),'synthetic-private-setting');
  assert.equal(readFileSync(resolve(result.backup,'engine/scripts/engine.mjs'),'utf8'),'old');
  assert.equal(readFileSync(resolve(result.backup,'desktop-app/old.txt'),'utf8'),'old-shell');
  assert.equal(readFileSync(resolve(result.backup,'host_data/private-test.json'),'utf8'),'synthetic-private-setting');
  assert.equal(checkSourceRuntime(f.installed.host_app,f.installed.paths.engine).status,'source_runtime_verified');
  assert.equal(existsSync(resolve(f.installed.root,'.source-sync.lock')),false);
});
test('tampered source payload is refused before modifying installation or data',async t=>{
  const f=fixture(t);write(resolve(f.stage.host_app,'dist/server.js'),'changed');
  await assert.rejects(syncSourceRuntime(f.args),/checksum mismatch/);
  assert.equal(readFileSync(resolve(f.installed.paths.engine,'scripts/engine.mjs'),'utf8'),'old');
  assert.equal(existsSync(resolve(f.root,'backups')),false);
});
test('live server and unfinished project initialization prevent synchronization',async t=>{
  const f=fixture(t);write(resolve(f.installed.paths.host_data,'server.lock'),{pid:process.pid});
  assert.throws(()=>assertSourceTargetStopped(f.installed),/still alive/);
  rmSync(resolve(f.installed.paths.host_data,'server.lock'));
  write(resolve(f.installed.paths.host_data,'default_project/qa-project.json'),{status:'initializing'});
  await assert.rejects(syncSourceRuntime(f.args),/initialization incomplete/);
});
