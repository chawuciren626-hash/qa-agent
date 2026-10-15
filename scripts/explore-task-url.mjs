import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { readRunFile, runDirectory } from './design-quality.mjs';
import { writeJson } from './orchestration-state.mjs';

export function validateExplorationTarget(url,sourcePath,sourceText) {
  const target=new URL(url);
  if(!['http:','https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP(S) URL without embedded credentials');
  const name=/^inputs\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(sourcePath)?.[1];
  if(!name || (name.includes('.') && !/\.(txt|md|json)$/i.test(name))) throw new Error('URL source must be archived text/Markdown/JSON input (extensionless text is supported)');
  if(typeof sourceText!=='string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(sourceText)) throw new Error('URL source must contain readable UTF-8 text, not a binary attachment');
  const urls=sourceText.match(/https?:\/\/[^\s<>"'`]+/g) ?? [];
  const candidates=urls.flatMap(value=>value.split(/\]\(/)).flatMap(value=>[value,value.replace(/[\]),，。；;]+$/,'')]);
  // Recognize adjacent prose without altering archived text or truncating Chinese URL paths.
  for(const value of [...candidates]) {
    const boundary=value.search(/[，。；、]|(?:帮我|请你|请)(?:测|测试|检查|查看|打开|访问|验证|分析)/u);
    if(boundary>0) candidates.push(value.slice(0,boundary));
  }
  if(!candidates.some(value=>{try{return new URL(value).href===target.href;}catch{return false;}})) throw new Error('Target URL is not present in the supplied source; do not guess an environment');
  return target;
}

export async function exploreTaskUrl(root,runId,url,sourcePath) {
  const dir=runDirectory(root,runId);
  if(existsSync(resolve(dir,'execution/browser-state.json'))) throw new Error('Interactive browser already belongs to this run; use browser_task snapshot/goto/finish instead of explore_url');
  const manifest=JSON.parse(readRunFile(dir,'manifest.json').data);
  const commandId=process.env.QA_TASK_COMMAND_ID;
  if(!/^[a-f0-9-]{36}$/.test(commandId ?? '')) throw new Error('Use the controlled explore_url action, not a direct script');
  const dispatch=manifest.orchestration?.events?.filter(e=>e.type==='dispatched' && e.stage==='execution').at(-1);
  if(manifest.orchestration?.plan?.workflow_mode!=='task' || manifest.stages?.execution?.status!=='in_progress' || !dispatch?.dispatch_id) throw new Error('URL exploration requires an active independent execution task');
  const source=readRunFile(dir,sourcePath);
  const target=validateExplorationTarget(url,sourcePath,source.data.toString('utf8'));
  if(existsSync(resolve(dir,'execution/exploration.json'))) throw new Error('This exploration already has a result. Do not silently rerun product requests');
  const lock=resolve(dir,'execution/exploration.lock');
  writeFileSync(lock,JSON.stringify({pid:process.pid,dispatch_id:dispatch.dispatch_id}),{flag:'wx'});
  const invocation=randomUUID(), evidenceDir=`execution/explorations/${invocation}`;
  mkdirSync(resolve(dir,evidenceDir),{recursive:true});
  const started=new Date().toISOString();let browser;
  const observation={version:1,run_id:runId,command_id:commandId,dispatch_id:dispatch.dispatch_id,invocation_id:invocation,mode:'read_only_navigation',source_path:sourcePath,source_sha256:source.sha256,target_url:target.href,started_at:started,http_status:null,final_url:null,title:null,structure:null,blocked_requests:0,page_errors:0,error:null,
    limitations:['Single-page GET navigation only; no clicks, submissions, login, business mutations or business-flow assertions.', 'Non-GET requests and cross-origin document navigation are blocked; applications needing these may render incompletely.']};
  let screenshot;
  try {
    browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',acceptDownloads:false});
    await context.routeWebSocket('**/*',socket=>{observation.blocked_requests++;socket.close();});
    await context.route('**/*',async route=>{
      const request=route.request();const destination=new URL(request.url());
      if(!['GET','HEAD'].includes(request.method()) || (request.isNavigationRequest() && destination.origin!==target.origin)) {observation.blocked_requests++;return route.abort('blockedbyclient');}
      return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',()=>observation.page_errors++);
    const response=await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:30000});
    observation.http_status=response?.status() ?? null;observation.final_url=page.url();observation.title=await page.title();
    observation.structure=await page.evaluate(()=>({
      headings:[...document.querySelectorAll('h1,h2,h3')].slice(0,40).map(e=>e.textContent.trim()),
      fields:[...document.querySelectorAll('input,textarea,select')].slice(0,80).map(e=>({tag:e.tagName,type:e.type,name:e.name,label:e.getAttribute('aria-label') || e.placeholder || ''})),
      buttons:[...document.querySelectorAll('button,[role="button"]')].slice(0,60).map(e=>e.textContent.trim()),
      link_count:document.querySelectorAll('a[href]').length
    }));
    screenshot=`${evidenceDir}/page.png`;await page.screenshot({path:resolve(dir,screenshot),timeout:10000});
  } catch(error) {observation.error=String(error.message).slice(0,1500);}
  finally {if(browser) await browser.close();}
  observation.finished_at=new Date().toISOString();
  const path=`${evidenceDir}/observation.json`;writeJson(resolve(dir,path),observation);
  const state=observation.error?'blocked':observation.http_status>=200 && observation.http_status<400?'passed':'failed';
  const cases=[{case_id:'URL-REACHABILITY-001',title:'目标页面可达性（不是业务全流程）',status:state,actual_result:observation.error ?? `HTTP ${observation.http_status}; ${observation.page_errors} page errors; ${observation.blocked_requests} requests blocked by read-only policy`,evidence_paths:[path,...(screenshot && existsSync(resolve(dir,screenshot))?[screenshot]:[])]}];
  const summary={total:1,passed:0,failed:0,blocked:0,skipped:0};summary[state]=1;
  const result={run_id:runId,invocation_id:invocation,status:state==='passed'?'completed':state,started_at:started,finished_at:observation.finished_at,summary,cases};
  writeJson(resolve(dir,'execution/test_results.json'),result);
  const refs=[path,...cases[0].evidence_paths.slice(1),'execution/test_results.json'].map(p=>{const f=readRunFile(dir,p);return {path:p,sha256:f.sha256};});
  writeJson(resolve(dir,'execution/exploration.json'),{...observation,evidence:refs});
  unlinkSync(lock);
  return {run_id:runId,scope:'single_page_read_only',status:state,exploration_sha256:readRunFile(dir,'execution/exploration.json').sha256,artifacts:['execution/exploration.json','execution/test_results.json'],limitations:observation.limitations};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [runId,url,sourcePath]=process.argv.slice(2);
  console.log(JSON.stringify(await exploreTaskUrl(resolve(import.meta.dirname,'..'),runId,url,sourcePath)));
}
