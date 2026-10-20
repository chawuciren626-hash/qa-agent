import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { browserTaskCommand } from '../../scripts/browser-task.mjs';
import { readProcessIdentity, compareProcessIdentity, processAbsent } from '../../scripts/process-identity.mjs';

const pause=ms=>new Promise(done=>setTimeout(done,ms));
const root=resolve(import.meta.dirname,'../..');

function fixture(url) {
  const runId=`run-${randomUUID()}`,dir=resolve(root,'output/runs',runId);
  mkdirSync(resolve(dir,'execution'),{recursive:true});mkdirSync(resolve(dir,'inputs'));
  writeFileSync(resolve(dir,'inputs/request.txt'),`Test synthetic page ${url}`);
  writeFileSync(resolve(dir,'manifest.json'),JSON.stringify({run_id:runId,
    orchestration:{plan:{workflow_mode:'task'},events:[{type:'dispatched',stage:'execution',dispatch_id:randomUUID()}]},
    stages:{execution:{status:'in_progress'}}}));
  return {dir,call:operation=>browserTaskCommand(root,runId,operation)};
}

test('killing one owned worker releases its browser descendants without affecting another run',async t=>{
  if(process.platform!=='win32') {t.skip('Windows process-tree regression');return;}
  const previous=process.env.QA_TASK_COMMAND_ID;process.env.QA_TASK_COMMAND_ID=randomUUID();
  const server=createServer((req,res)=>res.end('<html><body><h1>Owned worker fixture</h1></body></html>'));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}/`,a=fixture(url),b=fixture(url);
  let connection,children=[];
  t.after(async()=>{
    for(const f of [a,b]) await f.call({type:'finish',request_id:'cleanup',summary:'Synthetic cleanup',limitations:[]}).catch(()=>{});
    // Cleanup is restricted to process identities captured from this fixture's tree.
    for(const identity of children) if(compareProcessIdentity(identity,readProcessIdentity(identity.pid))==='same') process.kill(identity.pid,'SIGKILL');
    await pause(1500);server.closeAllConnections();await new Promise(done=>server.close(done));
    if(previous===undefined) delete process.env.QA_TASK_COMMAND_ID;else process.env.QA_TASK_COMMAND_ID=previous;
  });
  for(const f of [a,b]) assert.equal((await f.call({type:'start',request_id:'start',url,source_path:'inputs/request.txt',scope:'Synthetic local test',headless:true})).status,'ready');
  await a.call({type:'assert',request_id:'observation',target:{by:'role',value:'heading',name:'Owned worker fixture'},condition:'visible',case_id:'ONE',title:'Heading visible',expected:'Fixture heading visible'});
  const progressBefore=readFileSync(resolve(a.dir,'execution/browser-progress.json'));
  const progress=JSON.parse(progressBefore);
  assert.equal(progress.summary.total,1);assert.equal(progress.summary.passed,1);
  assert.equal(progress.status,'partial');assert.equal(progress.finished_at,null);
  connection=JSON.parse(readFileSync(resolve(a.dir,'execution/browser-private.json')));
  assert.equal(compareProcessIdentity(connection.process_identity,readProcessIdentity(connection.pid)),'same');
  const snapshot=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(snapshot.status,0);
  const rows=JSON.parse(snapshot.stdout),owned=new Map([[connection.pid,connection.process_identity]]);let changed=true;
  while(changed) {
    changed=false;
    for(const row of rows) if(owned.has(row.ParentProcessId) && !owned.has(row.ProcessId)) {
      const identity=readProcessIdentity(row.ProcessId),parent=owned.get(row.ParentProcessId);
      // A historic parent PID link cannot establish ownership of an older process.
      if(identity && BigInt(identity.process_start)>=BigInt(parent.process_start)) {owned.set(row.ProcessId,identity);changed=true;}
    }
  }
  owned.delete(connection.pid);children=[...owned.values()];assert.ok(children.length>0,'Fixture must own actual browser descendants');
  const before=readFileSync(resolve(a.dir,'execution/browser-evidence/observation.json'));
  assert.equal(compareProcessIdentity(connection.process_identity,readProcessIdentity(connection.pid)),'same');
  process.kill(connection.pid,'SIGKILL');
  const until=Date.now()+15000;
  while(Date.now()<until && children.some(identity=>!processAbsent(identity.pid))) await pause(100);
  assert.ok(children.every(identity=>processAbsent(identity.pid)),'Owned browser must exit on its worker pipe closure');
  const health=await a.call({type:'health',request_id:'after-exit'});
  assert.equal(health.status,'worker_unreachable');assert.equal(health.owner_confirmed_exited,true);
  assert.deepEqual(readFileSync(resolve(a.dir,'execution/browser-evidence/observation.json')),before);
  assert.deepEqual(readFileSync(resolve(a.dir,'execution/browser-progress.json')),progressBefore);
  assert.equal(existsSync(resolve(a.dir,'execution/test_results.json')),false,'No fabricated finish after worker death');
  assert.equal((await b.call({type:'health',request_id:'other-run'})).status,'worker_health');
  assert.equal((await b.call({type:'finish',request_id:'finish',summary:'Other run unaffected',limitations:[]})).status,'closed');
});
