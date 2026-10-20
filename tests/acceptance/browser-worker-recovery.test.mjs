import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserTaskCommand } from '../../scripts/browser-task.mjs';

test('disconnected worker is not restarted and an unacknowledged operation survives a new command identity',async t=>{
  const root=resolve(import.meta.dirname,'../..'),runId=`run-${randomUUID()}`,dir=resolve(root,'output/runs',runId);
  mkdirSync(resolve(dir,'execution'),{recursive:true});
  writeFileSync(resolve(dir,'manifest.json'),JSON.stringify({run_id:runId,
    orchestration:{plan:{workflow_mode:'task'},events:[{type:'dispatched',stage:'execution',dispatch_id:randomUUID()}]},
    stages:{execution:{status:'in_progress'}}}));
  const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const port=server.address().port;await new Promise(done=>server.close(done));
  const privatePath=resolve(dir,'execution/browser-private.json');
  const privateBytes=JSON.stringify({port,token:'synthetic-unreachable'});writeFileSync(privatePath,privateBytes);
  const previous=process.env.QA_TASK_COMMAND_ID;process.env.QA_TASK_COMMAND_ID=randomUUID();
  t.after(()=>{if(previous===undefined) delete process.env.QA_TASK_COMMAND_ID;else process.env.QA_TASK_COMMAND_ID=previous;});
  const call=operation=>browserTaskCommand(root,runId,operation);
  assert.equal((await call({type:'health',request_id:'health'})).status,'worker_unreachable');
  assert.equal((await call({type:'fill',request_id:'first',target:{by:'css',value:'#synthetic'},value:'not-sent'})).status,'transport_uncertain');
  process.env.QA_TASK_COMMAND_ID=randomUUID();
  const fenced=await call({type:'fill',request_id:'second',target:{by:'css',value:'#synthetic'},value:'not-sent'});
  assert.equal(fenced.status,'transport_uncertain');assert.equal(fenced.request_id,'first');assert.equal(fenced.operation_started,false);
  assert.equal(readFileSync(privatePath,'utf8'),privateBytes);
  assert.equal(existsSync(resolve(dir,'execution/browser-state.json')),false);
  const pending=readFileSync(resolve(dir,'execution/browser-pending-operation.json'),'utf8');
  assert.doesNotMatch(pending,/not-sent|#synthetic/);
});
