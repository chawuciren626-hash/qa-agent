import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connect,createServer} from 'node:net';
import {ensureLocalService,attachLocalService,pauseLocalService,resumeLocalService,serviceStatus,servicePaths,readFrames,serverLockAlive,managedAgentShell} from '../../scripts/local-service.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const write=(file,value)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,value);};
test('managed service selects a Windows shell accepted by the ACL sandbox',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'aith-shell-'));
  try {
    const layout={paths:{host_executable:resolve(root,'runtime/penguin/PenguinHarness.exe')}};
    const shell=resolve(root,'runtime/penguin/resources/git/usr/bin/sh.exe');
    write(shell,'synthetic shell');
    assert.match(managedAgentShell(layout),/powershell\.exe$/i);
    rmSync(shell);
    assert.match(managedAgentShell(layout),/powershell\.exe$/i);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('server lock rejects a recycled PID with a closed port and respects a live listener',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'aith-lock-')),file=resolve(root,'server.lock');
  const server=createServer(socket=>socket.end());
  try {
    assert.equal(await serverLockAlive(file),false);
    await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
    write(file,JSON.stringify({pid:process.pid,port:server.address().port}));
    assert.equal(await serverLockAlive(file),true);
    await new Promise(ok=>server.close(ok));
    assert.equal(await serverLockAlive(file),false);
    write(file,'invalid json');assert.equal(await serverLockAlive(file),false);
  } finally { if(server.listening)await new Promise(ok=>server.close(ok));rmSync(root,{recursive:true,force:true}); }
});
test('independent runtime: one server, private relay, UI detach survival, busy protection, restart and pause', {timeout:120000}, async t=>{
  const root=mkdtempSync(resolve(tmpdir(),'aith-service-'));
  const config=resolve(root,'installation.json');
  write(config,JSON.stringify({version:1,installation_id:'service-test',layout:'unified',root:'.',project_id:'default_project',paths:{engine:'app/engine',host_executable:'runtime/penguin/PenguinHarness.exe',host_data:'data/host',qa_data:'data/qa',desktop_profile:'data/profile',workspaces:'workspaces',node:'runtime/node/node.exe'}}));
  const p=servicePaths(config);
  mkdirSync(dirname(p.layout.paths.node),{recursive:true});copyFileSync(process.execPath,p.layout.paths.node);
  const entry=resolve(import.meta.dirname,'../../scripts/local-service.mjs');
  write(resolve(p.layout.paths.engine,'scripts/local-service.mjs'),`process.argv[1]=${JSON.stringify(entry)}; await import(${JSON.stringify(pathToFileURL(entry).href)});`);
  write(resolve(p.layout.host_app,'package.json'),'{}');
  write(resolve(p.layout.host_app,'dist/server.js'),`
    const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
    const root=process.env.PENGUIN_HOME;fs.mkdirSync(root,{recursive:true});
    const server=http.createServer((req,res)=>res.end('synthetic-local-data'));
    server.listen(Number(process.env.PORT),'127.0.0.1',()=>{
      fs.writeFileSync(path.join(root,'server.lock'),JSON.stringify({pid:process.pid,port:server.address().port}));
      fs.writeFileSync(process.env.PENGUIN_PORT_FILE,String(server.address().port));
    });
    process.on('message',m=>{
      if(m.type==='aitest-shell-frame')process.send(m);
      if(m.type!=='aitest-service-request')return;
      if(m.method==='shutdown'){server.close(()=>process.exit(0));return;}
      const error=m.method==='prepare-stop'&&fs.existsSync(path.join(root,'busy'))?'synthetic task still running':undefined;
      process.send({type:'aitest-service-response',id:m.id,result:m.method==='claim'?'synthetic-claim':true,error});
    });
  `);
  let shell;
  t.after(async()=>{
    shell?.close();
    rmSync(resolve(p.layout.paths.host_data,'busy'),{force:true});
    await sleep(100);
    await pauseLocalService(config);
    rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const statuses=await Promise.all([ensureLocalService(config),ensureLocalService(config),ensureLocalService(config)]);
  assert.equal(new Set(statuses.map(s=>s.serverPid)).size,1);
  const initial=statuses[0];
  const bad=connect(p.pipe);bad.on('error',()=>{});
  const refusal=new Promise(ok=>readFrames(bad,m=>ok(m)));
  bad.write(JSON.stringify({id:'1',method:'authenticate',secret:'wrong'})+'\n');
  assert.match((await refusal).error,/credential/);bad.destroy();
  shell=await attachLocalService(config);
  assert.equal(shell.token,'synthetic-claim');
  await assert.rejects(pauseLocalService(config),/桌面/);
  const frame=new Promise(ok=>shell.once('message',ok));shell.postMessage({type:'desktop-tray-status'});
  assert.deepEqual(await frame,{type:'desktop-tray-status'});
  shell.close();shell=null;await sleep(100);
  assert.equal((await serviceStatus(config)).serverPid,initial.serverPid);
  assert.equal(await (await fetch(`http://127.0.0.1:${initial.port}`)).text(),'synthetic-local-data');
  write(resolve(p.layout.paths.host_data,'busy'),'synthetic task');
  await assert.rejects(pauseLocalService(config),/task still running/);
  assert.equal((await serviceStatus(config)).ready,true);
  assert.equal(existsSync(p.pause),false);
  rmSync(resolve(p.layout.paths.host_data,'busy'));
  // Only this test's synthetic backend is deliberately crashed to exercise recovery.
  process.kill(initial.serverPid);
  let recovered;
  for(let i=0;i<120;i++){await sleep(250);recovered=await serviceStatus(config);if(recovered?.ready&&recovered.serverPid!==initial.serverPid)break;}
  assert.equal(recovered.ready,true);assert.notEqual(recovered.serverPid,initial.serverPid);assert.equal(recovered.port,initial.port);
  assert.equal(await pauseLocalService(config),true);
  await assert.rejects(ensureLocalService(config),/暂停维护/);
  assert.equal((await resumeLocalService(config)).port,initial.port);
});
