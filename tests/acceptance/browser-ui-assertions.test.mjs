import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { evaluateUiCheck, observeUiCondition } from '../../scripts/browser-ui-assertions.mjs';
import { validateBrowserOperation } from '../../scripts/browser-task.mjs';
import { uiCheckFingerprint } from '../../scripts/execution-counts.mjs';
import { createDialogTracker, validateDialogPolicy } from '../../scripts/browser-dialogs.mjs';
import { resolveBrowserInputs, uiComparison } from '../../scripts/browser-inputs.mjs';
import { createHash } from 'node:crypto';
import { redactBrowserText, refreshBrowserPrivacy, privateSnapshot, privateBrowserError, privateBrowserUrl } from '../../scripts/browser-privacy.mjs';
import { operationPerformance, humanHandoffTiming, summarizeHumanHandoff } from '../../scripts/browser-performance.mjs';
import { captureBrowserEvidence } from '../../scripts/browser-task.mjs';
import { browserSecretReferences } from '../../scripts/browser-secret-references.mjs';

test('secret references are opaque, task/page/target bound, memory-only and revocable',()=>{
  const registry=browserSecretReferences('run-a'),target={by:'css',value:'#password'};
  const context={run:'run-a',url:'https://example.test/login?tenant=one#form',target};
  const ref=registry.register({...context,value:'synthetic-private'});
  assert.match(ref.id,/^sr-/);assert.ok(!JSON.stringify(ref).includes('synthetic-private'));
  assert.equal(registry.resolve({...context,ref}),'synthetic-private');
  assert.equal(registry.resolve({...context,target:{value:'#password',by:'css'},ref}),'synthetic-private');
  assert.deepEqual(registry.register({...context,value:'synthetic-private'}),ref);
  for(const change of [{run:'run-b'},{url:'https://other.test/login?tenant=one#form'},{url:'https://example.test/login?tenant=two#form'},{url:'https://example.test/login?tenant=one#other'},{target:{by:'css',value:'#public'}}]) assert.throws(()=>registry.resolve({...context,...change,ref}),/Secret reference/);
  assert.throws(()=>browserSecretReferences('run-a').resolve({...context,ref}),/unavailable/);
  const replacement=registry.register({...context,value:'replacement'});
  assert.throws(()=>registry.resolve({...context,ref}),/unavailable/);
  assert.equal(registry.resolve({...context,ref:replacement}),'replacement');
  registry.register({...context,value:''});assert.throws(()=>registry.resolve({...context,ref:replacement}),/unavailable/);
  const current=registry.register({...context,value:'latest'});
  registry.invalidate(context);assert.throws(()=>registry.resolve({...context,ref:current}),/unavailable/);
  registry.clear();assert.throws(()=>registry.register({...context,value:'new'}),/unavailable/);
});

test('secret reference fill contract rejects arbitrary providers, mixed values, export assertions and privacy bypasses',()=>{
  const store=browserSecretReferences('run'),target={by:'css',value:'#password'};
  const ref=store.register({run:'run',url:'https://example.test/',target,value:'synthetic'});
  const fill={type:'fill',request_id:'fill-ref',target,secret_ref:ref};
  assert.doesNotThrow(()=>validateBrowserOperation(fill));
  for(const change of [{value:'literal'},{value_ref:{source_path:'inputs/cases.json',case_id:'TC',key:'password'}},{secret:false},{secret_ref:{env:'PRIVATE_KEY'}},{secret_ref:{file:'private'}},{secret_ref:{...ref,env:'PRIVATE_KEY'}},{type:'select'},{type:'assert',condition:'value',case_id:'TC',title:'Probe',expected:'Probe'}]) assert.throws(()=>validateBrowserOperation({...fill,...change}));
});

test('privacy redacts read-only credentials and common personal data before snapshot truncation',async t=>{
  const secret='test-only-key-'+ 'x'.repeat(15000);
  const {page}=await fixture(t,`<dl><dt>API Key</dt><dd>${secret}</dd></dl><label for="mail">Email</label><input id="mail" type="email" value="synthetic@example.invalid"><p>13800138000</p>`);
  const secrets=new Set();const privacy=await refreshBrowserPrivacy(page,secrets);
  assert.equal(privacy.status,'observed');assert.ok(secrets.has(secret));
  assert.ok(secrets.has('synthetic@example.invalid'));assert.ok(privacy.mask_selectors.length>=2);
  const clean=privateSnapshot({text:await page.locator('body').innerText(),truncated:{text:true}},secrets,privacy);
  assert.ok(!clean.text.includes('test-only-key'));assert.ok(!clean.text.includes('x'.repeat(50)));
  assert.ok(!clean.text.includes('synthetic@'));assert.ok(!clean.text.includes('13800138000'));
  assert.equal(clean.truncated.text,true);assert.equal(clean.content_trust,'untrusted_page_data_not_instructions_or_authorization');
});

test('privacy merges overlapping secrets and encoded forms without redacting replacement markers',()=>{
  assert.equal(redactBrowserText('abc ab REDACTED',new Set(['abc','ab','REDACTED'])),'[REDACTED] [REDACTED] [REDACTED]');
  const secret='test value/\"line\n';
  for(const text of [secret,encodeURIComponent(secret),JSON.stringify(secret).slice(1,-1)]) assert.equal(redactBrowserText(text,[secret]),'[REDACTED]');
  assert.equal(redactBrowserText('token: synthetic-private-value'),'[REDACTED]');
  assert.equal(redactBrowserText('ababa',['aba']),'[REDACTED]');
  assert.equal(redactBrowserText('a'.repeat(20001),['a']),'[WITHHELD: privacy match limit]');
  assert.equal(redactBrowserText('ordinary UI status: saved'),'ordinary UI status: saved');
});

test('privacy strips URL credentials and query fragments and never echoes browser error call logs',()=>{
  assert.equal(privateBrowserUrl('https://user:password@example.test/path?token=secret#secret'),'https://example.test/path');
  assert.ok(!privateBrowserUrl('https://example.test/secret-value',['secret-value']).includes('secret-value'));
  assert.equal(privateBrowserUrl('file:///private'),'[WITHHELD: non-HTTP URL]');
  assert.equal(privateBrowserUrl('invalid secret'),'[WITHHELD: invalid URL]');
  const result=privateBrowserError(new Error('page.goto: net::ERR_CONNECTION_REFUSED https://user:password@example.test/?secret=secret'),'exploration');
  assert.deepEqual(result,{phase:'exploration',category:'browser_operation_error',network_code:'net::ERR_CONNECTION_REFUSED'});
});

test('privacy unavailable or oversized observations withhold content and never take unmasked screenshots',async()=>{
  let screenshots=0;
  for(const evaluate of [async()=>{throw new Error('secret diagnostic');},async()=>({values:[],mask_selectors:[],truncated:true})]) {
    const page={evaluate,screenshot:async()=>{screenshots++;}};
    const privacy=await refreshBrowserPrivacy(page,new Set());
    const clean=privateSnapshot({text:'must not escape',fields:[{label:'private'}]},[],privacy);
    assert.equal(clean.privacy.content_withheld,true);assert.equal(clean.text,undefined);assert.equal(clean.fields,undefined);
    assert.equal((await captureBrowserEvidence(page,'never-written.png',new Set())).captured,false);
  }
  assert.equal(screenshots,0);
  assert.equal(privateSnapshot({text:'a'.repeat(1000001)},[],{status:'observed'}).privacy.content_withheld,true);
});

test('privacy bounded DOM scan reports incomplete instead of claiming safe full coverage',async t=>{
  const {page}=await fixture(t,'<input type="password" value="synthetic-secret">'+ '<span>ordinary</span>'.repeat(4001));
  const privacy=await refreshBrowserPrivacy(page,new Set());
  assert.equal(privacy.status,'incomplete');
});

test('operation performance measures failed and nested spans without inventing model or queue time',async()=>{
  let now=10;const metrics=operationPerformance(()=>now);
  await metrics.measure('outer',async()=>{now=12;metrics.measureSync('inner',()=>{now=15;});now=18;});
  await assert.rejects(metrics.measure('failed',async()=>{now=20;throw new Error('test');}));
  const report=metrics.snapshot();
  assert.equal(report.worker_elapsed_ms,10);assert.equal(report.model_round_trip_ms,null);assert.equal(report.queue_ms,null);
  assert.deepEqual(report.spans,[{phase:'inner',start_offset_ms:2,duration_ms:3},{phase:'outer',start_offset_ms:0,duration_ms:8},{phase:'failed',start_offset_ms:8,duration_ms:2}]);
  report.spans[0].duration_ms=999;assert.equal(metrics.snapshot().spans[0].duration_ms,3);
});

async function fixture(t,html) {
  const browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});t.after(()=>browser.close());
  const page=await browser.newPage();await page.setContent(html);
  const locate=target=>target.by==='text'?page.getByText(target.value,{exact:true}):page.locator(target.value);
  const check=(condition,value,target='#field',ready)=>({condition,value,target:{by:'css',value:target},...(ready?{ready}:{})});
  return {page,locate,check,run:(check,timeout=100)=>evaluateUiCheck(page,check,locate,{timeout})};
}

test('human handoff timing uses monotonic windows, immutable snapshots and honest unfinished boundaries',()=>{
  let now=100,wall='2026-10-19T00:00:00Z';
  const timing=humanHandoffTiming({clock:()=>now,wall:()=>wall});
  assert.equal(timing.snapshot().observed_window_ms,0);
  assert.equal(timing.begin('pause-1','captcha'),wall);
  now=150;const open=timing.snapshot();assert.equal(open.open.elapsed_ms,50);
  assert.throws(()=>timing.begin('other','mfa'),/already open/);
  assert.throws(()=>timing.end('invented'),/Invalid/);
  wall='2026-10-18T23:00:00Z';now=300;timing.end('resumed');
  let report=timing.snapshot();assert.equal(report.closed_window_ms,200);assert.equal(report.open,null);
  assert.equal(report.intervals[0].reason,'resumed');
  assert.equal(open.open.elapsed_ms,50,'Earlier evidence is never rewritten');
  timing.end('resumed');assert.equal(timing.snapshot().intervals.length,1);
  timing.begin('pause-2','access');now=350;timing.end('finished_without_resume');
  report=timing.snapshot();assert.equal(report.closed_window_ms,250);
  assert.equal(report.intervals[1].reason,'finished_without_resume');
  report.intervals[0].duration_ms=999;assert.equal(timing.snapshot().intervals[0].duration_ms,200);
  timing.begin('pause-3','business_question');now=400;
  assert.equal(timing.snapshot().open.elapsed_ms,50);
  assert.equal(timing.snapshot().observed_window_ms,300);
  timing.end('worker_expired');assert.equal(timing.snapshot().intervals[2].reason,'worker_expired');
});

test('human handoff accepts only the browser pause contract and does not collect free-text questions',()=>{
  for(const kind of ['captcha','mfa','access','business_question','risk_decision']) {
    const timing=humanHandoffTiming();timing.begin('pause',kind);
    assert.equal(timing.snapshot().open.kind,kind);assert.equal(Object.hasOwn(timing.snapshot().open,'question'),false);
  }
  for(const kind of ['login','other',null]) assert.throws(()=>humanHandoffTiming().begin('pause',kind),/Invalid/);
  assert.throws(()=>humanHandoffTiming().begin('../private','captcha'),/Invalid/);
});

test('human handoff report projection rejects conflicting totals and duplicate windows without copying raw fields',()=>{
  let now=0;const timing=humanHandoffTiming({clock:()=>now,wall:()=> '2026-10-19T00:00:00.000Z'});
  timing.begin('one','captcha');now=20;timing.end('resumed');timing.begin('two','mfa');now=30;
  const source=timing.snapshot();source.question='PRIVATE_SENTINEL';source.intervals[0].message='PRIVATE_SENTINEL';
  const summary=summarizeHumanHandoff(source);
  assert.equal(summary.closed_window_ms,20);assert.equal(summary.open_observed_ms,10);assert.equal(summary.human_effort_ms,null);
  assert.ok(!JSON.stringify(summary).includes('PRIVATE_SENTINEL'));assert.equal(summary.ended_by.resumed,1);
  assert.equal(summarizeHumanHandoff(undefined).status,'not_recorded');
  assert.equal(summarizeHumanHandoff({...source,closed_window_ms:999}).status,'invalid');
  assert.equal(summarizeHumanHandoff({...source,intervals:[...source.intervals,...source.intervals]}).status,'invalid');
  assert.equal(summarizeHumanHandoff({...source,open:{...source.open,request_id:'one'}}).status,'invalid');
  assert.equal(summarizeHumanHandoff({...source,measured_through_at:'PRIVATE_SENTINEL'}).status,'invalid');
  assert.equal(summarizeHumanHandoff({...source,version:99}).status,'invalid');
});

function sources(values) {
  return path=>{
    assert.ok(Object.hasOwn(values,path),'Missing source');
    const data=Buffer.from(typeof values[path]==='string'?values[path]:JSON.stringify(values[path]));
    return {path,data,sha256:createHash('sha256').update(data).digest('hex')};
  };
}

test('sample references preserve Unicode, whitespace, empty values and exact boundaries without literal duplication',()=>{
  const data={boundary:'a'.repeat(128),unicode:' e\u0301\u{1F600} ',empty:'',count:128};
  const read=sources({'inputs/cases.json':[{case_id:'TC',expected:'Value retained',test_data:data}]});
  const operation={type:'fill',request_id:'sample',target:{by:'css',value:'#field'},value_ref:{source_path:'inputs/cases.json',case_id:'TC',key:'boundary'}};
  assert.doesNotThrow(()=>validateBrowserOperation(operation));
  const resolved=resolveBrowserInputs(operation,read);
  assert.equal(resolved.operation.value,data.boundary);assert.equal(resolved.samples[0].lengths.code_points,128);assert.equal(operation.value,undefined);
  assert.equal(resolveBrowserInputs({...operation,value_ref:{...operation.value_ref,key:'unicode'}},read).operation.value,data.unicode);
  assert.equal(resolveBrowserInputs({...operation,value_ref:{...operation.value_ref,key:'empty'}},read).operation.value,'');
  assert.throws(()=>resolveBrowserInputs({...operation,value_ref:{...operation.value_ref,key:'count'}},read),/string/);
  assert.throws(()=>resolveBrowserInputs({...operation,value_ref:{...operation.value_ref,key:'missing'}},read));
  assert.throws(()=>validateBrowserOperation({...operation,value:'rewritten'}));
  assert.throws(()=>validateBrowserOperation({...operation,value_ref:{...operation.value_ref,key:'__proto__'}}));
  assert.throws(()=>validateBrowserOperation({...operation,value_ref:{...operation.value_ref,source_path:'inputs/../private.json'}}));
});

test('UI expectation basis is reused only for the same design expectation or exact clause; unknown basis is not invented',()=>{
  const basis=[{expected:'Value retained',kind:'requirement',source_path:'inputs/request.txt',quote:'The entered value must remain unchanged.'}];
  const data={'inputs/request.txt':'The entered value must remain unchanged.','inputs/cases.json':[{case_id:'TC',expected:'Value retained',expected_basis:basis}]};
  const check={type:'assert',request_id:'basis',target:{by:'css',value:'#field'},condition:'value',value:'A',case_id:'OBS',title:'Input',expected:'Value retained',case_ref:{source_path:'inputs/cases.json',case_id:'TC'}};
  const proof=resolveBrowserInputs(check,sources(data)).expectation;
  assert.equal(proof.origin,'design_basis');assert.equal(proof.status,'source_located');assert.equal(proof.semantic_verified,false);assert.equal(proof.approval_required,false);assert.ok(proof.sources[0].sha256);
  const unrelated=resolveBrowserInputs({...check,expected:'Saved to database'},sources(data)).expectation;
  assert.equal(unrelated.origin,'design_reference_only');assert.equal(unrelated.status,'not_recorded');
  const explicit={...check,case_ref:undefined,expected_basis:basis};assert.doesNotThrow(()=>validateBrowserOperation(explicit));
  assert.equal(resolveBrowserInputs(explicit,sources(data)).expectation.origin,'explicit');
  assert.equal(resolveBrowserInputs({...explicit,expected_basis:[{...basis[0],quote:'Invented clause'}]},sources(data)).expectation.status,'needs_correction');
  assert.equal(resolveBrowserInputs(explicit,sources({})).expectation.status,'needs_correction');
  assert.equal(resolveBrowserInputs({...check,case_ref:undefined},sources({})).expectation.status,'not_recorded');
  assert.throws(()=>validateBrowserOperation({...explicit,expected_basis:[{...basis[0],kind:'engineering_assumption'}]}));
  assert.throws(()=>validateBrowserOperation({...explicit,expected_basis:[{...basis[0],source_path:'../secret.txt'}]}));
  const extra=structuredClone(data);extra['inputs/cases.json'][0].expected_basis[0].extra='PRIVATE-UNRELATED-DATA';
  assert.ok(!JSON.stringify(resolveBrowserInputs(check,sources(extra)).expectation).includes('PRIVATE-UNRELATED-DATA'));
});

test('sample references resolve once per source for action, assertion and preconditions',()=>{
  let reads=0;const file=sources({'inputs/cases.json':[{case_id:'TC',expected:'Retained',test_data:{value:'  precise  '}}]});
  const ref={source_path:'inputs/cases.json',case_id:'TC',key:'value'};
  const op={type:'click',request_id:'same-source',target:{by:'css',value:'button'},preconditions:[{target:{by:'css',value:'input'},condition:'value',value_ref:ref}],assertion:{target:{by:'css',value:'output'},condition:'text',value_ref:ref,case_id:'CHECK',title:'Preserved',expected:'Retained'}};
  assert.doesNotThrow(()=>validateBrowserOperation(op));
  const resolved=resolveBrowserInputs(op,path=>{reads++;return file(path);});
  assert.equal(reads,1);assert.equal(resolved.operation.preconditions[0].value,'  precise  ');assert.equal(resolved.operation.assertion.value,'  precise  ');
  assert.equal(uiComparison(resolved.operation.assertion),'exact_text');
  assert.notEqual(uiCheckFingerprint(resolved.operation.assertion),uiCheckFingerprint({...resolved.operation.assertion,text_mode:'normalized'}));
});

test('exact text comparison retains whitespace while legacy normalized text remains available',async t=>{
  const f=await fixture(t,'<span id="field"> A  B </span>');
  assert.equal((await f.run(f.check('text','A B'))).status,'passed');
  assert.equal((await f.run({...f.check('text','A B'),text_mode:'exact'})).status,'failed');
  assert.equal((await f.run({...f.check('text',' A  B '),text_mode:'exact'})).status,'passed');
  assert.equal((await f.run({...f.check('text','A B'),value_ref:{source_path:'inputs/cases.json',case_id:'TC',key:'v'}})).status,'failed');
});

test('readonly, editable and enabled/disabled are observed without attempting input',async t=>{
  const f=await fixture(t,'<input id="field" readonly value="unchanged"><input id="off" disabled><input id="edit"><input id="box" type="checkbox" readonly>');
  await f.page.evaluate(()=>{window.edits=0;document.addEventListener('input',()=>window.edits++);});
  assert.equal((await f.run(f.check('readonly'))).status,'passed');
  assert.equal((await f.run(f.check('enabled'))).status,'passed');
  assert.equal((await f.run(f.check('editable'))).status,'failed');
  assert.equal((await f.run(f.check('disabled',undefined,'#off'))).status,'passed');
  assert.equal((await f.run(f.check('readonly',undefined,'#off'))).status,'failed');
  assert.equal((await f.run(f.check('editable',undefined,'#edit'))).status,'passed');
  assert.equal((await f.run(f.check('readonly',undefined,'#box'))).reason,'unsupported_control');
  assert.equal(await observeUiCondition(f.page.locator('#field'),'readonly'),true);
  assert.equal(await f.page.locator('#field').inputValue(),'unchanged');assert.equal(await f.page.evaluate(()=>window.edits),0);
});

test('blank and error pages cannot pass absent-element checks without a ready business region',async t=>{
  const f=await fixture(t,'<h1>Service error</h1>');
  assert.deepEqual(await f.run(f.check('hidden',undefined,'#missing')),{status:'blocked',reason:'readiness_required'});
  const ready={target:{by:'css',value:'h1'},text:'Orders'};
  assert.equal((await f.run(f.check('count',0,'#missing',ready))).status,'blocked');
  await f.page.setContent('<h1>Orders</h1>');
  assert.equal((await f.run(f.check('count',0,'#missing',ready))).status,'passed');
  assert.equal((await f.run(f.check('hidden',undefined,'#missing',ready))).status,'passed');
  assert.equal((await evaluateUiCheck(f.page,f.check('hidden',undefined,'#missing',ready),f.locate,{timeout:100,getDocumentStatus:()=>500})).reason,'error_document');
});

test('business-region replacement during a negative check invalidates readiness without persistent URL trust',async t=>{
  const f=await fixture(t,'<h1>Orders</h1><div id="field">Visible</div>');
  const ready={target:{by:'css',value:'h1'},text:'Orders'};
  const result=f.run(f.check('hidden',undefined,'#field',ready),700);
  await f.page.waitForTimeout(150);
  await f.page.evaluate(()=>{document.querySelector('h1').outerHTML='<h1>Orders</h1>';document.querySelector('#field').remove();});
  assert.deepEqual(await result,{status:'blocked',reason:'readiness_changed'});
});

test('ambiguous and invalid locators are engineering problems; a missing specified element remains a mismatch',async t=>{
  const f=await fixture(t,'<p class="many">A</p><p class="many">A</p><h1>Orders</h1>');
  assert.equal((await f.run(f.check('text','A','.many'))).reason,'locator_ambiguous');
  assert.equal((await f.run(f.check('visible',undefined,'['))).status,'blocked');
  assert.deepEqual(await f.run(f.check('visible',undefined,'#missing')),{status:'failed',reason:'condition_not_met'});
  assert.equal((await f.run(f.check('text','Orders','h1'))).status,'passed');
  assert.equal((await f.run(f.check('text','navigation closed','h1'))).status,'failed');
  assert.equal((await f.run(f.check('text','strict mode violation','h1'))).status,'failed');
});

test('state assertions and readiness use bounded structured fields and rechecks bind the readiness context',()=>{
  const base={type:'assert',request_id:'read-only',target:{by:'css',value:'#field'},condition:'readonly',case_id:'STATE',title:'Readonly',expected:'Readonly'};
  assert.doesNotThrow(()=>validateBrowserOperation(base));
  const ready={target:{by:'css',value:'h1'},text:'Orders'};
  assert.doesNotThrow(()=>validateBrowserOperation({...base,condition:'hidden',ready}));
  assert.throws(()=>validateBrowserOperation({...base,ready:{...ready,script:'arbitrary'}}));
  assert.throws(()=>validateBrowserOperation({...base,ready:{target:ready.target}}));
  assert.notEqual(uiCheckFingerprint({...base,ready}),uiCheckFingerprint({...base,ready:{...ready,text:'Another region'}}));
});

test('native dialog policy is explicit, bounded, and only available on click/press',()=>{
  const policy={type:'confirm',message:'Delete this test record?',action:'accept'};
  const click={type:'click',request_id:'confirm',target:{by:'css',value:'button'},dialog_policy:policy};
  assert.doesNotThrow(()=>validateBrowserOperation(click));
  assert.doesNotThrow(()=>validateBrowserOperation({...click,type:'press',key:'Enter'}));
  assert.throws(()=>validateBrowserOperation({...click,type:'fill',value:'x'}));
  assert.throws(()=>validateDialogPolicy({...policy,type:'beforeunload'}));
  assert.throws(()=>validateDialogPolicy({...policy,prompt_text:'x'}));
  assert.throws(()=>validateDialogPolicy({...policy,message:'x'.repeat(4001)}));
  assert.throws(()=>validateDialogPolicy({...policy,match:'*'}));
});

test('native dialog tracker consumes exact policy once and never stores dialog text or prompt values',async t=>{
  const f=await fixture(t,'<button onclick="window.answers=[confirm(\'Confirm private text\'),confirm(\'Confirm private text\')]">Run</button>');
  const saved=[],tracker=createDialogTracker({onEvent:event=>saved.push(event)});
  f.page.on('dialog',tracker.handle);
  tracker.begin('double',{type:'confirm',message:'Confirm private text',action:'accept'});
  await f.page.locator('button').click();
  const proof=await tracker.end();
  assert.deepEqual(await f.page.evaluate(()=>window.answers),[true,false]);
  assert.equal(proof.reason,'unexpected_dialog');assert.equal(proof.events.length,2);
  assert.deepEqual(proof.events.map(e=>e.action),['accept','dismiss']);
  assert.ok(saved.every(e=>e.observed_at));assert.ok(proof.events.every(e=>e.completed_at && e.status==='handled'));
  assert.ok(!JSON.stringify(saved).includes('private text'));
  tracker.begin('prompt',{type:'prompt',message:'Enter value',action:'accept',prompt_text:'sensitive-answer'});
  assert.equal(await f.page.evaluate(()=>prompt('Enter value','sensitive-default')),'sensitive-answer');
  assert.equal((await tracker.end()).reason,null);
  assert.ok(!JSON.stringify(saved).includes('sensitive'));
});

test('unexpected, mismatched, absent and late native dialogs never acquire implicit consent',async t=>{
  const f=await fixture(t,'<p>Dialogs</p>'),tracker=createDialogTracker(),late=[];
  f.page.on('dialog',tracker.handle);
  tracker.begin('unexpected');
  assert.equal(await f.page.evaluate(()=>confirm('Unexpected')),false);
  assert.equal((await tracker.end()).reason,'unexpected_dialog');
  tracker.begin('mismatch',{type:'confirm',message:'Expected',action:'accept'});
  assert.equal(await f.page.evaluate(()=>confirm('Other')),false);
  assert.equal((await tracker.end()).reason,'unexpected_dialog');
  tracker.begin('missing',{type:'alert',message:'Expected',action:'dismiss'});
  assert.equal((await tracker.end()).reason,'expected_dialog_not_observed');
  f.page.off('dialog',tracker.handle);
  const isolated=createDialogTracker({onEvent:event=>late.push(event)});
  f.page.on('dialog',isolated.handle);
  assert.equal(await f.page.evaluate(()=>confirm('After operation')),false);
  await isolated.settle();assert.equal(late.at(-1).request_id,null);assert.equal(late.at(-1).policy_matched,false);
});

test('native dialog handling and evidence failures are retained without unhandled rejection',async()=>{
  const unarmed=createDialogTracker();unarmed.begin('not-started');
  assert.equal((await unarmed.end()).reason,null);
  unarmed.begin('started');unarmed.arm({type:'confirm',message:'x',action:'accept'});
  assert.equal((await unarmed.end()).reason,'expected_dialog_not_observed');
  const tracker=createDialogTracker();tracker.begin('failure');
  await tracker.handle({type:()=> 'confirm',message:()=> 'x',dismiss:async()=>{throw new Error('Browser closed');}});
  assert.equal((await tracker.end()).reason,'dialog_handling_unconfirmed');
  const unavailable=createDialogTracker({onEvent:()=>{throw new Error('Disk unavailable');}});
  unavailable.begin('evidence',{type:'alert',message:'x',action:'dismiss'});
  await unavailable.handle({type:()=> 'alert',message:()=> 'x',dismiss:async()=>{}});
  assert.equal((await unavailable.end()).reason,'dialog_evidence_unavailable');
});
