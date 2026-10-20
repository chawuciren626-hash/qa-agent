import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const app=process.argv[2];
if(!app) throw Error('Usage: <installed resources/app>');
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'output/playwright/human-action');
mkdirSync(out,{recursive:true});
const preview=spawn(process.execPath,[resolve(root,'scripts/preview-client-ui.mjs'),app,'0'],{cwd:root,env:{...process.env,QA_PREVIEW_HUMAN_CARD:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser;
try {
  const url=await new Promise((done,reject)=>{
    let text='';const timer=setTimeout(()=>reject(Error('Preview startup timeout')),20000);
    preview.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);done(match[0]);}});
    preview.once('error',error=>{clearTimeout(timer);reject(error);});
    preview.once('exit',code=>{clearTimeout(timer);reject(Error(`Preview exited ${code}`));});
  });
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const requests=[];page.on('request',request=>{if(request.method()==='POST' && request.url().endsWith('/human-actions'))requests.push(request.postDataJSON());});
  await page.goto(url+'/chat/preview-history');
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('region',{name:'人工操作'})).toBeVisible();
    await expect(page.locator('.qa-session-context')).toContainText('等待人工操作');
    await expect(page.locator('.qa-session-context')).not.toContainText('本轮已完成');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const box=await page.locator('.qa-human-card').boundingBox();assert.ok(box.x>=0 && box.x+box.width<=viewport.width+1);
    await page.screenshot({path:resolve(out,`waiting-${viewport.width}.png`),fullPage:true});
  }
  await page.getByRole('button',{name:'继续等待',exact:true}).click();
  await expect(page.getByRole('button',{name:'已完成登录，继续测试',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'已完成登录，继续测试',exact:true}).evaluate(button=>{button.click();button.click();});
  await expect(page.getByRole('button',{name:'已完成登录，继续测试',exact:true})).toBeDisabled();
  await expect(page.locator('.qa-human-card')).toContainText('正在续接原任务');
  assert.equal(requests.filter(r=>r.decision==='continue').length,1);assert.equal(requests.filter(r=>r.decision==='wait').length,1);assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(out,'accepted-mobile.png'),fullPage:true});
  writeFileSync(resolve(out,'result.json'),JSON.stringify({status:'passed',synthetic_api_only:true,viewports:[1280,390],continue_posts:1,wait_posts:1,page_errors:errors},null,2));
  console.log(JSON.stringify({status:'passed',output:out,synthetic_api_only:true}));
} finally {
  await browser?.close();
  if(preview.exitCode===null){preview.kill();await new Promise(done=>preview.once('exit',done));}
}
