import { createServer } from 'node:http';
import { readFileSync,mkdirSync,existsSync,writeFileSync } from 'node:fs';
import { resolve,extname,relative } from 'node:path';
import { chromium,expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { patchDeliveryBundle } from './install-penguin-delivery-ui.mjs';
import { patchClientBundle, clientModule } from './client-ui-patches.mjs';

const [app,workspace,runId,output]=process.argv.slice(2);
if(!app || !workspace || !/^run-[a-z0-9-]+$/i.test(runId??'') || !output) throw new Error('Usage: <resources/app> <session workspace> <existing run-id> <engineering screenshot directory>');
const web=resolve(app,'web-dist'),root=resolve(import.meta.dirname,'..'),out=resolve(output);
mkdirSync(out,{recursive:true});
const index=readFileSync(resolve(web,'index.html'),'utf8');
const asset=index.match(/src="\/assets\/([^"/?]+\.js)(?:\?[^" ]*)?"/)[1],css=index.match(/href="(\/assets\/[^"/]+\.css)"/)[1];
const bundlePath=resolve(web,'assets',asset);
const original=readFileSync(existsSync(bundlePath+'.qa-runtime-original')?bundlePath+'.qa-runtime-original':existsSync(bundlePath+'.qa-delivery-original')?bundlePath+'.qa-delivery-original':bundlePath,'utf8');
let bundle=patchClientBundle(patchDeliveryBundle(original));
const mount='Cke();Ske().then(e=>{e==="reload"?location.reload():RM()},RM);';
assert.equal(bundle.split(mount).length,2);
bundle=bundle.replace(mount,'')+'\nfunction QaHarness(props){return r.jsx(oB,{children:r.jsx(xB,{children:r.jsx(Ale,props)})});} export {eB,r as qaJSX,QaHarness as Ale};';
const report=`output/runs/${runId}/report/test_report.html`,sheet=`output/runs/${runId}/report/test_cases.xlsx`,pdf=`output/runs/${runId}/report/test_report.pdf`;
for(const path of [report,sheet,pdf]) assert.ok(existsSync(resolve(workspace,path)),path);
const sample=`已生成测试用例与报告。以下为已有产物，不代表本次重新执行了产品测试。\n\n[测试报告](<${report}>) · [测试用例 Excel](<${sheet}>) · [测试报告 PDF](<${pdf}>)`;
const items=[{kind:'assistant_text',id:'before',text:'子代理交付后核对合同，登记阶段 dispatch_id=synthetic.'},{kind:'thinking',id:'thinking',thinking:'Synthetic engineering details',streaming:false},{kind:'assistant_text',id:'final',text:sample,streaming:false,stopReason:'completed'}];
// A synthetic completed tool establishes a structural intermediate-message boundary.
items.splice(2,0,{kind:'tool_call',id:'tool',toolCallId:'fixture-tool',name:'read_file',argumentsText:'{}',output:'Synthetic evidence only',callComplete:true,outputComplete:true,outputStopReason:'completed'});
let missing=false,nativeStatus=403;const actions=[];
const mime={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html','.pdf':'application/pdf','.woff2':'font/woff2','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  try {
    const u=new URL(req.url,'http://localhost');
    if(u.pathname==='/') {res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><html data-qa-client="v2"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"><style>${readFileSync(resolve(root,'penguin/ui/workspace-ui.css'),'utf8')}</style></head><body><div id="root" hidden></div><main id="qa" style="padding:16px;max-width:960px;margin:auto"></main><aside aria-label="产物预览" hidden><button id="close-preview">关闭预览</button><iframe title="交付预览" sandbox="allow-scripts" style="width:100%;height:75vh;border:0"></iframe></aside><script type="module" src="/fixture.mjs"></script></body></html>`);return;}
    if(u.pathname==='/fixture.mjs') {res.setHeader('content-type','text/javascript');res.end(`import {eB,qaJSX as r,Ale} from '/assets/qa-test-bundle.js';const ctx={qaPresentation:true,sessionId:'fixture',workspace:${JSON.stringify(workspace)},origin:[],taskRunning:false,pendingApprovals:new Map(),statFiles:async(paths)=>{const r=await fetch('/stat',{method:'POST',body:JSON.stringify(paths)});return new Set(await r.json());},onOpenFile:path=>{document.querySelector('aside').hidden=false;document.querySelector('iframe').src='/preview?path='+encodeURIComponent(path);}};document.querySelector('#close-preview').onclick=()=>{document.querySelector('aside').hidden=true;};eB.createRoot(document.querySelector('#qa')).render(r.jsx(Ale,{items:${JSON.stringify(items)},ctx}));`);return;}
    if(u.pathname==='/stat') {let text='';for await(const c of req) text+=c;const paths=JSON.parse(text);res.setHeader('content-type','application/json');res.end(JSON.stringify(paths.filter(p=>!missing && [report,sheet,pdf].includes(p))));return;}
    if(u.pathname==='/missing') {missing=true;res.end('ok');return;}
    if(u.pathname==='/native-timeout') {nativeStatus=504;res.end('ok');return;}
    if(u.pathname==='/api/sessions/fixture/files/stat') {let text='';for await(const c of req)text+=c;res.setHeader('content-type','application/json');res.end(JSON.stringify({existing:JSON.parse(text).paths.filter(p=>!missing && [report,sheet,pdf].includes(p))}));return;}
    if(u.pathname.startsWith('/api/sessions/fixture/files/')) {actions.push(u.pathname);res.statusCode=u.pathname.endsWith('/open-deliverable')?nativeStatus:204;res.end();return;}
    if(u.pathname==='/preview') {const path=u.searchParams.get('path');if(![report,sheet,pdf].includes(path)) {res.statusCode=404;res.end();return;}res.setHeader('content-type',mime[extname(path)]??'application/octet-stream');res.setHeader('content-security-policy','sandbox allow-scripts');res.end(readFileSync(resolve(workspace,path)));return;}
    if(u.pathname==='/assets/qa-test-bundle.js') {res.setHeader('content-type','text/javascript');res.end(bundle);return;}
    if(u.pathname==='/assets/qa-delivery-ui.js') {res.setHeader('content-type','text/javascript');res.end(clientModule(...['penguin/ui/delivery-ui.mjs','penguin/ui/workspace-ui.mjs','penguin/ui/workspace-ui.css'].map(p=>readFileSync(resolve(root,p),'utf8'))));return;}
    const path=resolve(web,'.'+decodeURIComponent(u.pathname));
    if(relative(web,path).startsWith('..')) {res.statusCode=403;res.end();return;}
    res.setHeader('content-type',mime[extname(path)]??'application/octet-stream');res.end(readFileSync(path));
  } catch {res.statusCode=404;res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,channel:'chrome'});
const errors=[];let result,page;
try {
  page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);await page.getByRole('region',{name:'交付文件'}).waitFor();
  const header=page.getByRole('button',{name:/^执行详情/});
  assert.equal(await header.getAttribute('aria-expanded'),'false');
  assert.equal(await page.getByText(/子代理交付后/).count(),0);
  await header.click();assert.equal(await page.getByText(/子代理交付后/).count(),1);await header.click();
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
    await page.setViewportSize({width,height});
    await page.screenshot({path:resolve(out,`${name}.png`),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow');
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('link',{name:'测试报告',exact:true}).first().click();
  await expect.poll(async()=>(await page.frameLocator('iframe').locator('body').innerText()).length).toBeGreaterThan(100);
  await page.screenshot({path:resolve(out,'report-preview.png'),fullPage:true});
  await page.getByRole('button',{name:'关闭预览'}).click();
  await page.getByRole('link',{name:'测试报告 PDF',exact:true}).first().click();
  await expect(page.locator('iframe')).toHaveAttribute('src',/pdf/);
  await page.getByRole('button',{name:'关闭预览'}).click();
  await page.getByRole('link',{name:'测试用例 Excel',exact:true}).first().click();
  await page.getByRole('alert').filter({hasText:'本机打开仅支持桌面应用'}).waitFor();
  assert.ok(actions.some(a=>a.endsWith('/open-deliverable')));
  await page.request.get(origin+'/native-timeout');
  await page.getByRole('link',{name:'测试用例 Excel',exact:true}).first().click();
  await page.getByRole('alert').filter({hasText:'打开超时，请先查看桌面'}).waitFor();
  assert.equal(actions.filter(a=>a.endsWith('/open-deliverable')).length,2);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve(out,'timeout-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.request.get(origin+'/missing');
  await page.getByRole('link',{name:'测试报告',exact:true}).first().click();
  await page.getByRole('alert').filter({hasText:'文件不存在或已移动'}).waitFor();
  assert.deepEqual(errors,[]);
  result={status:'passed',scope:'real installed React/Markdown/group components with synthetic chat, actual existing artifacts, no product test executed',viewports:['1440x1000','390x844'],checks:['collapsed intermediate messages','expandable details','real HTML report preview','PDF preview route','native open click and browser-only refusal','native timeout feedback without retry','missing-file feedback','no overflow','no browser errors'],native_os_launch_verified:false};
  writeFileSync(resolve(out,'verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} catch(error) {
  console.log(JSON.stringify({status:'failed',page_errors:errors,message:error.message}));
  await page?.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});
  throw error;
} finally {await browser.close();await new Promise(done=>server.close(done));}
