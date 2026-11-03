import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserAuthorization, browserCasePlan, browserCoverage, assertBrowserTarget, assertBrowserDesignCheck } from '../../scripts/browser-lifecycle.mjs';
const root=resolve(import.meta.dirname,'../..');
const native=(text,sender)=>({type:'model_msg',timestamp:new Date().toISOString(),payload:{type:'text',role:'user',text,sender}});
function fixture() {
  const id=`run-${randomUUID()}`,dir=resolve(root,'output/runs',id);mkdirSync(resolve(dir,'design'),{recursive:true});
  const cases=[{case_id:'TC-1',title:'Confirmed',preconditions:['signed in'],test_data:{name:'sample'},steps:['enter name','save'],expected:'Ready',design_contract:{basis:[{status:'confirmed'}],assumptions:[]}},{case_id:'TC-2',title:'Pending',expected:'Unknown',design_contract:{basis:[{status:'pending'}],assumptions:[]}}];
  writeFileSync(resolve(dir,'design/test_cases.json'),JSON.stringify(cases));
  const text='请对 http://127.0.0.1:12345/ 执行全流程测试，登录时由我处理。',rows=[native(text)];
  const auth=browserAuthorization(root,id,'parent',rows,text);
  const manifest={run_id:id,orchestration:{plan:{workflow_mode:'lifecycle'},execution_strategy:'browser',events:[{type:'dispatched',stage:'execution',browser_authorization:auth}]}};
  return {id,dir,cases,text,rows,auth,manifest};
}
test('browser lifecycle authorization binds native execution intent, origin and immutable design',()=>{
  const f=fixture();
  assert.doesNotThrow(()=>assertBrowserTarget(root,f.id,f.manifest,'http://127.0.0.1:12345/feature'));
  assert.throws(()=>assertBrowserTarget(root,f.id,f.manifest,'http://localhost:12345/'),/outside/);
  assert.throws(()=>browserAuthorization(root,f.id,'parent',[native(f.text,'harness')],f.text),/native/);
  assert.throws(()=>browserAuthorization(root,f.id,'parent',f.rows,'invented'),/native/);
  const text='只生成测试用例 http://127.0.0.1:12345/';
  assert.throws(()=>browserAuthorization(root,f.id,'parent',[native(text)],text),/execution/);
  assert.throws(()=>browserAuthorization(root,f.id,'parent',[...f.rows,native('停止测试')],f.text),/stop/);
  writeFileSync(resolve(f.dir,'design/test_cases.json'),'[]');
  assert.throws(()=>assertBrowserTarget(root,f.id,f.manifest,'http://127.0.0.1:12345/'),/changed/);
});
test('explicit request to execute six browser cases at the named URL is accepted',()=>{
  const f=fixture();
  const text='确认在测试环境url:https://example.test/login 上实际执行登录模块全部6条用例的浏览器测试';
  const auth=browserAuthorization(root,f.id,'parent',[native(text)],text);
  assert.deepEqual(auth.urls.map(value=>new URL(value).origin),['https://example.test']);
  assert.throws(()=>browserAuthorization(root,f.id,'parent',[native(text.replace('执行','不要执行'))],text.replace('执行','不要执行')),/explicitly request execution/);
});
test('browser case plan preserves approved order, steps, data and pending business rules',()=>{
  const f=fixture(),plan=browserCasePlan(f.dir,f.manifest);
  assert.equal(plan.design_sha256,f.auth.design_sha256);
  assert.deepEqual(plan.cases.map(row=>[row.order,row.case_id,row.readiness]),[[1,'TC-1','ready'],[2,'TC-2','pending_business_confirmation']]);
  assert.deepEqual(plan.cases[0].steps,['enter name','save']);
  assert.deepEqual(plan.cases[0].test_data,{name:'sample'});
  writeFileSync(resolve(f.dir,'design/test_cases.json'),'[]');
  assert.throws(()=>browserCasePlan(f.dir,f.manifest),/design changed/);
});
test('unknown and unconfirmed design expectations cannot enter lifecycle assertions; unmapped cases stay untested',()=>{
  const f=fixture();
  assert.throws(()=>assertBrowserDesignCheck(f.dir,f.manifest,{}),/reference/);
  assert.throws(()=>assertBrowserDesignCheck(f.dir,f.manifest,{case_ref:{source_path:'design/test_cases.json',case_id:'TC-2'}}),/Unconfirmed/);
  assert.throws(()=>assertBrowserDesignCheck(f.dir,f.manifest,{case_ref:{source_path:'design/test_cases.json',case_id:'invented'}}),/Unconfirmed/);
  const ref={source_path:'design/test_cases.json',case_id:'TC-1',source_sha256:f.auth.design_sha256};
  assert.doesNotThrow(()=>assertBrowserDesignCheck(f.dir,f.manifest,{case_ref:ref}));
  const coverage=browserCoverage(f.dir,f.manifest,{cases:[{case_ref:ref},{case_ref:ref}]});
  assert.deepEqual(coverage.linked_case_ids,['TC-1']);assert.equal(coverage.untested_cases[0].case_id,'TC-2');
  assert.deepEqual(coverage.completed_case_ids,[]);
  assert.equal(coverage.incomplete_cases[0].reason,'no_step_review');
  const reviewed=browserCoverage(f.dir,f.manifest,{cases:[{case_ref:ref}]},[{case_id:'TC-1',completed_step_indices:[1,2],untested:[]}]);
  assert.deepEqual(reviewed.completed_case_ids,['TC-1']);
  assert.equal(reviewed.incomplete_cases[0].case_id,'TC-2');
  assert.equal(browserCoverage(f.dir,f.manifest,{cases:[{case_ref:ref}]},[{case_id:'TC-1',completed_step_indices:[1]}]).incomplete_cases[0].reason,'steps_not_completed');
  assert.equal(browserCoverage(f.dir,f.manifest,{cases:[{case_ref:{...ref,source_sha256:'changed'}}]}).untested_cases.length,2);
  assert.equal(browserCoverage(f.dir,f.manifest,{cases:[{case_ref:ref,evidence_mode:'simulated'}]}).untested_cases.length,2);
});
