/**
 * saucedemo 结构层真实定位验证（D6 接线）：
 * 资产目录里的 ui_locator_bundle → 锚点适配器 → Playwright 采集 DOM 控件树
 * → grounding-driver 结构层定位 → 点击 → 断言购物车角标。全程零模型调用。
 *
 * 用法：node scripts/verify-saucedemo-grounding.mjs [--headed]
 * 输出 JSON 结论；失败或不可达时退出码非 0，不伪造成功。
 */
import { resolve } from 'node:path';
import { bundleAnchors, loadCatalog } from './locator-anchor-adapter.mjs';
import { createGroundingDriver } from './grounding-driver.mjs';
import { collectControlTree } from './structural-snapshot.mjs';

const root = resolve(import.meta.dirname, '..');
const headed = process.argv.includes('--headed');
const BASE_URL = process.env.QA_SAUCEDEMO_URL ?? 'https://www.saucedemo.com';
const USERNAME = process.env.QA_SAUCEDEMO_USER ?? 'standard_user';
const PASSWORD = process.env.QA_SAUCEDEMO_PASSWORD ?? 'secret_sauce';

async function launch() {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch({ headless: !headed });
  } catch (error) {
    return chromium.launch({ headless: !headed, channel: 'chrome' });
  }
}

async function main() {
  const { path, catalog } = loadCatalog(root);
  if (!catalog) throw new Error(`未找到资产目录：${path}`);
  const bundle = catalog.assets.find(asset => asset.id === 'ui-saucedemo-test-82492e87');
  if (!bundle) throw new Error('资产目录缺少 ui-saucedemo-test-82492e87');
  const anchor = bundleAnchors(bundle).find(item => item.control === 'add-to-cart-sauce-labs-backpack');
  if (!anchor) throw new Error('saucedemo 锚点中缺少 add-to-cart-sauce-labs-backpack');

  const browser = await launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.fill('#user-name', USERNAME);
    await page.fill('#password', PASSWORD);
    await page.click('#login-button');
    await page.waitForURL('**/inventory.html', { timeout: 20000 });
    await page.waitForLoadState('networkidle');

    const tree = await page.evaluate(collectControlTree);
    const driver = createGroundingDriver();
    const result = await driver.resolve({ tree, anchor });
    if (!result.resolved) {
      console.log(JSON.stringify({ status: 'failed', reason: result.reason, attempts: result.attempts, candidates: result.candidates?.slice(0, 5).map(row => ({ score: row.matched.length, matched: row.matched, css: row.node.css_path })) }, null, 2));
      process.exitCode = 1;
      return;
    }
    if (result.backend !== 'structural' || result.model_calls !== 0) {
      throw new Error(`结构层应为零模型命中，实际 backend=${result.backend} model_calls=${result.model_calls}`);
    }

    await page.click(result.node.css_path);
    await page.waitForFunction(() => (document.querySelector('.shopping_cart_badge')?.textContent ?? '').trim() === '1', null, { timeout: 10000 });
    const cartBadge = (await page.textContent('.shopping_cart_badge')).trim();
    const cartItems = await page.locator('.cart_item').count();
    console.log(JSON.stringify({
      status: 'passed',
      backend: result.backend,
      model_calls: result.model_calls,
      anchor_id: anchor.anchor_id,
      matched_fingerprints: result.matched_fingerprints,
      node_css_path: result.node.css_path,
      node_text: result.node.text,
      cart_badge: cartBadge,
      cart_items: cartItems,
      url: page.url(),
      catalog: path,
    }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => {
  console.log(JSON.stringify({ status: 'blocked', reason: error.message }, null, 2));
  process.exitCode = 1;
});
