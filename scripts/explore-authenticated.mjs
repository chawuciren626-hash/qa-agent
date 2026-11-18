/**
 * 登录式探索：登录一个受控后台，把目标页渲染后的控件、表格、接口契约采成结构化事实。
 *
 * 与 `explore-task-url.mjs` 的分工：那个是"单页只读 GET 导航"，用来确认地址可达、
 * 页面上大致有什么；本脚本用来探**登录后**的业务页面——它真的会提交一次登录表单，
 * 所以只应在用户已授权的站点上跑，且必须显式给出 login-config 与凭据文件。
 *
 * 三条纪律：
 *   1. 只采"结构性事实"：控件的标签/角色/CSS、表格列、接口路径与字段名。
 *      不采响应体、不采字段值——业务数据进环境地图只会变成新的泄露面。
 *   2. 验证码走"图片 → @@AWAIT_ANSWER → 答案文件"的人工/视觉握手；等不到答案就失败，
 *      不猜、不重试提交（重试会撞锁定策略）。
 *   3. 只读：除登录表单外不提交任何业务表单。写操作按钮只登记，永不点击。
 *
 * 用法：
 *   node scripts/explore-authenticated.mjs \
 *     --login-url https://host/admin/login \
 *     --target-url https://host/admin/user/key-card/index \
 *     --config <login-config.json> --creds <credentials.json> --out <dir> [--session <state.json>]
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateLoginConfig } from './login-captcha-chain.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!key?.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
  args.set(key.slice(2), process.argv[i + 1]);
}
const need = (name) => {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};

const outDir = resolve(need('out'));
const loginUrl = need('login-url');
const targetUrl = need('target-url');
const configPath = resolve(need('config'));
const credsPath = resolve(need('creds'));
const sessionPath = args.get('session') ? resolve(args.get('session')) : resolve(outDir, 'session.json');
const answerPath = resolve(outDir, 'answer.json');
const shotsDir = resolve(outDir, 'shots');
mkdirSync(shotsDir, { recursive: true });

const log = (msg, data) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...(data ? { data } : {}) }));

const config = validateLoginConfig(JSON.parse(readFileSync(configPath, 'utf8')));
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
if (typeof creds.username !== 'string' || typeof creds.password !== 'string') {
  throw new Error('凭据文件需要 username / password 两个字段');
}

/** 目标元素的定位方式，与 login-config 的目标语法一致（by: css|text|placeholder|role:name）。 */
function locatorFor(page, target) {
  switch (target.by) {
    case 'css':
      return page.locator(target.value).first();
    case 'text':
      return page.getByText(target.value, { exact: false }).first();
    case 'placeholder':
      return page.getByPlaceholder(target.value).first();
    case 'label':
      return page.getByLabel(target.value).first();
    case 'role':
      return page.getByRole(/** @type {any} */ (target.role), { name: target.value }).first();
    default:
      throw new Error(`Unsupported target ${JSON.stringify(target)}`);
  }
}

const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: true,
  ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}),
});
const page = await context.newPage();

// 接口事实：只留 method/path/请求字段名/状态码。响应体一律不落盘。
const apis = new Map();
page.on('response', (res) => {
  const req = res.request();
  if (!['xhr', 'fetch'].includes(req.resourceType())) return;
  let path;
  try {
    path = new URL(res.url()).pathname;
  } catch {
    return;
  }
  const key = `${req.method().toUpperCase()} ${path}`;
  const entry = apis.get(key) ?? { method: req.method().toUpperCase(), path, status: res.status(), request_fields: new Set(), calls: 0 };
  entry.calls += 1;
  entry.status = res.status();
  const raw = req.postData();
  if (raw) {
    try {
      const body = JSON.parse(raw);
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const name of Object.keys(body)) entry.request_fields.add(name);
      }
    } catch {
      // 非 JSON 请求体（rare）只记出现，不记内容
    }
  }
  apis.set(key, entry);
});

/** 采集页面结构：与引擎 `extract_controls` 的 structured_dom 契约对齐。 */
async function structure() {
  return page.evaluate(() => {
    const clean = (value) => (value ?? '').toString().trim().replace(/\s+/g, ' ');
    const label = (el) => {
      const direct = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title');
      if (direct) return clean(direct);
      const item = el.closest('.el-form-item, .form-item, .ant-form-item');
      const itemLabel = item?.querySelector('.el-form-item__label, .ant-form-item-label');
      if (itemLabel) return clean(itemLabel.textContent);
      return clean(el.textContent).slice(0, 40);
    };
    // 语义归一：组件库用 div/span 承载下拉与日期，按类名还原成可执行的标签；
    // 导航菜单与头像图标不进页面控件清单——它们属于全局壳，不是这个页面的可操作项。
    const semanticTag = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'div' || tag === 'span') {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (/\bel-select\b/.test(cls)) return 'select';
        if (/\bel-date-editor\b/.test(cls)) return 'input';
        return null;
      }
      return ['input', 'textarea', 'select', 'button', 'a'].includes(tag) ? tag : null;
    };
    const selector = 'input,textarea,select,button,a[href],[role="button"],[role="tab"],[role="combobox"],.el-select,.el-date-editor';
    const interactive = [...document.querySelectorAll(selector)]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map((el) => ({ el, tag: semanticTag(el) }))
      .filter((item) => item.tag !== null)
      .filter((item) => {
        // 下拉的搜索输入框与容器重复：容器（select）已代表同一控件。
        const cls = typeof item.el.className === 'string' ? item.el.className : '';
        return !/\bel-select__input\b/.test(cls);
      })
      .map(({ el, tag }) => ({
        tag,
        type: el.getAttribute('type') ?? null,
        name: el.getAttribute('name') ?? null,
        // Element Plus 的 id 是自增随机（el-id-7171-4），既不能当选择器也不能当指纹：
        // 两次采集必不相同，写进 maps 后执行期根本选不中。
        id: /^el-id-\d+-\d+$/.test(el.id) ? null : el.id || null,
        text: label(el).slice(0, 60),
        role: el.getAttribute('role') ?? null,
        testid: el.getAttribute('data-testid') ?? null,
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        classes: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
      }));

    const tables = [...document.querySelectorAll('table, .el-table')]
      .map((table) => ({
        headers: [...table.querySelectorAll('thead th')].map((th) => clean(th.textContent)).filter(Boolean),
        row_count: table.querySelectorAll('tbody tr').length,
      }))
      .filter((table) => table.headers.length > 0 || table.row_count > 0);

    return {
      url: location.href,
      title: document.title,
      breadcrumb: [...document.querySelectorAll('.el-breadcrumb__inner, .ant-breadcrumb-link, .breadcrumb-item')].map((el) => clean(el.textContent)).filter(Boolean),
      headings: [...document.querySelectorAll('h1,h2,h3')].map((el) => clean(el.textContent)).filter(Boolean).slice(0, 20),
      interactive,
      tables,
    };
  });
}

/** 登录：填表 → 验证码握手 → 提交 → 判定。返回是否已登录。 */
async function login() {
  await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(800);
  if (!/login/i.test(page.url()) && (await locatorFor(page, config.password_target).count()) === 0) {
    log('login_skipped_already_authenticated', { url: page.url() });
    return true;
  }
  await locatorFor(page, config.username_target).fill(creds.username);
  await locatorFor(page, config.password_target).fill(creds.password);
  await page.screenshot({ path: resolve(shotsDir, 'login-filled.png'), fullPage: true });

  if (config.captcha_input_target && config.captcha_image_target) {
    const image = locatorFor(page, config.captcha_image_target);
    await image.waitFor({ state: 'visible', timeout: 15000 });
    const captchaPath = resolve(shotsDir, 'captcha.png');
    await image.screenshot({ path: captchaPath });
    writeFileSync(answerPath, JSON.stringify({ pending: true }));
    console.log(`@@AWAIT_ANSWER ${captchaPath}`);
    let answer = null;
    for (let i = 0; i < 360; i += 1) {
      await page.waitForTimeout(500);
      try {
        const parsed = JSON.parse(readFileSync(answerPath, 'utf8'));
        if (typeof parsed?.answer === 'string' && parsed.answer.trim()) {
          answer = parsed.answer.trim();
          break;
        }
        if (parsed?.abort) throw new Error('aborted by operator');
      } catch (error) {
        if (String(error?.message).includes('aborted by operator')) throw error;
      }
    }
    if (!answer) throw new Error('等待验证码答案超时（180s），未提交登录');
    await locatorFor(page, config.captcha_input_target).fill(answer);
  }

  await locatorFor(page, config.submit_target).click();
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(500);
    const stillLogin = (await locatorFor(page, config.password_target).count()) > 0;
    if (!stillLogin) {
      await page.screenshot({ path: resolve(shotsDir, 'after-login.png'), fullPage: true });
      return true;
    }
    if (config.failure_check) {
      const failure = locatorFor(page, config.failure_check.target);
      if ((await failure.count()) > 0) {
        const text = await failure.innerText().catch(() => '');
        log('login_rejected', { text: text.slice(0, 80) });
        break;
      }
    }
  }
  await page.screenshot({ path: resolve(shotsDir, 'login-failed.png'), fullPage: true });
  return false;
}

async function main() {
  let reused = existsSync(sessionPath);
  if (reused) {
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
    if (/login/i.test(page.url()) || (await locatorFor(page, config.password_target).count()) > 0) {
      log('session_expired', { note: '保存的会话已失效，改为重新登录' });
      reused = false;
    }
  }
  if (!reused) {
    if (!(await login())) throw new Error('登录未成功，已截图 login-failed.png');
  }

  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: resolve(shotsDir, 'target.png'), fullPage: true });
  const seen = await structure();
  writeFileSync(resolve(outDir, 'structure.json'), JSON.stringify(seen, null, 2));

  await context.storageState({ path: sessionPath });
  const apiList = [...apis.values()]
    .map((entry) => ({ method: entry.method, path: entry.path, status: entry.status, calls: entry.calls, request_fields: [...entry.request_fields].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(resolve(outDir, 'apis.json'), JSON.stringify(apiList, null, 2));

  // 结构指纹只算稳定事实：随机 id、类名里的构建哈希都不能进来，否则同一页面
  // 两次探索永远"不同"，maps diff 会天天报变化，可比性就成了一句空话。
  const stable = {
    breadcrumb: seen.breadcrumb,
    headings: seen.headings,
    controls: seen.interactive.map((item) => [item.tag, item.type, item.name, item.text, item.role, item.testid, item.disabled]),
    tables: seen.tables.map((table) => [table.headers, table.row_count]),
  };
  const facts = {
    target_url: targetUrl,
    structure_digest: createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16),
    controls: seen.interactive.length,
    tables: seen.tables.length,
    apis: apiList.length,
    session_reused: reused,
  };
  writeFileSync(resolve(outDir, 'explore-receipt.json'), JSON.stringify({ ...facts, limitations: [
    '只采结构性事实：控件标签/角色/CSS、表格列、接口路径与请求字段名；不采响应体与字段值。',
    '单页面快照：不含业务流程、跳转链与跨页状态。',
    '登录成功只证明本次凭据被接受，不证明权限范围或业务可用。',
  ] }, null, 2));
  log('explored', facts);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  log('failed', { error: String(error?.message ?? error) });
  try {
    await page.screenshot({ path: resolve(shotsDir, 'failure.png'), fullPage: true });
  } catch {
    // 截图失败不影响退出码
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
