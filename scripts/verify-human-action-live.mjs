import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const [session,fixtureUrl]=process.argv.slice(2);
if(!/^session-[0-9a-f-]+$/.test(session??'') || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(fixtureUrl??'')) throw Error('Use only an explicit engineering session and local fixture URL');
const token=readFileSync(resolve(homedir(),'.penguin/data/api-token'),'utf8').trim();
const origin='http://localhost:59764',headers={authorization:`Bearer ${token}`};
const out=resolve(import.meta.dirname,'../output/playwright/human-action-live',session);mkdirSync(out,{recursive:true});
const before=await(await fetch(`${origin}/api/sessions/${session}/human-actions`,{headers})).json();
assert.equal(before.actions.length,1);assert.equal(before.actions[0].status,'waiting_human');
assert.equal((await(await fetch(fixtureUrl+'state')).json()).prepared,1);
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*',route=>{
    const request=route.request();
    return route.continue({headers:new URL(request.url()).origin===origin?{...request.headers(),...headers}:request.headers()});
  });
  await page.goto(`${origin}/chat/${session}`);
  await expect(page.getByRole('region',{name:'人工操作'})).toBeVisible({timeout:20000});
  await expect(page.locator('.qa-session-context')).toContainText('等待人工操作');
  await page.screenshot({path:resolve(out,'waiting.png'),fullPage:true});
  await page.getByRole('button',{name:'继续等待',exact:true}).click();
  await expect(page.getByRole('button',{name:'已完成登录，继续测试',exact:true})).toBeEnabled();
  const login=await fetch(fixtureUrl+'fixture-confirm',{method:'POST',headers:{'x-qa-fixture-test':'1'}});assert.equal(login.status,200);
  const response=page.waitForResponse(r=>r.url().endsWith('/human-actions') && r.request().method()==='POST');
  await page.getByRole('button',{name:'已完成登录，继续测试',exact:true}).click();
  const accepted=await response;assert.equal(accepted.status(),200);const result=await accepted.json();assert.equal(result.status,'accepted');
  await page.screenshot({path:resolve(out,'accepted.png'),fullPage:true});
  writeFileSync(resolve(out,'result.json'),JSON.stringify({status:'confirmation_sent',native_host:true,synthetic_login:true,session,before:before.actions[0],result},null,2));
  console.log(JSON.stringify({status:'confirmation_sent',child:result.child_session,output:out}));
} finally {await browser.close();}
