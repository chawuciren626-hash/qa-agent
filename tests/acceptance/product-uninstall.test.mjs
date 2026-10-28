import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync,realpathSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {assertUninstallProcessesStopped,checkProductUninstall} from '../../scripts/product-uninstall-check.mjs';

function fixture(t){
  const base=realpathSync(mkdtempSync(resolve(tmpdir(),'qa-uninstall-中文-')));
  t.after(()=>rmSync(base,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
  const root=resolve(base,'installed'),engine=resolve(root,'app/engine');
  for(const dir of ['app/engine','runtime','licenses','data','workspaces'])mkdirSync(resolve(root,dir),{recursive:true});
  const config=JSON.parse(readFileSync(new URL('../../config/product-installation.example.json',import.meta.url),'utf8'));config.root='.';
  writeFileSync(resolve(root,'installation.json'),JSON.stringify(config));
  writeFileSync(resolve(root,'product-payload.json'),JSON.stringify({version:1,files:{'AITestHarness.exe':'fixture'}}));
  writeFileSync(resolve(root,'data/keep.txt'),'synthetic user data');
  writeFileSync(resolve(root,'workspaces/keep.txt'),'synthetic task output');
  return {base,root,engine,config:resolve(root,'installation.json')};
}

test('running application yields an actionable error while query noise stays captured',()=>{
  assert.throws(()=>assertUninstallProcessesStopped('C:/synthetic',{run:(exe,args,options)=>{
    const ps=Buffer.from(args.at(-1),'base64').toString('utf16le');
    assert.match(ps,/\$ProgressPreference="SilentlyContinue"/);
    assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
    assert.equal(options.windowsHide,true);
    assert.equal(options.env.QA_REMOVE_SELF,'101');assert.equal(options.env.QA_REMOVE_PARENT,'100');
    return '2\r\n';
  },self:101,parent:100}),e=>e.code==='UNINSTALL_APP_RUNNING'&&e.message.includes('托盘')&&e.message.includes('等待任务结束')&&/^[\x00-\x7f]+$/.test(e.legacyMessage));
});

test('empty, malformed and failed process queries never permit removal or expose CLIXML',()=>{
  for(const output of ['','#< CLIXML\n<Objs/>','NaN','-1','0\nnoise']){
    assert.throws(()=>assertUninstallProcessesStopped('C:/synthetic',{run:()=>output}),e=>e.code==='UNINSTALL_PROCESS_QUERY_INVALID'&&!e.message.includes('CLIXML'));
  }
  assert.throws(()=>assertUninstallProcessesStopped('C:/synthetic',{run:()=>{throw Error('#< CLIXML sensitive raw error');}}),e=>e.code==='UNINSTALL_PROCESS_QUERY_FAILED'&&!e.message.includes('CLIXML'));
  assert.doesNotThrow(()=>assertUninstallProcessesStopped('C:/synthetic',{run:()=>'0\r\n'}));
});

test('uninstall precheck is read-only, including running application rejection',t=>{
  const f=fixture(t);
  assert.throws(()=>checkProductUninstall(f.config,{engineRoot:f.engine,assertStopped:root=>{
    assert.equal(root,f.root);assertUninstallProcessesStopped(root,{run:()=>'1'});
  }}),e=>e.code==='UNINSTALL_APP_RUNNING');
  assert.equal(readFileSync(resolve(f.root,'data/keep.txt'),'utf8'),'synthetic user data');
  assert.equal(readFileSync(resolve(f.root,'workspaces/keep.txt'),'utf8'),'synthetic task output');
  assert.ok(existsSync(f.engine));
  assert.equal(checkProductUninstall(f.config,{engineRoot:f.engine,assertStopped:()=>{}}).status,'safe_to_uninstall');
});

test('pending transaction, wrong installation and linked program paths still block uninstall',t=>{
  const f=fixture(t);const options={engineRoot:f.engine,assertStopped:()=>assert.fail('must reject before process query')};
  mkdirSync(resolve(f.root,'.product-upgrade'));writeFileSync(resolve(f.root,'.product-upgrade/active.json'),'{}');
  assert.throws(()=>checkProductUninstall(f.config,options),e=>e.code==='UNINSTALL_PENDING_TRANSACTION');
  rmSync(resolve(f.root,'.product-upgrade/active.json'));
  assert.throws(()=>checkProductUninstall(f.config,{...options,engineRoot:f.base}),/location differs/);
  const outside=resolve(f.base,'outside');mkdirSync(outside);
  symlinkSync(outside,resolve(f.engine,'link'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>checkProductUninstall(f.config,options),/Linked program/);
});

test('legacy CLI fallback is ASCII and new error file preserves the actionable Chinese message',t=>{
  const f=fixture(t),errorFile=resolve(f.base,'错误.txt');
  mkdirSync(resolve(f.root,'.product-upgrade'));writeFileSync(resolve(f.root,'.product-upgrade/active.json'),'{}');
  for(const optional of [[],[errorFile]]){
    const result=spawnSync(process.execPath,[resolve('scripts/product-uninstall-check.mjs'),f.config,...optional],{encoding:'utf8'});
    assert.equal(result.status,1);assert.match(result.stderr,/UNINSTALL_PENDING_TRANSACTION/);assert.match(result.stderr,/^[\x00-\x7f]+$/);
    assert.doesNotMatch(result.stderr,/CLIXML/);
  }
  assert.match(readFileSync(errorFile,'utf16le'),/安装事务尚未完成/);
});

test('real Windows process query blocks a running executable under the selected root', {skip:process.platform!=='win32'},t=>{
  const f=fixture(t);
  // The copied Node is this test's process, not a user application or worker.
  const node=resolve(f.root,'runtime/node.exe');copyFileSync(process.execPath,node);
  const module=new URL('../../scripts/product-uninstall-check.mjs',import.meta.url).href;
  const code=`import {assertUninstallProcessesStopped} from ${JSON.stringify(module)};try {assertUninstallProcessesStopped(${JSON.stringify(f.root)},{self:0,parent:0});process.exitCode=2;}catch(e){console.log(e.code);if(e.code!=='UNINSTALL_APP_RUNNING')process.exitCode=3;}`;
  const result=spawnSync(node,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true,timeout:25000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'UNINSTALL_APP_RUNNING');assert.equal(result.stderr,'');
  assert.doesNotThrow(()=>assertUninstallProcessesStopped(f.root));
});
