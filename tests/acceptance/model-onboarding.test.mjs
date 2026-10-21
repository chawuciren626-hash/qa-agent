import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qaModelSetup,qaProbeConfiguredModel,qaFirstTaskPrompt,qaFirstRunCompleted,qaCompleteFirstRun} from '../../penguin/ui/workspace-ui.mjs';
const catalog={updatedAt:'one',defaultModel:{provider:'sample',modelId:'default'},models:[{provider:'sample',modelId:'default',displayName:'Default',effective:{apiKeySource:'provider'}},{provider:'local',modelId:'override',effective:{apiKeySource:'none'}}]};
test('first-use completion survives remount and history deletion, and is isolated by account and installation',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  assert.equal(qaFirstRunCompleted('p','alice',[],storage),false);
  qaCompleteFirstRun('p','alice',storage);
  assert.equal(qaFirstRunCompleted('p','alice',[],storage),true);
  assert.equal(qaFirstRunCompleted('p','bob',[],storage),false);
  storage.setItem('penguin.installId','new-installation');
  assert.equal(qaFirstRunCompleted('p','alice',[],storage),false);
});
test('existing started controller task skips setup, while empty tasks and unrelated agents do not',()=>{
  const storage={getItem:()=>null,setItem:()=>{}};
  const done=sessions=>qaFirstRunCompleted('p','u',sessions,storage);
  assert.equal(done([{agentId:'test_agent',hasTrace:true}]),true);
  assert.equal(done([{agentId:'test_agent',hasTrace:false}]),false);
  assert.equal(done([{agentId:'test_case_agent',hasTrace:true}]),false);
  assert.equal(done([{agentId:'test_agent',hasTrace:true,source:'subagent'}]),false);
  assert.equal(done([{agentId:'test_agent',hasTrace:true,origin:['parent']}]),false);
  const denied={getItem(){throw Error('denied')},setItem(){throw Error('denied')}};
  assert.doesNotThrow(()=>qaCompleteFirstRun('p','u',denied));
  assert.equal(qaFirstRunCompleted('p','u',[{agentId:'test_agent',hasTrace:true}],denied),true);
});
test('guide resolves actual controller override rather than claiming the project default is tested',()=>{
  assert.equal(qaModelSetup(catalog,{}).label,'Default');
  const selected=qaModelSetup(catalog,{config:{model:{provider:'local',modelId:'override'}}});assert.equal(selected.ref.modelId,'override');assert.equal(selected.status,'needs_check');
  assert.equal(qaModelSetup(catalog,{config:{model:{provider:'missing',modelId:'gone'}}}).status,'missing_model');
});
test('probe sends only saved model reference, never keys, and only reports explicit ok',async()=>{
  for(const ok of [true,false,undefined]){const calls=[];const result=await qaProbeConfiguredModel(async(url,options)=>{calls.push({url,options});if(url.endsWith('/test'))return {ok,message:'provider error containing secrets must not be displayed'};return url.endsWith('/models')?catalog:{config:{}};},'/api/projects/fixture');assert.equal(result.status,ok===true?'connected':'failed');assert.deepEqual(calls.find(c=>c.options).options,{method:'POST',body:{provider:'sample',modelId:'default'}});assert.equal(JSON.stringify(result).includes('secrets'),false);}
});
test('changing configuration during probe invalidates success, and missing model never calls probe',async()=>{
  let count=0;const changed=await qaProbeConfiguredModel(async url=>url.endsWith('/test')?{ok:true}:url.endsWith('/models')?{...catalog,updatedAt:String(++count)}:{},'/api/projects/fixture');assert.equal(changed.status,'changed');
  let tests=0;const missing=await qaProbeConfiguredModel(async url=>{if(url.endsWith('/test'))tests++;return {};},'/api/projects/fixture');assert.equal(missing.status,'missing_model');assert.equal(tests,0);
});
test('safe display state excludes masked credentials and example does not request execution',()=>{
  const state=qaModelSetup({...catalog,models:[{...catalog.models[0],credential:{apiKeyMasked:'SECRET'},effective:{apiKeySource:'provider',apiKeyMasked:'SECRET'}}]},{});assert.equal(JSON.stringify(state).includes('SECRET'),false);assert.match(qaFirstTaskPrompt,/3 条测试用例/);assert.match(qaFirstTaskPrompt,/不执行测试/);
});
