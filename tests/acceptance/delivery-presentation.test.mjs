import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { deliveryPresentation } from '../../scripts/delivery-presentation.mjs';
import { localDeliveryPath,extractDeliveries,groupDeliveryItems,normalizeDeliveryItems } from '../../penguin/ui/delivery-ui.mjs';
import { openDeliverable,validateNativeDocument } from '../../scripts/open-deliverable.mjs';
import { patchDeliveryBundle,patchDeliveryServer } from '../../scripts/install-penguin-delivery-ui.mjs';
const root=resolve(import.meta.dirname,'../..');

test('placeholder thinking merges split prose without mutating source events, including streaming replay',()=>{
  const before={kind:'assistant_text',id:'a',text:'读取'};
  for(const thinking of ['', ' ', '.', '...', '…', '。']) {
    const items=[before,{kind:'thinking',id:'b',thinking,streaming:false},{kind:'assistant_text',id:'c',text:'编排事件脚本。',streaming:true}];
    const snapshot=JSON.stringify(items),result=normalizeDeliveryItems(items);
    assert.equal(result.length,1);assert.equal(result[0].text,'读取编排事件脚本。');assert.equal(result[0].id,'a');assert.equal(result[0].streaming,true);
    assert.equal(JSON.stringify(items),snapshot);
    assert.deepEqual(normalizeDeliveryItems(JSON.parse(snapshot)),result);
  }
  const streaming=[before,{kind:'thinking',id:'b',thinking:'.',streaming:true}];
  assert.equal(normalizeDeliveryItems(streaming).length,1);
  streaming[1]={...streaming[1],thinking:'实际推理内容'};
  assert.equal(normalizeDeliveryItems(streaming).length,2);
});
test('normalization never merges across real reasoning, tools, errors or turn identity',()=>{
  const a={kind:'assistant_text',id:'a',text:'第一句'},b={kind:'assistant_text',id:'b',text:'第二句'};
  for(const boundary of [{kind:'thinking',thinking:'真实推理'},{kind:'thinking',thinking:'.',stopReason:'fatal'},...['tool_call','subagent','user_text','user_image','user_steering','task_stats','abort','llm_error','reconnect'].map(kind=>({kind}))]) {
    const items=[a,{kind:'thinking',thinking:'.'},boundary,b];
    assert.equal(normalizeDeliveryItems(items).filter(item=>item.kind==='assistant_text').length,2);
  }
  for(const key of ['requestId','sessionId','turnId']) assert.equal(normalizeDeliveryItems([{...a,[key]:'1'},{kind:'thinking',thinking:'.'},{...b,[key]:'2'}]).length,2);
  assert.equal(normalizeDeliveryItems([a,b]).length,2);
  assert.equal(normalizeDeliveryItems([{...a,stopReason:'aborted'},{kind:'thinking',thinking:'.'},b]).length,2);
});

test('file references support Chinese/spaces and reject external protocols, escapes and alternate streams',()=>{
  const workspace='E:/QAWorkspaces/测试 项目';
  assert.equal(localDeliveryPath('output/报告%20一.xlsx',workspace),'output/报告 一.xlsx');
  assert.equal(localDeliveryPath('e:\\QAWorkspaces\\测试 项目\\output\\报告.xlsx',workspace),'output/报告.xlsx');
  for(const value of ['../secret.xlsx','output/%2e%2e/secret.xlsx','file:///C:/secret.xlsx','https://example.org/a.xlsx','javascript:alert(1)','//host/share/a.xlsx','E:/other/a.xlsx','output/a.xlsx:evil','/api/me','output/a.xlsx?token=secret','%zz']) assert.equal(localDeliveryPath(value,workspace),null,value);
  const files=extractDeliveries('[用例](<output/测试 用例.xlsx>) · [测试点](output/points.xmind) · `output/测试 用例.xlsx` · [外部](https://example.org/a.pdf)',workspace);
  assert.deepEqual(files.map(x=>x.path),['output/测试 用例.xlsx','output/points.xmind']);
});

test('folding preserves final replies, human questions, errors and turn boundaries without changing trace items',()=>{
  const items=[{kind:'user_text',id:'1'},{kind:'assistant_text',id:'2',text:'Dispatch bookkeeping'},{kind:'tool_call',id:'3'},{kind:'assistant_text',id:'4',text:'Validation bookkeeping'},{kind:'tool_call',id:'5'},{kind:'assistant_text',id:'6',text:'Please enter CAPTCHA'},{kind:'task_stats',id:'7'},{kind:'user_text',id:'8'},{kind:'thinking',id:'9'},{kind:'tool_call',id:'10'},{kind:'llm_error',id:'11'},{kind:'assistant_text',id:'12',text:'Partial result'}];
  const before=JSON.stringify(items),segments=groupDeliveryItems(items);
  assert.deepEqual(segments.filter(s=>s.type==='group').map(s=>s.items.map(x=>x.id)),[['2','3','4','5'],['9','10']]);
  assert.ok(segments.some(s=>s.type==='single' && s.item.id==='6'));
  assert.ok(segments.some(s=>s.type==='single' && s.item.id==='11'));
  assert.equal(JSON.stringify(items),before);
  assert.equal(groupDeliveryItems([{kind:'assistant_text',id:'stream',streaming:true},{kind:'tool_call',id:'tool'}])[0].type,'single');
});

test('presentation publishes existing deliverables only from delivered stages, not technical artifacts',()=>{
  const run=`run-${randomUUID()}`,dir=resolve(root,'output/runs',run);
  mkdirSync(resolve(dir,'report'),{recursive:true});mkdirSync(resolve(dir,'design'));
  writeFileSync(resolve(dir,'report/test_report.html'),'<html>Report</html>');
  writeFileSync(resolve(dir,'report/test_report.pdf'),'');
  writeFileSync(resolve(dir,'design/test_cases.xlsx'),'fixture');
  const sha=path=>createHash('sha256').update(readFileSync(resolve(dir,path))).digest('hex');
  const contract=(stage,paths)=>({type:'completed',stage,evidence:{artifact_contract:{version:1,run_id:run,stage,status:'passed',files:paths.map(path=>({path,sha256:sha(path)}))}}});
  const p=deliveryPresentation(root,run,{stages:{report:{status:'completed'},test_cases:{status:'in_progress'}},orchestration:{events:[contract('report',['report/test_report.html'])]}});
  assert.equal(p.artifacts.length,1);assert.match(p.markdown,/\[测试报告\]\(<output\/runs\//);
  assert.ok(!p.markdown.includes('E:'));assert.ok(!p.markdown.includes('xlsx'));
  const pending=deliveryPresentation(root,run,{stages:{test_cases:{status:'awaiting_confirmation'}},orchestration:{events:[contract('test_cases',['design/test_cases.xlsx'])]}});
  assert.equal(pending.artifacts.length,1);
  writeFileSync(resolve(dir,'design/test_cases.xlsx'),'changed after completion');
  assert.equal(deliveryPresentation(root,run,{stages:{test_cases:{status:'completed'}},orchestration:{events:[contract('test_cases',['design/test_cases.xlsx'])]}}).artifacts.length,1,'fresh contract follows current bytes in fixture');
});

test('presentation derives counts from verified canonical artifacts and never advertises changed files',()=>{
  const run=`run-${randomUUID()}`,dir=resolve(root,'output/runs',run);mkdirSync(resolve(dir,'design'),{recursive:true});
  writeFileSync(resolve(dir,'design/test_cases.json'),JSON.stringify({cases:Array.from({length:15},(_,i)=>({case_id:`TC-${i+1}`}))}));
  writeFileSync(resolve(dir,'design/test_cases.xlsx'),'verified workbook');
  const files=['design/test_cases.json','design/test_cases.xlsx'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(resolve(dir,path))).digest('hex')}));
  const manifest={stages:{test_cases:{status:'completed'}},orchestration:{events:[{type:'completed',stage:'test_cases',evidence:{artifact_contract:{version:1,run_id:run,stage:'test_cases',status:'passed',files}}}]}};
  const p=deliveryPresentation(root,run,manifest);
  assert.equal(p.facts.test_cases,15);assert.equal(p.concise_summary,'测试用例 15 条');assert.equal(p.artifacts.length,1);
  assert.equal(p.reply_template,`已整理：测试用例 15 条。\n\n${p.markdown}`);
  assert.ok(!p.reply_template.includes('.json'));assert.ok(!p.reply_template.includes('completed'));
  writeFileSync(resolve(dir,'design/test_cases.xlsx'),'mutated workbook');
  const changed=deliveryPresentation(root,run,manifest);
  assert.equal(changed.artifacts.length,0);assert.equal(changed.facts.test_cases,15);assert.equal(changed.markdown,'');
  assert.ok(!changed.reply_template.includes('.xlsx'));
});

test('delivery separates verified questions from limitations and retains saved confirmation stages',()=>{
  const run=`run-${randomUUID()}`,dir=resolve(root,'output/runs',run),path='report/report-task.json';
  mkdirSync(resolve(dir,'report'),{recursive:true});
  const task={run_id:run,stage:'report',summary:'Imported results only; no product execution.',questions:[],limitations:['No real product execution evidence.']};
  const save=()=>writeFileSync(resolve(dir,path),JSON.stringify(task));save();
  const manifest=()=>({stages:{report:{status:'completed'}},orchestration:{events:[{type:'completed',stage:'report',evidence:{artifact_contract:{run_id:run,stage:'report',status:'passed',files:[{path,sha256:createHash('sha256').update(readFileSync(resolve(dir,path))).digest('hex')}]}}}]}});
  let m=manifest(),p=deliveryPresentation(root,run,m);
  assert.equal(p.reply_template,task.summary);assert.equal(p.question_status,'none_recorded');
  assert.deepEqual(p.pending_questions,[]);assert.deepEqual(p.limitations,task.limitations);assert.ok(!p.reply_template.includes('待确认'));
  m.stages.report.status='awaiting_confirmation';assert.deepEqual(deliveryPresentation(root,run,m).confirmation_stages,['report']);
  task.questions=['Which scope applies?'];save();
  assert.equal(deliveryPresentation(root,run,m).question_status,'unknown','modified files cannot clear or invent questions');
  p=deliveryPresentation(root,run,manifest());assert.deepEqual(p.pending_questions,task.questions);assert.match(p.reply_template,/Which scope applies/);
});

test('native document opening is argument-safe, rejects executable content and propagates launcher errors',async()=>{
  const dir=resolve(root,'output/acceptance',randomUUID());mkdirSync(dir,{recursive:true});
  const path=resolve(dir,"测试 ' $ 文档.xlsx");writeFileSync(path,Buffer.from([0x50,0x4b,0x03,0x04,0]));
  let invocation;
  await openDeliverable(path,{platform:'win32',run:(command,args,options)=>{invocation={command,args,options};const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;}});
  assert.equal(invocation.options.env.QA_DELIVERY_OPEN_PATH,path);assert.equal(invocation.options.shell,false);
  assert.ok(!invocation.args.join(' ').includes(path));
  const invalid=resolve(dir,'bad.xlsx');writeFileSync(invalid,'MZfake executable');assert.throws(()=>validateNativeDocument(invalid),/header/);
  const executable=resolve(dir,'bad.exe');writeFileSync(executable,'MZfake executable');assert.throws(()=>validateNativeDocument(executable),/Unsupported/);
  await assert.rejects(openDeliverable(path,{run:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',1));return child;}}),/could not be opened/);
});

test('native launcher timeout is bounded, kills only the launcher and never retries',async()=>{
  const dir=resolve(root,'output/acceptance',randomUUID());mkdirSync(dir,{recursive:true});
  const path=resolve(dir,'timeout.docx');writeFileSync(path,Buffer.from([0x50,0x4b,0x03,0x04,0]));
  let calls=0,kills=0,unrefs=0;
  const child=new EventEmitter();child.kill=()=>{kills++;};child.unref=()=>{unrefs++;};
  await assert.rejects(openDeliverable(path,{timeoutMs:10,run:()=>{calls++;return child;}}),error=>error.code==='QA_DOCUMENT_OPEN_TIMEOUT');
  assert.equal(calls,1);assert.equal(kills,1);assert.equal(unrefs,1);
  child.emit('error',new Error('late launcher error'));child.emit('exit',0);
  await assert.rejects(openDeliverable(path,{timeoutMs:0,run:()=>{throw Error('must not run');}}),/Invalid/);
  let successfulKills=0;
  await openDeliverable(path,{timeoutMs:10,run:()=>{const good=new EventEmitter();good.kill=()=>successfulKills++;queueMicrotask(()=>good.emit('exit',0));return good;}});
  await new Promise(done=>setTimeout(done,25));assert.equal(successfulKills,0);
});

test('runtime patch fails closed for unknown builds; native endpoint requires desktop session and bounded workspace resolution',()=>{
  assert.throws(()=>patchDeliveryBundle('different build'),/anchor/);
  const server=patchDeliveryServer('  app.post("/:sessionId/files/reveal", async (c7) => {','file:///engine/open-deliverable.mjs');
  assert.match(server,/sessionVia !== "desktop"/);assert.match(server,/resolveSession\(c7\)/);
  assert.match(server,/workspaceFiles.resolvePath\(row.workspace, rel\)/);assert.match(server,/output/);
  assert.throws(()=>patchDeliveryServer(server,'file:///x'),/already present/);
});

test('native route enforces desktop authentication and file scope before calling the OS launcher',async()=>{
  const handlers=new Map(),opened=[],resolved=[];
  let timeout=false;
  const source=patchDeliveryServer('  app.post("/:sessionId/files/reveal", async (c7) => {});','file:///unused');
  class HttpError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
  const deps={desktopMode:true,workspaceFiles:{resolvePath:async(workspace,path)=>{resolved.push(path);return `${workspace}/${path}`;}}};
  new Function('app','resolveSession','deps','HttpError','qaOpenDeliverable',source.slice(source.indexOf('\n')+1))(
    {get:(path,handler)=>handlers.set(path,handler),post:(path,handler)=>handlers.set(path,handler)},()=>({workspace:'workspace'}),deps,HttpError,async path=>{if(timeout)throw Object.assign(new Error('timeout'),{code:'QA_DOCUMENT_OPEN_TIMEOUT'});opened.push(path);});
  const handler=handlers.get('/:sessionId/files/open-deliverable');
  const context=(path,sessionVia='desktop')=>({var:{sessionVia},req:{query:()=>path},body:(_,status)=>status});
  const valid='output/runs/run-123/report/测试 用例.xlsx';
  await assert.rejects(handler(context(valid,'cookie')),e=>e.status===403);
  for(const path of ['../secret.xlsx','output/runs/run-123/report/../../secret.xlsx','output/runs/run-123/report/evil.exe','inputs/foreign.xlsx']) await assert.rejects(handler(context(path)),e=>e.status===400);
  assert.equal(resolved.length,0);assert.equal(opened.length,0);
  assert.equal(await handler(context(valid)),204);assert.equal(opened.length,1);
  timeout=true;
  await assert.rejects(handler(context(valid)),e=>e.status===504 && e.code==='document_open_timeout');
});

test('evidence route resolves authenticated session before read and returns inert downloads',async()=>{
  const handlers=new Map();let allowed=false,reads=0;
  const source=patchDeliveryServer('  app.post("/:sessionId/files/reveal", async (c7) => {});','file:///unused');
  class HttpError extends Error {constructor(status,code,message){super(message);this.status=status;}}
  new Function('app','resolveSession','deps','HttpError','qaOpenDeliverable','qaReadDeliveryEvidence',source.slice(source.indexOf('\n')+1))(
    {get:(path,handler)=>handlers.set(path,handler),post:(path,handler)=>handlers.set(path,handler)},
    ()=>{if(!allowed)throw new HttpError(403,'denied','denied');return {workspace:'current-workspace'};},{},HttpError,()=>assert.fail('must not launch'),
    (workspace,path)=>{reads++;assert.equal(workspace,'current-workspace');return {kind:'json',path,text:'{"safe":true}'};});
  const handler=handlers.get('/:sessionId/files/evidence'),context=download=>({req:{query:key=>key==='path'?'output/runs/run-a/execution/test_results.json':download},json:value=>value,header:()=>{}});
  await assert.rejects(handler(context()),e=>e.status===403);assert.equal(reads,0);
  allowed=true;assert.equal((await handler(context())).kind,'json');
  const response=await handler(context('1'));
  assert.match(response.headers.get('content-disposition'),/^attachment/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('content-security-policy'),'sandbox');assert.equal(await response.text(),'{"safe":true}');
});
