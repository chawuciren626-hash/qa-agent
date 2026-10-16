import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, extname, relative } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { patchDeliveryBundle } from './penguin-runtime-patches.mjs';
import { patchClientBundle, clientModule } from './client-ui-patches.mjs';

const [app, output] = process.argv.slice(2);
if (!app || !output) throw new Error('Usage: <resources/app> <engineering-output>');
const root = resolve(import.meta.dirname, '..'), web = resolve(app, 'web-dist'), out = resolve(output);
mkdirSync(out, { recursive: true });
const index = readFileSync(resolve(web, 'index.html'), 'utf8');
const asset = index.match(/src="\/assets\/([^"/?]+\.js)/)[1], css = index.match(/href="(\/assets\/[^"/]+\.css)"/)[1];
const path = resolve(web, 'assets', asset);
const original = readFileSync(existsSync(path + '.qa-runtime-original') ? path + '.qa-runtime-original' : path, 'utf8');
let bundle = patchClientBundle(patchDeliveryBundle(original));
const mount = 'Cke();Ske().then(e=>{e==="reload"?location.reload():RM()},RM);';
assert.equal(bundle.split(mount).length, 2);
bundle = bundle.replace(mount, '') + '\nfunction QaHarness(props){return r.jsx(oB,{children:r.jsx(xB,{children:r.jsx(Ale,props)})});} export {eB,r as qaJSX,QaHarness};';
const module = clientModule(...['penguin/ui/delivery-ui.mjs', 'penguin/ui/workspace-ui.mjs', 'penguin/ui/workspace-ui.css'].map(file => readFileSync(resolve(root, file), 'utf8')));
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"></head><body><div id="root" hidden></div><main id="qa" style="padding:16px;max-width:960px;margin:auto"></main><script type="module" src="/fixture.mjs"></script></body></html>`);return;
    }
    if (url.pathname === '/fixture.mjs') {
      res.setHeader('content-type', 'text/javascript');
      res.end(`import {eB,qaJSX as r,QaHarness} from '/assets/test.js';const root=eB.createRoot(document.querySelector('#qa'));window.show=(items,child=false)=>root.render(r.jsx(QaHarness,{items,ctx:{qaPresentation:true,sessionId:'fixture',workspace:'E:/synthetic',origin:child?['child']:[],taskRunning:false,pendingApprovals:new Map()}}));window.ready=true;`);return;
    }
    if (url.pathname === '/assets/test.js' || url.pathname === '/assets/qa-delivery-ui.js') { res.setHeader('content-type', 'text/javascript');res.end(url.pathname.endsWith('test.js') ? bundle : module);return; }
    const file = resolve(web, '.' + decodeURIComponent(url.pathname));
    if (relative(web, file).startsWith('..')) throw new Error('outside');
    res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.statusCode = 404;res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ready);
  const start = { kind: 'assistant_text', id: 'start', text: '读取', streaming: false };
  const thought = { kind: 'thinking', id: 'dot', thinking: '.', streaming: false };
  const end = { kind: 'assistant_text', id: 'end', text: '编排事件脚本，确认恢复条件。', streaming: false };
  const show = (items, child) => page.evaluate(({ items, child }) => window.show(items, child), { items, child });
  for (const child of [false, true]) {
    await show([start, { ...thought, streaming: true }], child);
    await expect(page.locator('[data-qa-delivery-message]')).toHaveText('读取');
    await show([start, thought, { ...end, text: '编排事件脚本', streaming: true }], child);
    await expect(page.locator('[data-qa-delivery-message]')).toHaveText('读取编排事件脚本');
    await show([start, thought, end], child);
    await expect(page.locator('[data-qa-delivery-message]')).toHaveText('读取编排事件脚本，确认恢复条件。');
    assert.equal(await page.locator('[data-group-header]').count(), 0);
    for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: resolve(out, `${child ? 'child' : 'parent'}-${name}.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await show([start, { ...thought, thinking: '真正的推理内容应默认折叠，但仍可查看。' }, end], child);
    const header = page.locator('[data-group-header]');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await header.click();await expect(header).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: /思考|Thinking/i }).click();
    await expect(page.getByText('真正的推理内容应默认折叠，但仍可查看。', { exact: true })).toBeVisible();
    await show([start, thought, { kind: 'user_text', id: 'boundary', text: '新的确认消息' }, end], child);
    await expect(page.locator('[data-qa-delivery-message]')).toHaveCount(2);
  }
  assert.deepEqual(errors, []);
  const result = { status: 'passed', scope: 'Native React message components, synthetic streaming/replay events, parent and child contexts', viewports: ['1440x900', '390x844'], checks: ['placeholder removed', 'split text joined', 'real reasoning retained and collapsed', 'turn boundary preserved', 'no overflow', 'no browser errors'], real_agent_verified: false };
  writeFileSync(resolve(out, 'verification.json'), JSON.stringify(result, null, 2));console.log(JSON.stringify(result));
} finally { await browser?.close();await new Promise(done => server.close(done)); }
