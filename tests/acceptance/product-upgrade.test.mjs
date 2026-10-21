import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {installProductCandidate,recoverProductUpgrade} from '../../scripts/product-upgrade.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const put=(p,v)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,typeof v==='string'?v:JSON.stringify(v));};
const opts={assertStopped:()=>{},performSetup:()=>{}};
function fixture(t){
  const base=mkdtempSync(resolve(tmpdir(),'qa-upgrade-中文 路径-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const target=resolve(base,'installed'),source=resolve(base,'candidate');
  const config=JSON.parse(readFileSync(new URL('../../config/product-installation.example.json',import.meta.url),'utf8'));config.root='.';
  function build(root,v){
    put(resolve(root,'installation.json'),config);
    for(const [name,value] of Object.entries({'AITestHarness.exe':v,'app/engine/config/owned.json':'{}','app/engine/scripts/product-setup.mjs':'// fixture','runtime/penguin/PenguinHarness.exe':v,'runtime/tools/node/node.exe':v,'licenses/LICENSE.txt':'license','THIRD-PARTY-NOTICES.txt':'notices'}))put(resolve(root,name),value);
    const files={};function walk(p){for(const e of readdirSync(p,{withFileTypes:true})){const file=resolve(p,e.name);if(e.isDirectory())walk(file);else files[relative(root,file).replaceAll('\\','/')]=digest(readFileSync(file));}}walk(root);
    put(resolve(root,'product-payload.json'),{version:1,product_version:v,host_version:'0.2.16',upgrade:{protocol:1,data_version:1},files});
  }
  build(target,'0.1.0-preview.1');build(source,'0.1.0-preview.2');
  put(resolve(target,'data/penguin/model-config.fixture'),'synthetic credential placeholder');
  put(resolve(target,'data/penguin/session.fixture'),'historical conversation');put(resolve(target,'workspaces/report.fixture'),'delivered report');
  put(resolve(target,'app/engine/config/test-assets.json'),{assets:['user-owned']});
  return {base,target,source};
}
function preserved(f){assert.equal(readFileSync(resolve(f.target,'data/penguin/model-config.fixture'),'utf8'),'synthetic credential placeholder');assert.equal(readFileSync(resolve(f.target,'data/penguin/session.fixture'),'utf8'),'historical conversation');assert.equal(readFileSync(resolve(f.target,'workspaces/report.fixture'),'utf8'),'delivered report');assert.deepEqual(read(resolve(f.target,'app/engine/config/test-assets.json')),{assets:['user-owned']});}
test('upgrade keeps data, configuration and a complete previous-program backup',t=>{
  const f=fixture(t),r=installProductCandidate(f.source,f.target,opts);assert.equal(r.status,'upgraded');preserved(f);
  assert.equal(readFileSync(resolve(f.target,'AITestHarness.exe'),'utf8'),'0.1.0-preview.2');
  assert.equal(readFileSync(resolve(f.target,'.product-upgrade',r.transaction,'backup/AITestHarness.exe'),'utf8'),'0.1.0-preview.1');
  assert.equal(existsSync(resolve(f.target,'.product-upgrade/active.json')),false);
});
test('setup failure restores old programs without restoring over user data',t=>{
  const f=fixture(t);assert.throws(()=>installProductCandidate(f.source,f.target,{...opts,performSetup:()=>{put(resolve(f.target,'workspaces/new.fixture'),'new data');throw Error('simulated setup failure');}}),/旧程序/);
  preserved(f);assert.equal(readFileSync(resolve(f.target,'AITestHarness.exe'),'utf8'),'0.1.0-preview.1');assert.equal(readFileSync(resolve(f.target,'workspaces/new.fixture'),'utf8'),'new data');
});
test('each program-swap boundary rolls back on synchronous failure',t=>{
  for(const point of ['prepared','backed_up:AITestHarness.exe','installed:AITestHarness.exe','backed_up:app','installed:app','backed_up:runtime','installed:runtime','installed:product-payload.json','configured']){
    const f=fixture(t);assert.throws(()=>installProductCandidate(f.source,f.target,{...opts,checkpoint:p=>{if(p===point)throw Error(point);}}));preserved(f);assert.equal(readFileSync(resolve(f.target,'AITestHarness.exe'),'utf8'),'0.1.0-preview.1');
  }
});
test('process interruption between renames is recovered from the persistent journal',t=>{
  for(const point of ['backed_up:app','installed:runtime','configured']){
    const f=fixture(t);const module=new URL('../../scripts/product-upgrade.mjs',import.meta.url).href;
    const code=`import {installProductCandidate} from ${JSON.stringify(module)};installProductCandidate(${JSON.stringify(f.source)},${JSON.stringify(f.target)},{assertStopped:()=>{},performSetup:()=>{},checkpoint:p=>{if(p===${JSON.stringify(point)})process.exit(91)}});`;
    assert.equal(spawnSync(process.execPath,['--input-type=module','-e',code]).status,91);
    assert.equal(recoverProductUpgrade(f.target,{assertStopped:()=>{},processAlive:()=>false}).status,'recovered');preserved(f);
    assert.equal(readFileSync(resolve(f.target,'AITestHarness.exe'),'utf8'),'0.1.0-preview.1');assert.equal(installProductCandidate(f.source,f.target,opts).status,'upgraded');
  }
});
test('reject running target, modified candidate, downgrade and different host before replacement',t=>{
  for(const mode of ['running','hash','downgrade','host','config']){
    const f=fixture(t);const file=resolve(f.source,'product-payload.json'),m=read(file);
    if(mode==='hash')put(resolve(f.source,'AITestHarness.exe'),'tampered');
    if(mode==='downgrade')m.product_version='0.0.9';if(mode==='host')m.host_version='0.2.17';put(file,m);
    if(mode==='config')put(resolve(f.target,'app/engine/config/owned.json'),'edited');
    assert.throws(()=>installProductCandidate(f.source,f.target,{...opts,...(mode==='running'?{assertStopped:()=>{throw Error('running');}}:{})}));preserved(f);assert.equal(readFileSync(resolve(f.target,'AITestHarness.exe'),'utf8'),'0.1.0-preview.1');
  }
});
test('reject non-owned directory, manifest traversal and directory junction',t=>{
  const f=fixture(t);const unknown=resolve(f.base,'unknown');put(resolve(unknown,'keep.txt'),'keep');assert.throws(()=>installProductCandidate(f.source,unknown,opts));
  const file=resolve(f.source,'product-payload.json'),m=read(file);m.files['../outside']=digest('x');put(file,m);assert.throws(()=>installProductCandidate(f.source,f.target,opts));delete m.files['../outside'];put(file,m);
  const outside=resolve(f.base,'outside');mkdirSync(outside);symlinkSync(outside,resolve(f.target,'app/link'),process.platform==='win32'?'junction':'dir');assert.throws(()=>installProductCandidate(f.source,f.target,opts));
});
test('fresh installation uses the same transaction and commits canonical config',t=>{
  const f=fixture(t),fresh=resolve(f.base,'fresh');assert.equal(installProductCandidate(f.source,fresh,opts).status,'installed');assert.equal(read(resolve(fresh,'installation.json')).root,'.');
});
test('live installer lock blocks concurrent replacement; committed recovery keeps new files',t=>{
  const f=fixture(t);const r=installProductCandidate(f.source,f.target,opts);
  const active=resolve(f.target,'.product-upgrade/active.json');put(active,{version:1,id:r.transaction,pid:process.pid});
  assert.throws(()=>recoverProductUpgrade(f.target,{assertStopped:()=>{},processAlive:()=>true}),/active/);
  assert.equal(recoverProductUpgrade(f.target,{assertStopped:()=>{},processAlive:()=>false}).status,'already_committed');
  assert.equal(readFileSync(resolve(f.target,'AITestHarness.exe'),'utf8'),'0.1.0-preview.2');preserved(f);
});
test('failed fresh setup can retry with empty data directories but will not adopt unknown data',t=>{
  const f=fixture(t),fresh=resolve(f.base,'fresh');
  assert.throws(()=>installProductCandidate(f.source,fresh,{...opts,performSetup:r=>{mkdirSync(resolve(r,'data/penguin'),{recursive:true});mkdirSync(resolve(r,'workspaces'));throw Error('setup interrupted');}}));
  assert.equal(installProductCandidate(f.source,fresh,opts).status,'installed');
  const unknown=resolve(f.base,'unowned');put(resolve(unknown,'data/penguin/user.txt'),'keep');assert.throws(()=>installProductCandidate(f.source,unknown,opts));assert.equal(readFileSync(resolve(unknown,'data/penguin/user.txt'),'utf8'),'keep');
});
