import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { writeJson } from './orchestration-state.mjs';
import { validateExplorationTarget } from './explore-task-url.mjs';
import { validateResponseCheck, observeBusinessResponse } from './browser-response-check.mjs';
import { dataLedgerPath, validDataKey, prepareOwnedData, ownedDataForEffect, beginDataEffect, completeDataEffect, summarizeDataLedger } from './browser-data-ledger.mjs';
import { validateCountMetadata, resolveCaseReference, summarizeExecutionCounts, uiCheckFingerprint } from './execution-counts.mjs';
import { validateApiCheck, validateFault, runReadOnlyApiCheck, createOneShotFault } from './browser-api-controls.mjs';
import { browserLifecycle, currentBrowserAuthorization, assertBrowserTarget, assertBrowserDesignCheck, browserCoverage } from './browser-lifecycle.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const privatePath = dir => resolve(dir, 'execution/browser-private.json');
const statePath = dir => resolve(dir, 'execution/browser-state.json');
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const sleep = ms => new Promise(done => setTimeout(done, ms));
export const browserOperations = ['start', 'snapshot', 'goto', 'fill', 'click', 'press', 'select', 'check', 'assert', 'pause', 'finish', 'data_prepare', 'api_check'];

export async function browserWorkerResponse(response, requestId) {
  if(response.ok) return response.json();
  if(response.status===403) return {status:'worker_access_rejected',operation_started:false,next_action:'inspect_local_worker_connection_no_product_retry'};
  if(response.status===409) return {status:'worker_busy',operation_started:false,next_action:'wait_then_reuse_same_request_id',request_id:requestId};
  if(response.status===400) {
    const result=await response.json();
    if(result.status==='invalid_operation' && result.operation_started===false) return result;
  }
  throw new Error('Worker response does not establish the operation outcome');
}

export function browserErrorDiagnostic(error, phase) {
  const message=String(error?.message ?? error);
  const category=/Browser already started/.test(message)?'browser_already_started':/Expected result already present before action/.test(message)?'stale_result':/closed|disconnected|crash/i.test(message)?'browser_unavailable':/timeout/i.test(message)?'timeout':/execution context|navigation/i.test(message)?'navigation_changed':/strict mode|uniquely visible/i.test(message)?'locator_mismatch':'browser_operation_error';
  // Never persist raw Playwright call logs: they can contain selectors and form secrets.
  return {phase,category,...(/net::ERR_[A-Z_]+/.test(message)?{network_code:message.match(/net::ERR_[A-Z_]+/)[0]}:{})};
}

export function browserRecoveryHint(category) {
  if(category==='browser_already_started') return {next_action:'snapshot_existing_browser_or_goto_for_new_page_state',message:'start creates one browser per run; it is not refresh. Use snapshot to observe the existing page, or goto with the authorized URL and source_path to navigate. No new browser or navigation was performed.'};
  if(category==='stale_result') return {next_action:'inspect_existing_feedback_before_any_new_submission',message:'No action performed: the expected result was already present. Do not change click to press or use a static label. For a fresh independent read-only form check use goto to the authorized page, then fill inputs and assert the dynamic result. Do not reload or resubmit an uncertain business operation.'};
  return {next_action:'inspect_snapshot_or_finish_partial',message:'Browser operation diagnostic available; raw call logs excluded for privacy'};
}

export function browserRequestPolicy({url,origin,frameOrigin,resourceType,method}) {
  const target=new URL(url);
  if(!['http:','https:'].includes(target.protocol)) return 'blocked_protocol';
  if(target.origin===origin) return 'same_origin';
  if(['image','stylesheet','font','script','media'].includes(resourceType) && method==='GET') return 'static_dependency';
  // Only dependencies initiated by the scoped application, never a new document target.
  if(frameOrigin===origin && ['xhr','fetch'].includes(resourceType)) return 'application_api';
  return 'blocked_new_target';
}

export async function captureBrowserEvidence(page,path,secrets) {
  try {
    const masks=[page.locator('input,textarea')];
    for(const secret of secrets) if(secret) masks.push(page.getByText(secret,{exact:false}));
    await page.screenshot({path,mask:masks,timeout:8000});
    return {captured:true};
  } catch(error) {
    // Do not retry unmasked. DOM evidence is still useful when image capture fails.
    return {captured:false,warning:browserErrorDiagnostic(error,'screenshot')};
  }
}

export async function waitForBrowserContent(page) {
  const started=Date.now();
  try {
    const handle=await page.waitForFunction(()=>{
      const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';};
      return [...document.querySelectorAll('input,textarea,select,button,[role=button],a[href]')].some(visible) || (document.body?.innerText ?? '').trim().length>0;
    },null,{timeout:1500,polling:100});
    await handle.dispose();
    return {content_observed:true,wait_ms:Date.now()-started,interpretation:'Initial content observed, not proof of application readiness or business success. Reuse the returned snapshot before requesting another.'};
  } catch(error) {
    if(error.name!=='TimeoutError') throw error;
    return {content_observed:false,wait_ms:Date.now()-started,interpretation:'No initial content observed within the bounded wait. Inspect the current page without reloading or repeating a submission; this alone is not a product failure.'};
  }
}

export async function observeFeedbackPaint(target) {
  const started=Date.now();let previous, sample;
  // Read-only sampling: never hide overlays, fast-forward animations, or replay actions.
  try {
    do {
      if(await target.count()!==1) return {status:'not_unique_or_absent',wait_ms:Date.now()-started};
      sample=await target.evaluate(e=>{
        const r=e.getBoundingClientRect();let opacity=1,visible=true;
        for(let p=e;p;p=p.parentElement) {const s=getComputedStyle(p);opacity*=Number(s.opacity);if(s.visibility==='hidden' || s.display==='none') visible=false;}
        return {x:r.x,y:r.y,width:r.width,height:r.height,opacity,visible:visible && r.width>0 && r.height>0,within_viewport:r.top>=0 && r.left>=0 && r.bottom<=innerHeight && r.right<=innerWidth};
      },null,{timeout:100});
      if(!sample.visible) break;
      if(previous && sample.opacity>=0.95 && sample.within_viewport && ['x','y','width','height'].every(k=>Math.abs(sample[k]-previous[k])<1)) return {status:'settled',wait_ms:Date.now()-started,sample};
      previous=sample;
      if(Date.now()-started>=250) break;
      await sleep(30);
    } while(Date.now()-started<250);
    return {status:'not_settled',wait_ms:Date.now()-started,sample};
  } catch(error) {return {status:'unavailable',wait_ms:Date.now()-started,diagnostic:browserErrorDiagnostic(error,'feedback_paint')};}
}

export async function beginDynamicFeedback(page) {
  return page.evaluateHandle(()=>{
    const startedAt=new Date().toISOString(), seen=new WeakMap(), candidates=[];
    let stopped=false, scans=0, truncated=false, interval, timer, observer, finishedAt;
    const selector=e=>{
      const parts=[];
      for(let node=e;node?.nodeType===1;node=node.parentElement) {
        const siblings=[...(node.parentElement?.children ?? [node])].filter(s=>s.tagName===node.tagName);
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node)+1})`);
      }
      return parts.join(' > ');
    };
    const sample=e=>{
      if(e.closest('input,textarea,select,script,style,noscript,[contenteditable]')) return null;
      const text=[...e.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join(' ').trim();
      if(!text || text.length>500) return null;
      const r=e.getBoundingClientRect();let visible=r.width>0 && r.height>0;
      for(let p=e;visible && p;p=p.parentElement) {const s=getComputedStyle(p);visible=s.display!=='none' && s.visibility!=='hidden' && Number(s.opacity)>0;}
      return {text,visible};
    };
    const scan=baseline=>{
      if(stopped) return;
      if(++scans>40) {truncated=true;stop();return;}
      const elements=document.body?.querySelectorAll('*') ?? [];
      if(elements.length>2000) truncated=true;
      for(let i=0;i<Math.min(elements.length,2000);i++) {
        const e=elements[i], current=sample(e), prior=seen.get(e);
        seen.set(e,current);
        if(baseline || !current?.visible || (prior?.visible && prior.text===current.text)) continue;
        if(candidates.length>=20) {truncated=true;continue;}
        candidates.push({observed_at:new Date().toISOString(),text:current.text,selector:selector(e),change:prior?.visible?'text_changed':prior?'became_visible':'new_visible_text'});
      }
    };
    const stop=()=>{if(!stopped){stopped=true;finishedAt=new Date().toISOString();observer?.disconnect();clearInterval(interval);clearTimeout(timer);}return {started_at:startedAt,finished_at:finishedAt,candidates,truncated};};
    scan(true);
    observer=new MutationObserver(()=>scan(false));
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden']});
    interval=setInterval(()=>scan(false),100);
    timer=setTimeout(stop,1500);
    return {stop,read:()=>({count:candidates.length,stopped})};
  });
}

export async function endDynamicFeedback(handle) {
  if(!handle) return {status:'unavailable',candidates:[]};
  try {
    // Wait only for the first observed candidate, never for a second product action.
    const until=Date.now()+1000;
    while(Date.now()<until) {
      const state=await handle.evaluate(s=>s.read());
      if(state.count || state.stopped) break;
      await sleep(50);
    }
    return {status:'observed',...await handle.evaluate(s=>s.stop())};
  } catch(error) {
    return {status:'unavailable',candidates:[],diagnostic:browserErrorDiagnostic(error,'dynamic_feedback')};
  } finally {
    await handle.evaluate(s=>s.stop()).catch(()=>{});
    await handle.dispose().catch(()=>{});
  }
}

export function validateBrowserOperation(op) {
  assert(op && browserOperations.includes(op.type), 'Unknown browser operation');
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(op.request_id ?? ''), 'operation.request_id is required: use 1-80 ASCII letters/digits/_/-, e.g. "case1-submit". No operation performed. Reuse the same ID after transport uncertainty; give a different intended operation a new ID.');
  const fields = {
    start:['url','source_path','scope','headless'], snapshot:[], goto:['url','source_path'],
    fill:['target','value','secret'], click:['target','assertion','preconditions','response_check','data_effect','fault'], press:['target','key','assertion','preconditions','response_check','data_effect','fault'], select:['target','value'],
    check:['target','checked'], assert:['target','condition','value','case_id','title','expected','case_ref','recheck_of'],
    pause:['kind','question'], finish:['summary','limitations'], data_prepare:['key'], api_check:['check']
  };
  assert(Object.keys(op).every(k => ['type','request_id',...fields[op.type]].includes(k)), 'Unknown browser operation field');
  if(op.type==='api_check') validateApiCheck(op.check);
  if(op.fault!==undefined) {validateFault(op.fault);assert(op.assertion && !op.response_check && !op.data_effect,'Fault scenario requires a UI assertion; cannot mix real response/data checks');}
  if(op.type==='data_prepare') assert(validDataKey(op.key),'data_prepare needs a short key');
  if(op.data_effect!==undefined) {
    const effect=op.data_effect;
    assert(effect && Object.keys(effect).every(k=>['kind','key','record_target'].includes(k)) && ['create','cleanup'].includes(effect.kind) && validDataKey(effect.key),'Invalid data_effect');
    validateBrowserOperation({type:'assert',request_id:op.request_id,target:effect.record_target,condition:'count',value:1,case_id:'identity',title:'Identity',expected:'Single record'});
  }
  if(op.response_check!==undefined) validateResponseCheck(op.response_check);
  if(op.preconditions!==undefined) {
    assert(Array.isArray(op.preconditions) && op.preconditions.length>0 && op.preconditions.length<=4,'Use 1-4 necessary preconditions');
    for(const check of op.preconditions) {
      assert(check && Object.keys(check).every(key=>['target','condition','value'].includes(key)),'Preconditions are read-only checks, not case results');
      validateBrowserOperation({...check,type:'assert',request_id:op.request_id,case_id:'precondition',title:'Precondition',expected:'Required page state'});
    }
  }
  if (op.assertion!==undefined) {
    assert(op.assertion && typeof op.assertion==='object' && !Array.isArray(op.assertion),'assertion must be an assertion object');
    assert(!['type','request_id'].some(k=>k in op.assertion),'Nested assertion cannot override operation identity');
    assert(op.assertion.recheck_of===undefined,'recheck_of is only for read-only standalone assertions, never permission to replay an action');
    validateBrowserOperation({...op.assertion,type:'assert',request_id:op.request_id});
  }
  if (['start','goto'].includes(op.type)) assert(typeof op.url==='string' && typeof op.source_path==='string', 'Supplied URL and source_path required');
  if (op.type==='start') {
    assert(typeof op.scope==='string' && op.scope.trim(), 'Summarize the requested test scope, not a new approval document');
    assert(op.headless===undefined || typeof op.headless==='boolean', 'headless must be boolean');
  }
  if (['fill','select'].includes(op.type)) assert(typeof op.value==='string', 'value must be a string');
  if (op.secret!==undefined) assert(typeof op.secret==='boolean','secret must be boolean');
  if (op.type==='check') assert(typeof op.checked==='boolean','checked must be boolean');
  if (op.type==='press') assert(['Enter','Tab','Escape','ArrowDown','ArrowUp','Space'].includes(op.key),'Unsupported key');
  if (['fill','click','press','select','check','assert'].includes(op.type)) {
    const t=op.target;
    assert(t && ['role','label','placeholder','text','css'].includes(t.by) && typeof t.value==='string' && t.value.trim(), 'Use an observed target: {by:role|label|placeholder|text|css,value,name?}');
    assert(Object.keys(t).every(k=>['by','value','name'].includes(k)) && (t.name===undefined || typeof t.name==='string'),'Invalid target');
  }
  if (op.type==='assert') {
    validateCountMetadata(op);
    assert(['visible','hidden','text','value','count'].includes(op.condition),'Unsupported assertion');
    assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(op.case_id ?? '') && typeof op.title==='string' && op.title.trim() && typeof op.expected==='string' && op.expected.trim(),'Assertion case_id, title and expected required');
    if (op.condition==='text') assert(typeof op.value==='string' || (op.value===undefined && op.target.by==='text'),'Text assertion needs value, e.g. {condition:"text",value:"expected message"}; only exact target.by=text may reuse target.value');
    if (op.condition==='value') assert(typeof op.value==='string','Value assertion needs an explicit string value; input contents are never inferred');
    if (op.condition==='count') assert(Number.isInteger(op.value) && op.value>=0,'Assertion count must be a nonnegative integer');
  }
  if (op.type==='pause') assert(['captcha','mfa','access','business_question','risk_decision'].includes(op.kind) && typeof op.question==='string' && op.question.trim(),'Only genuine human intervention may pause');
  if (op.type==='finish') assert(typeof op.summary==='string' && op.summary.trim() && Array.isArray(op.limitations) && op.limitations.every(v=>typeof v==='string'),'Finish needs summary and limitations');
}

function binding(dir) {
  const manifest=load(resolve(dir,'manifest.json'));
  const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage==='execution').at(-1);
  assert((manifest.orchestration?.plan?.workflow_mode==='task' || browserLifecycle(manifest)) && manifest.stages?.execution?.status==='in_progress' && dispatch?.dispatch_id,'Requires an active browser execution dispatch');
  if(browserLifecycle(manifest)) assert(readRunFile(dir,'design/test_cases.json').sha256===currentBrowserAuthorization(manifest)?.design_sha256,'Authorized design changed');
  return dispatch;
}

export async function browserTaskCommand(root,runId,operation) {
  validateBrowserOperation(operation);
  assert(uuid(process.env.QA_TASK_COMMAND_ID),'Use browser_task through the controlled command entry');
  const dir=runDirectory(root,runId), dispatch=binding(dir);
  const existing=resolve(dir,'execution/browser-evidence',`${operation.request_id}.json`);
  if(existsSync(existing)) {
    const receipt=JSON.parse(readRunFile(dir,`execution/browser-evidence/${operation.request_id}.json`).data);
    if(receipt.request_sha256!==hash(JSON.stringify(operation))) return {status:'invalid_request',next_action:'correct_request_id_conflict_no_operation_performed'};
    if(receipt.status==='completed') return receipt.result;
    return {status:'in_progress_or_uncertain',request_id:operation.request_id,next_action:'inspect_existing_receipt_no_replay'};
  }
  if (['start','goto'].includes(operation.type)) {
    validateExplorationTarget(operation.url,operation.source_path,readRunFile(dir,operation.source_path).data.toString('utf8'));
    assertBrowserTarget(root,runId,load(resolve(dir,'manifest.json')),operation.url);
  }
  const request={operation,command_id:process.env.QA_TASK_COMMAND_ID,dispatch_id:dispatch.dispatch_id};
  if (!existsSync(privatePath(dir))) {
    if (operation.type!=='start') return {status:'session_unavailable',next_action:'report_preserved_results_no_automatic_replay'};
    if(existsSync(statePath(dir)) || existsSync(resolve(dir,'execution/exploration.json')) || existsSync(resolve(dir,'execution/exploration.lock'))) return {status:'prior_execution_exists',next_action:'inspect_existing_results_do_not_start_or_replay'};
    // The exclusive bootstrap file prevents concurrent starts. Only this worker owns its browser.
    const token=randomBytes(32).toString('hex');
    writeFileSync(privatePath(dir),JSON.stringify({token,port:null}),{flag:'wx',mode:0o600});
    const child=spawn(process.execPath,[resolve(root,'scripts/browser-task.mjs'),'--worker',runId],{cwd:root,env:{...process.env},detached:true,stdio:'ignore',windowsHide:true});
    child.on('error',()=>{}); child.unref();
    for(let i=0;i<200 && !load(privatePath(dir)).port;i++) await sleep(50);
  }
  const connection=load(privatePath(dir));
  if (!Number.isInteger(connection.port)) return {status:'session_unavailable',next_action:'engineering_inspect_bootstrap_no_product_retry'};
  try {
    const response=await fetch(`http://127.0.0.1:${connection.port}/operation`,{method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(55000)});
    return await browserWorkerResponse(response,operation.request_id);
  } catch {
    return {status:'transport_uncertain',next_action:'reuse_same_request_id_to_read_receipt_never_repeat_with_new_id',request_id:operation.request_id};
  }
}

async function worker(root,runId) {
  const dir=runDirectory(root,runId), token=load(privatePath(dir)).token;
  assert(realpathSync(resolve(dir,'execution'))===resolve(dir,'execution'),'Redirected browser directory');
  let browser, page, context, busy=false, closed=false, lastActivity=Date.now(), lastAction=null, activeFault=null;
  const receipts=new Map(), secrets=new Set(), cases=[], evidence=[], network=[];
  let state={version:1,run_id:runId,invocation_id:randomUUID(),dispatch_id:null,status:'starting',started_at:new Date().toISOString(),scope:null,source_path:null,source_sha256:null,origin:null,blocked_requests:0};
  const dataLedger={version:1,run_id:runId,invocation_id:state.invocation_id,items:[]};
  const saveData=()=>{writeJson(resolve(dir,dataLedgerPath),dataLedger);if(!evidence.includes(dataLedgerPath)) evidence.push(dataLedgerPath);};
  const scrub = text => {let v=String(text);for(const secret of secrets) if(secret) v=v.split(secret).join('[REDACTED]');return v;};
  const save=()=>writeJson(statePath(dir),state);
  const recordNetwork=(req,details)=>{
    const u=new URL(req.url());
    const row={at:new Date().toISOString(),origin:u.origin,path_sha256:hash(u.pathname),method:req.method(),resource_type:req.resourceType(),simulation_context:!!state.simulation_context,...details};
    network.push(row);if(network.length>500) network.shift();
    writeJson(resolve(dir,'execution/browser-network.json'),{version:1,events:network});
  };
  const locator = t => t.by==='role'?page.getByRole(t.value,{name:t.name,exact:true}):t.by==='label'?page.getByLabel(t.value,{exact:true}):t.by==='placeholder'?page.getByPlaceholder(t.value,{exact:true}):t.by==='text'?page.getByText(t.value,{exact:true}):page.locator(t.value);
  const recordIdentity=async record=>{
    const identity=await record.evaluate(node=>({tag:node.tagName,attributes:Object.fromEntries(['id','data-id','data-key'].filter(name=>node.hasAttribute(name)).map(name=>[name,node.getAttribute(name)]))}));
    return {sha256:hash(JSON.stringify(identity)),basis:Object.keys(identity.attributes).length?'marker_and_dom_attributes':'marker_only'};
  };
  const safeUrl = () => {const u=new URL(page.url());u.search='';u.hash='';return u.href;};
  async function snapshot() {
    const structure=await page.evaluate(()=>{
      const selector=e=>{
        const parts=[];
        for(let node=e;node?.nodeType===1;node=node.parentElement) {
          if(node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length===1) {parts.unshift(`#${CSS.escape(node.id)}`);break;}
          const siblings=[...(node.parentElement?.children ?? [node])].filter(s=>s.tagName===node.tagName);
          parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node)+1})`);
        }
        return parts.join(' > ');
      };
      const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';};
      // Non-semantic controls are common in component libraries; observe, never guess, their selectors.
      const controls=[...document.querySelectorAll('button,[role=button],[onclick],[tabindex],label,a[href],div,span')].slice(0,4000).filter(e=>{
        const text=e.textContent.trim();
        return text.length>0 && text.length<=160 && visible(e) &&
          (e.matches('button,[role=button],[onclick],[tabindex],label,a[href]') || getComputedStyle(e).cursor==='pointer') &&
          ![...e.children].some(child=>child.textContent.trim()===text && visible(child));
      }).slice(0,100).map(e=>({selector:selector(e),text:e.textContent.trim(),role:e.getAttribute('role'),disabled:e.matches(':disabled') || e.getAttribute('aria-disabled')==='true'}));
      return {title:document.title,text:(document.body?.innerText ?? '').slice(0,14000),fields:[...document.querySelectorAll('input,textarea,select')].slice(0,100).map(e=>({selector:selector(e),tag:e.tagName,type:e.type,id:e.id,name:e.name,label:e.labels?.[0]?.textContent?.trim() || e.getAttribute('aria-label') || '',placeholder:e.getAttribute('placeholder') || '',visible:visible(e),disabled:e.matches(':disabled'),...(['checkbox','radio'].includes(e.type)?{checked:e.checked}:{} )})),controls,buttons:[...document.querySelectorAll('button,[role=button]')].slice(0,80).map(e=>({selector:selector(e),text:e.textContent.trim(),label:e.getAttribute('aria-label') || ''})),links:[...document.querySelectorAll('a[href]')].slice(0,80).map(e=>({selector:selector(e),text:e.textContent.trim()}))};
    });
    const clean=v=>typeof v==='string'?scrub(v):Array.isArray(v)?v.map(clean):v && typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clean(x)])):v;
    return {url:safeUrl(),...clean(structure)};
  }
  async function capture(id, feedbackTarget=null) {
    const path=`execution/browser-evidence/${id}.png`;
    const paint=feedbackTarget?await observeFeedbackPaint(feedbackTarget):undefined;
    const startedAt=new Date().toISOString();
    const result=await captureBrowserEvidence(page,resolve(dir,path),secrets);
    if(!result.captured) state.capture_warnings=(state.capture_warnings ?? 0)+1;
    return {...(result.captured?{screenshot:path}:{capture_warning:result.warning}),capture_timing:{started_at:startedAt,finished_at:new Date().toISOString(),...(paint?{feedback_paint:paint}:{}),interpretation:'Paint geometry is sampled before the masked screenshot, not a guarantee that transient feedback remains visible in the image. Assertion outcome is independent.'}};
  }
  async function expectResult(check, timeout=5000) {
    const target=locator(check.target), options={timeout};
    if(check.condition==='visible') await expect(target).toBeVisible(options);
    if(check.condition==='hidden') await expect(target).toBeHidden(options);
    if(check.condition==='text') {
      await expect(target).toBeVisible(options);
      await expect(target).toHaveText(check.value ?? check.target.value,options);
    }
    if(check.condition==='value') await expect(target).toHaveValue(check.value,options);
    if(check.condition==='count') await expect(target).toHaveCount(check.value,options);
  }
  async function recordAssertion(check, id, recordPath, action=null) {
    const assertionStartedAt=new Date().toISOString();
    let passed=true;
    try { await expectResult(check); }
    catch(error) {
      if(['browser_unavailable','navigation_changed'].includes(browserErrorDiagnostic(error,'assert').category)) throw error;
      passed=false;
    }
    const matchedAt=new Date().toISOString();
    const timing={mode:action?'same_operation':'standalone_observation',assertion_started_at:assertionStartedAt,matched_at:matchedAt,
      ...(action || lastAction?{preceding_action:action ?? lastAction,delay_after_action_ms:Math.max(0,Date.parse(assertionStartedAt)-Date.parse((action ?? lastAction).completed_at))}:{}),
      interpretation:action?'Assertion evaluated immediately after this action; screenshot and observed value are later captures.':'This assertion checks the page now, not visibility at an earlier action. Transient feedback may already have disappeared.'};
    const target=locator(check.target);
    const captured=await capture(id,passed && ['visible','text'].includes(check.condition)?target:null);
    let observed='unavailable';
    try {
      observed=check.condition==='count'?await target.count():check.condition==='value'?await target.inputValue({timeout:1000}):check.condition==='text'?await target.textContent({timeout:1000}):await target.isVisible();
    } catch { /* A transient result may disappear after the assertion; preserve the match separately. */ }
    const observedPath=`execution/browser-evidence/${id}.observation.json`;
    writeJson(resolve(dir,observedPath),{condition:check.condition,observed:scrub(String(observed).slice(0,2000)),matched:passed,matched_at:matchedAt,timing,...captured});evidence.push(observedPath);
    const row={case_id:check.case_id,title:scrub(check.title),expected:scrub(check.expected),status:passed?'passed':'failed',actual_result:scrub(`${check.condition}: ${String(observed).slice(0,2000)}; ${passed?'matched':'did not match within timeout'}`),timing,evidence_paths:[recordPath,observedPath,...(captured.screenshot?[captured.screenshot]:[])]};
    row.verification_scope={layer:'ui',proves:'Specified UI condition at the recorded observation time only',does_not_prove:['backend_acceptance','persistent_storage']};
    row.evidence_mode=state.simulation_context?'simulation_affected':'real';
    row.check_fingerprint=uiCheckFingerprint(check);
    if(check.case_ref) row.case_ref=resolveCaseReference(check.case_ref,path=>readRunFile(dir,path));
    if(check.recheck_of) row.recheck_of=check.recheck_of;
    cases.push(row);return {assertion:row,...captured};
  }
  async function perform(request) {
    const {operation:op,command_id:commandId,dispatch_id:dispatchId}=request;
    validateBrowserOperation(op); assert(uuid(commandId),'Controlled command required');
    const dispatch=binding(dir);assert(dispatch.dispatch_id===dispatchId,'Stale browser dispatch');
    if (state.dispatch_id && state.dispatch_id!==dispatchId) {
      assert(dispatch.resumes_dispatch_id===state.dispatch_id && state.status==='waiting_human','Browser belongs to another dispatch');
      state.dispatch_id=dispatchId; state.status='ready'; delete state.question; save();
    }
    const digest=hash(JSON.stringify(op));
    if(receipts.has(op.request_id)) {
      const prior=receipts.get(op.request_id);assert(prior.digest===digest,'request_id reused with changed operation');return prior.result;
    }
    if (state.status==='needs_inspection' && !['snapshot','assert','finish'].includes(op.type)) return {status:'needs_inspection',next_action:'inspect_without_repeating_uncertain_mutation_then_finish_partial'};
    if (state.status==='waiting_human' && op.type!=='finish') return {status:'waiting_human',question:state.question,next_action:'return_to_controller_preserve_browser'};
    assert(!closed,'Browser is closed');
    if(op.type==='assert') assert(!cases.some(c=>c.case_id===op.case_id),'Use a unique case_id for each actual assertion');
    if(op.assertion) assert(!cases.some(c=>c.case_id===op.assertion.case_id),'Use a unique case_id for each actual assertion');
    if(op.type==='api_check') assert(!cases.some(c=>c.case_id===op.check.case_id),'Use a unique case_id for each actual assertion');
    for(const check of [op.type==='assert'?op:null,op.assertion,op.response_check,op.check].filter(Boolean)) {
      assertBrowserDesignCheck(dir,load(resolve(dir,'manifest.json')),check);
      if(check.case_ref) {resolveCaseReference(check.case_ref,path=>readRunFile(dir,path));if(!evidence.includes(check.case_ref.source_path)) evidence.push(check.case_ref.source_path);}
    }
    if(op.recheck_of) {
      const earlier=cases.find(row=>row.case_id===op.recheck_of);
      assert(earlier?.verification_scope?.layer==='ui' && earlier.expected===scrub(op.expected),'Recheck must refer to an earlier UI assertion with the same expectation');
      assert(!['simulated','simulation_affected'].includes(earlier.evidence_mode) && !state.simulation_context,'Simulation observations cannot become real rechecks; retain their original evidence');
      assert(earlier.check_fingerprint===uiCheckFingerprint(op),'Recheck must preserve target and condition; changed checks are separate assertions');
      assert(JSON.stringify(earlier.case_ref ?? null)===JSON.stringify(resolveCaseReference(op.case_ref,path=>readRunFile(dir,path))),'Recheck must keep its original case reference');
    }
    let dataRow=null;
    if(op.data_effect) {
      assert(scrub(JSON.stringify(op.data_effect))===JSON.stringify(op.data_effect),'Do not put known credentials in tracking metadata');
      try {dataRow=ownedDataForEffect(dataLedger,op.data_effect);}
      catch {return {status:'data_tracking_unavailable',operation_started:false,next_action:'preserve_record_report_residuals_continue_other_work_no_retry_or_unannotated_bypass'};}
    }
    if(op.response_check) {
      assert(!cases.some(c=>c.case_id===op.response_check.case_id) && op.assertion?.case_id!==op.response_check.case_id,'Use a unique case_id for each actual assertion');
      const check=op.response_check,source=readRunFile(dir,check.source_path).data.toString('utf8'),url=new URL(check.url);
      assert(source.includes(check.quote),'Response check needs a verbatim supplied contract excerpt');
      assert(url.origin===state.origin && (source.includes(url.href) || network.some(e=>e.origin===url.origin && e.path_sha256===hash(url.pathname) && e.method===check.method)), 'Response endpoint must be supplied or observed and same-origin; never guess endpoints');
    }
    for(const check of [op.type==='api_check'?op.check:null,op.fault].filter(Boolean)) {
      const source=readRunFile(dir,check.source_path),url=new URL(check.url);
      assert(source.data.toString('utf8').includes(check.quote),'Current source quote required for API or simulation scope');
      assert(url.origin===state.origin && (source.data.toString('utf8').includes(url.href) || network.some(e=>e.origin===url.origin && e.path_sha256===hash(url.pathname) && e.method===check.method)),'Use a supplied or observed same-origin endpoint, never guessed');
      if(!evidence.includes(check.source_path)) evidence.push(check.source_path);
    }
    if(op.type==='fill' && op.secret) secrets.add(op.value);
    const recordPath=`execution/browser-evidence/${op.request_id}.json`;
    const started={request_id:op.request_id,operation:op.type,command_id:commandId,dispatch_id:dispatchId,status:'started',at:new Date().toISOString(),request_sha256:digest};
    mkdirSync(resolve(dir,'execution/browser-evidence'),{recursive:true});
    writeFileSync(resolve(dir,recordPath),JSON.stringify(started),{flag:'wx'});
    // A started receipt is written before side effects; lost connections must not duplicate submissions.
    receipts.set(op.request_id,{digest,result:{status:'in_progress',request_id:op.request_id}});
    let result, actionStarted=false, actionCompleted=false, phase=op.type, feedbackHandle=null, feedbackSetupError, responseObserver, dataStarted=false, faultSession=null, faultProof=null;
    try {
      if(op.type==='start') {
        assert(!browser && state.status==='starting','Browser already started');
        const source=readRunFile(dir,op.source_path), target=validateExplorationTarget(op.url,op.source_path,source.data.toString('utf8'));
        Object.assign(state,{dispatch_id:dispatchId,scope:op.scope,source_path:op.source_path,source_sha256:source.sha256,origin:target.origin,status:'ready'});save();
        browser=await chromium.launch({headless:op.headless ?? false,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
        context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',acceptDownloads:false});
        await context.routeWebSocket('**/*',socket=>socket.close());
        await context.route('**/*',async route=>{
          const req=route.request();
          let frameOrigin;try {frameOrigin=new URL(req.frame().url()).origin;} catch { /* No trusted frame. */ }
          const decision=browserRequestPolicy({url:req.url(),origin:state.origin,frameOrigin,resourceType:req.resourceType(),method:req.method()});
          recordNetwork(req,{event:'request',decision});
          if(decision.startsWith('blocked_')) {state.blocked_requests++;return route.abort('blockedbyclient');}
          if(activeFault && await activeFault.intercept(route,page)) return;
          return route.continue();
        });
        context.on('requestfailed',req=>recordNetwork(req,{event:'failed',diagnostic:browserErrorDiagnostic(req.failure()?.errorText,'network')}));
        context.on('response',response=>recordNetwork(response.request(),{event:'response',http_status:response.status()}));
        page=await context.newPage();page.setDefaultTimeout(8000);
        page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
        context.on('page',popup=>{if(popup!==page) popup.close().catch(()=>{});});
        await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:25000});
        result={status:'ready',navigation_observation:await waitForBrowserContent(page),snapshot:await snapshot()};
      } else if(op.type==='api_check') {
        const check=op.check,detail=await runReadOnlyApiCheck(page,check),path=`execution/browser-evidence/${op.request_id}.api.json`;
        writeJson(resolve(dir,path),{...detail,mode:'real_api',method:check.method,endpoint_sha256:hash(new URL(check.url).pathname),source_path:check.source_path,source_sha256:readRunFile(dir,check.source_path).sha256,observed_at:new Date().toISOString()});evidence.push(path);
        const row={case_id:check.case_id,title:scrub(check.title),expected:scrub(check.expected),status:detail.status,evidence_mode:'real',failure_category:detail.status==='passed'?'none':'needs_review',actual_result:detail.reason ?? `HTTP matched=${detail.http_matched}; business value matched=${detail.business_matched ?? 'not_checked'}`,verification_scope:{layer:'api_contract',does_not_prove:['ui_behavior','persistent_storage','absence_of_side_effects']},evidence_paths:[recordPath,path]};
        if(check.case_ref) row.case_ref=resolveCaseReference(check.case_ref,p=>readRunFile(dir,p));
        cases.push(row);result={status:state.status,response_assertion:row};
      } else if(op.type==='data_prepare') {
        assert(page && state.status==='ready','Start the browser task before preparing a data marker');
        const row=prepareOwnedData(dataLedger,op.key,op.request_id);saveData();
        result={status:state.status,data:{key:row.key,marker:row.marker,status:row.status},next_action:'Use marker only in an appropriate non-sensitive test field; preparation creates no product data and grants no cleanup permission'};
      } else if(op.type==='snapshot') result={status:state.status,snapshot:await snapshot(),...await capture(op.request_id)};
      else if(op.type==='goto') {
        const target=validateExplorationTarget(op.url,op.source_path,readRunFile(dir,op.source_path).data.toString('utf8'));
        assert(target.origin===state.origin,'Cross-origin navigation needs a separate explicitly scoped task');
        lastAction=null;
        await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:25000});state.simulation_context=false;result={status:'ready',navigation_observation:await waitForBrowserContent(page),snapshot:await snapshot()};
      } else if(op.type==='pause') {
        assert(page && !closed,'No browser available for human interaction');
        Object.assign(state,{status:'waiting_human',question:scrub(op.question),human_kind:op.kind,waiting_at:new Date().toISOString(),waiting_command_id:commandId});
        result={status:'waiting_human',kind:op.kind,question:state.question,...await capture(op.request_id),next_action:'return_to_controller_preserve_browser'};
      } else if(op.type==='finish') {
        const cleanup=summarizeDataLedger(dataLedger);
        let incomplete=['waiting_human','needs_inspection','starting'].includes(state.status) || !cases.length || cases.some(row=>row.status==='blocked');
        const currentManifest=load(resolve(dir,'manifest.json'));
        if(browserLifecycle(currentManifest)) incomplete ||= browserCoverage(dir,currentManifest,{cases}).untested_cases.length>0;
        await browser?.close();closed=true;state.status='closed';state.finished_at=new Date().toISOString();
        const summary={total:cases.length,...Object.fromEntries(['passed','failed','blocked','skipped'].map(s=>[s,cases.filter(c=>c.status===s).length]))};
        const statistics=summarizeExecutionCounts(cases,{interactive:true,readSource:path=>readRunFile(dir,path)});
        const results={run_id:runId,invocation_id:state.invocation_id,started_at:state.started_at,finished_at:state.finished_at,status:incomplete?'partial':'completed',summary,cases,statistics};
        writeJson(resolve(dir,'execution/test_results.json'),results);
        const paths=[...evidence,'execution/test_results.json',...(existsSync(resolve(dir,'execution/browser-network.json'))?['execution/browser-network.json']:[])];
        const manifest=load(resolve(dir,'manifest.json'));
        if(browserLifecycle(manifest)) {
          writeJson(resolve(dir,'execution/browser-coverage.json'),browserCoverage(dir,manifest,results));
          paths.push('execution/browser-coverage.json');
        }
        const observation={...state,mode:'interactive_browser',command_id:commandId,summary:scrub(op.summary),cleanup,limitations:[...op.limitations.map(scrub),...(cleanup.possible_residuals?[`Tracked test data may remain: ${cleanup.possible_residuals}. See ${dataLedgerPath}; do not repeat uncertain cleanup.`]:[]),...(state.capture_warnings?[`Screenshots unavailable for ${state.capture_warnings} operations; use retained structured observations.`]:[]),'Application-initiated HTTP APIs supported; new cross-origin documents, popups, downloads and WebSockets are not supported.'],partial:incomplete,evidence:paths.map(p=>({path:p,sha256:readRunFile(dir,p).sha256}))};
        writeJson(resolve(dir,'execution/exploration.json'),observation);
        result={status:'closed',partial:incomplete,summary,statistics,cleanup,artifacts:['execution/exploration.json','execution/test_results.json',...(dataLedger.items.length?[dataLedgerPath]:[])],exploration_sha256:readRunFile(dir,'execution/exploration.json').sha256};
      } else {
        const target=locator(op.target);
        if(op.type==='assert') {
          result={status:state.status,...await recordAssertion(op,op.request_id,recordPath)};
        } else {
          for(const [index,check] of (op.preconditions ?? []).entries()) {
            try {await expectResult(check,1500);}
            catch {throw new Error(`Precondition not satisfied: ${index}`);}
          }
          assert(await target.count()===1,'Target not uniquely visible; inspect snapshot and correct locator without asking the user');
          if(dataRow) {
            const record=locator(op.data_effect.record_target);
            if(op.data_effect.kind==='create') {
              assert(await record.count()===0,'Data identity already exists; never adopt or overwrite it');
              assert(op.preconditions?.some(c=>c.condition==='value' && c.value===dataRow.marker),'Check the prepared marker in the actual creation input before submitting');
            } else {
              assert(await record.count()===1 && await record.isVisible() && (await record.innerText()).includes(dataRow.marker),'Cleanup identity is missing, ambiguous or changed; preserve data');
              assert(dataRow.identity?.sha256===(await recordIdentity(record)).sha256,'Record DOM identity changed; preserve data instead of guessing ownership');
              const handle=await target.elementHandle();
              try {assert(handle && await record.evaluate((node,control)=>node!==control && !['HTML','BODY'].includes(node.tagName) && node.contains(control),handle),'Cleanup control must be inside the recorded single-record container');}
              finally {await handle?.dispose();}
            }
          }
          if(op.assertion) {
            let alreadyMatched=false;
            try { await expectResult(op.assertion,1);alreadyMatched=true; }
            catch(error) {
              if(['browser_unavailable','navigation_changed'].includes(browserErrorDiagnostic(error,'assert').category)) throw error;
            }
            assert(!alreadyMatched,'Expected result already present before action; observe a fresh result without repeating the submission');
          }
          const unchanged=op.type==='check' && await target.isChecked()===op.checked;
          assert(unchanged || await target.isVisible(),'Target not uniquely visible; inspect snapshot and correct locator without asking the user');
          if(op.type==='fill' && await target.getAttribute('type')==='password') secrets.add(op.value);
          if(['click','press'].includes(op.type)) {
            try {feedbackHandle=await beginDynamicFeedback(page);}
            catch(error) {feedbackSetupError=browserErrorDiagnostic(error,'dynamic_feedback_setup');}
          }
          if(op.response_check) responseObserver=observeBusinessResponse(page,op.response_check);
          if(op.fault) {faultSession=createOneShotFault(op.fault);activeFault=faultSession;state.simulation_context=true;}
          if(dataRow) {beginDataEffect(dataRow,op.data_effect,op.request_id);saveData();dataStarted=true;}
          actionStarted=!unchanged;
          if(op.type==='fill') await target.fill(op.value);
          if(op.type==='click') await target.click();
          if(op.type==='press') await target.press(op.key);
          if(op.type==='select') await target.selectOption(op.value);
          if(op.type==='check' && !unchanged) await target.setChecked(op.checked);
          actionCompleted=!unchanged;phase='post_action_snapshot';
          lastAction={request_id:op.request_id,type:op.type,completed_at:new Date().toISOString()};
          result={status:'ready',...(unchanged?{unchanged:true}:{}),...(op.assertion?await recordAssertion(op.assertion,op.request_id,recordPath,lastAction):{}),snapshot:await snapshot(),
            ...(['click','press'].includes(op.type) && !op.assertion?{assertion_guidance:'Action performed without an assertion. Use dynamic_feedback as observed changes, not a passing case. Do not replay to add evidence. Candidate selectors were observed at their timestamps and may now be stale; never invent CSS or replace dynamic feedback with static labels.'}:{})};
        }
      }
    } catch(error) {
      if(actionStarted && !actionCompleted) state.status='needs_inspection';
      const diagnostic={...browserErrorDiagnostic(error,phase),page_closed:page?.isClosed() ?? null,browser_connected:browser?.isConnected() ?? null};
      if(diagnostic.category==='browser_unavailable') state.status='needs_inspection';
      result={status:state.status==='needs_inspection'?'needs_inspection':actionCompleted?'observation_unavailable':'correctable_error',action_completed:actionCompleted,diagnostic,...browserRecoveryHint(diagnostic.category),...(state.status==='needs_inspection'?{next_action:'inspect_result_no_automatic_mutation_retry'}:{})};
      if(String(error.message).startsWith('Precondition not satisfied:')) result={...result,status:'precondition_not_met',operation_started:false,next_action:'inspect_and_prepare_required_state_no_product_failure',precondition_index:Number(error.message.split(':')[1])};
    } finally {
      if(faultSession) {try {faultProof=await faultSession.finish(actionCompleted);} finally {activeFault=null;}}
    }
    if(op.fault) {
      const path=`execution/browser-evidence/${op.request_id}.fault.json`;
      const proof=faultProof ?? {mode:op.fault.mode,matched_requests:0,applied:false,disabled:true};
      writeJson(resolve(dir,path),{...proof,source_path:op.fault.source_path,source_sha256:readRunFile(dir,op.fault.source_path).sha256,endpoint_sha256:hash(new URL(op.fault.url).pathname)});evidence.push(path);
      result.simulation={...proof,evidence_path:path};
      if(result.assertion) {
        result.assertion.evidence_mode='simulated';result.assertion.simulation=proof;result.assertion.evidence_paths.push(path);
        result.assertion.failure_category='needs_review';
        if(!proof.applied) {result.assertion.status='blocked';result.assertion.actual_result='Requested simulation was not confirmed; UI observation does not validate the fault scenario';}
      }
    }
    if(dataStarted) {
      let observed=false;
      if(actionCompleted) try {
        const record=locator(op.data_effect.record_target);
        await expect(record).toHaveCount(op.data_effect.kind==='create'?1:0,{timeout:3000});
        if(op.data_effect.kind==='create') {await expect(record).toBeVisible({timeout:1000});await expect(record).toContainText(dataRow.marker,{timeout:1000});dataRow.identity=await recordIdentity(record);}
        observed=true;
      } catch { /* Preserve uncertain writes and cleanup; never retry them to improve evidence. */ }
      result.test_data={...completeDataEffect(dataRow,op.data_effect,observed),...(!observed?{next_action:'preserve_record_report_uncertainty_continue_other_work_no_retry'}:{})};saveData();
    }
    if(responseObserver) {
      if(actionCompleted) {
        const detail=await responseObserver.finish(),check=op.response_check;
        const path=`execution/browser-evidence/${op.request_id}.response.json`;
        const proof={...detail,layer:'api_contract',observed_at:new Date().toISOString(),endpoint_sha256:hash(new URL(check.url).pathname),source_path:check.source_path,source_sha256:readRunFile(dir,check.source_path).sha256,
          interpretation:'Matching response during this action window, not causal proof or persistent-storage verification. No raw body, headers or business values retained.'};
        writeJson(resolve(dir,path),proof);evidence.push(path);if(!evidence.includes(check.source_path)) evidence.push(check.source_path);
        const row={case_id:check.case_id,title:scrub(check.title),expected:scrub(check.expected),status:detail.status,evidence_mode:'real',failure_category:detail.status==='passed'?'none':'needs_review',actual_result:detail.reason ?? `HTTP matched=${detail.http_matched}; business value matched=${detail.business_matched}`,verification_scope:{layer:'api_contract',does_not_prove:['persistent_storage','absence_of_side_effects']},evidence_paths:[recordPath,path]};
        if(check.case_ref) row.case_ref=resolveCaseReference(check.case_ref,path=>readRunFile(dir,path));
        cases.push(row);result.response_assertion=row;
      } else responseObserver.cancel();
    }
    if(feedbackHandle || feedbackSetupError) {
      const feedback=feedbackHandle?await endDynamicFeedback(feedbackHandle):{status:'unavailable',candidates:[],diagnostic:feedbackSetupError};
      const redact=value=>typeof value==='string'?scrub(value):Array.isArray(value)?value.map(redact):value && typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v)])):value;
      const clean=redact(feedback);
      const path=`execution/browser-evidence/${op.request_id}.feedback.json`;
      result.dynamic_feedback={...clean,request_id:op.request_id,action_completed:actionCompleted,evidence_path:path,interpretation:'Observed visible text changes during this operation, possibly including background updates. Not an assertion, causal proof, or business success. Selectors describe the DOM at observation time, not a promise they still exist. Empty or truncated observations do not prove no feedback. Never replay a submission to improve evidence.'};
      writeJson(resolve(dir,path),result.dynamic_feedback);evidence.push(path);
    }
    result.network_summary={blocked_requests:state.blocked_requests,evidence:'execution/browser-network.json',recent_errors_scope:'session_history_not_causal',interpretation:'Events during an operation may include background requests. HTTP status is not a business result; neither association nor independence proves causality.',operation_events:network.filter(e=>e.at>=started.at && (['xhr','fetch'].includes(e.resource_type) || e.event==='failed' || e.http_status>=400)).slice(-20),recent_errors:network.filter(e=>e.event==='failed' || e.http_status>=400 || e.decision?.startsWith('blocked_')).slice(-6)};
    const final={...started,status:'completed',result};
    writeJson(resolve(dir,recordPath),final);evidence.push(recordPath);
    if(result.screenshot) evidence.push(result.screenshot);
    save();receipts.set(op.request_id,{digest,result});
    return result;
  }
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST' || req.url!=='/operation' || req.headers.authorization!==`Bearer ${token}`) {res.writeHead(403);res.end();return;}
    if(busy) {res.writeHead(409);res.end();return;}
    busy=true;lastActivity=Date.now();
    let rawRequest='';
    try {
      for await(const chunk of req) {rawRequest+=chunk;assert(rawRequest.length<100000,'Request too large');}
      const result=await perform(JSON.parse(rawRequest));res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
      if(closed) setTimeout(()=>server.close(),1000);
    } catch(error) {
      // Only absence of a started receipt proves rejection before execution.
      // Errors after a started action must remain uncertain, including disk failures.
      let op;try {op=JSON.parse(rawRequest).operation;} catch { /* Malformed request. */ }
      const started=op?.request_id && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(op.request_id) && existsSync(resolve(dir,'execution/browser-evidence',`${op.request_id}.json`));
      res.writeHead(started?500:400);
      res.end(JSON.stringify(started?{status:'operation_outcome_unknown'}:{status:'invalid_operation',operation_started:false,
        diagnostic:{category:/unique case_id/.test(String(error.message))?'duplicate_case_id':'request_rejected'},
        next_action:/unique case_id/.test(String(error.message))?'inspect_existing_case_use_unique_case_id_for_distinct_check':'correct_request_without_product_retry'}));
    }
    finally {busy=false;lastActivity=Date.now();}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  // The command process polls this file while the worker publishes its port.
  writeJson(privatePath(dir),{token,port:server.address().port,pid:process.pid},{mode:0o600});
  const timer=setInterval(async()=>{
    if(!busy && Date.now()-lastActivity>60*60*1000) {closed=true;await browser?.close();state.status='expired';save();server.close();}
  },10000);timer.unref();
  server.on('close',()=>{clearInterval(timer);if(existsSync(privatePath(dir))) unlinkSync(privatePath(dir));});
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const root=resolve(import.meta.dirname,'..');
  if(process.argv[2]==='--worker') await worker(root,process.argv[3]);
  else {
    const [runId,path]=process.argv.slice(2);
    const operation=JSON.parse(readFileSync(path,'utf8'));
    console.log(JSON.stringify(await browserTaskCommand(root,runId,operation)));
  }
}
