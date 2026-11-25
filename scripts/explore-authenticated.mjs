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
 *   2. 验证码走策略链：`--captcha-strategy auto` 时先试项目测试码、再试本地算术识别
 *      （读验证码元素的文本/alt/title，严格文法解析，置信度≥0.9 才采纳），都拿不下
 *      才落"图片 → @@AWAIT_ANSWER → 答案文件"的人工握手；等不到答案就失败，不猜、
 *      不重试提交（重试会撞锁定策略）。默认 `manual`，与已验证的验收链保持一致。
 *   3. 只读：除登录表单外不提交任何业务表单。写操作按钮只登记，永不点击。
 *
 * 登录配置两种给法：
 *   a) `--config <login-config.json>`：显式选择器（人工确认过的那种，最稳）；
 *   b) `--discover-login`：不给配置，登录页渲染后按 DOM 自动识别用户名/密码/验证码/
 *      提交按钮，识别不到用户名或密码就直接失败——不猜、不盲填。
 *
 * 进度走 stderr 的 @@ 行（与建档同约定，stdout 保持探索日志）：
 *   @@step {"index":2,"name":"拉起浏览器","status":"running|done|failed","detail":"..."}
 *   @@captcha {"status":"waiting|auto_solved|answered", ...}
 *
 * 用法：
 *   node scripts/explore-authenticated.mjs \
 *     --login-url https://host/admin/login \
 *     --target-url https://host/admin/user/key-card/index \
 *     --config <login-config.json> --creds <credentials.json> --out <dir> [--session <state.json>] \
 *     [--captcha-strategy auto|manual] [--discover-login] [--mode site|page] [--max-pages N]
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { confidenceGate, parseArithmetic, validateLoginConfig } from './login-captcha-chain.mjs';
import { buildEvidenceBundle, buildPageObservations, buildQuestionsAndRules, dedupeObservations } from './explore-observation-model.mjs';

const args = new Map();
/** 无值开关：不能按 key/value 两两配对，否则会把后面的参数当值吃掉（--discover-login 后跟 --mode site 时 site 落到 key 位报 Unexpected argument）。 */
const FLAG_ARGS = new Set(['discover-login', 'public']);
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!key?.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
  const name = key.slice(2);
  if (FLAG_ARGS.has(name)) { args.set(name, ''); continue; }
  args.set(name, process.argv[++i]);
}
const need = (name) => {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};

const outDir = resolve(need('out'));
const loginUrl = need('login-url');
const targetUrl = need('target-url');
const configPath = args.get('config') ? resolve(args.get('config')) : null;
const discoverLogin = args.has('discover-login');
if (!configPath && !discoverLogin) throw new Error('Missing --config （或 --discover-login）');
const credsPath = resolve(need('creds'));
const sessionPath = args.get('session') ? resolve(args.get('session')) : resolve(outDir, 'session.json');
const answerPath = resolve(outDir, 'answer.json');
const shotsDir = resolve(outDir, 'shots');
mkdirSync(shotsDir, { recursive: true });

const captchaStrategy = args.get('captcha-strategy') ?? 'manual';
/** 公开页模式：不登录、不填表，只采目标页（站点无需登录时用）。 */
const publicMode = args.has('public');
if (!['auto', 'manual'].includes(captchaStrategy)) throw new Error('--captcha-strategy 只接受 auto / manual');
/**
 * 站点模式：登录成功后按路由清单逐页采集全部页面（项目测试打底的「项目地图」）。
 * 页面模式（默认）：只采 target-url 一页——兼容旧口径，公开页也走这条。
 * 页数硬预算：探索预算是工程的护栏不是模型自觉（§15.1），默认 50 页封顶。
 */
const siteMode = args.get('mode') === 'site';
const maxPages = Math.max(1, Math.min(Number.parseInt(args.get('max-pages') ?? '50', 10) || 50, 200));
mkdirSync(resolve(shotsDir, 'pages'), { recursive: true });
/** 已入队/已采集的路由集合：collectPage 的重定向分支与全站 BFS 共用，防重复采集。 */
const visitedRoutes = new Set();

const log = (msg, data) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...(data ? { data } : {}) }));
/** 进度播报：stderr 的 @@ 行，可丢、可被平台解析；不影响探索结论。 */
const emit = (channel, data) => process.stderr.write(`@@${channel} ${JSON.stringify(data)}\n`);

let config = configPath ? validateLoginConfig(JSON.parse(readFileSync(configPath, 'utf8'))) : null;
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

/**
 * 不给登录配置时按 DOM 识别登录表单。识别不到用户名或密码就抛错——不猜选择器，
 * 也不盲填（盲填会把错误凭据提交给真实系统）。
 */
async function discoverLoginConfig() {
  const shape = await page.evaluate(() => {
    const { visible, pathOf } = (() => {
      const visible = (el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const pathOf = (el) => {
        const id = el.id;
        if (id && !/^el-id-\d+-\d+$/.test(id)) return `#${CSS.escape(id)}`;
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`;
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body && parts.length < 5) {
          let part = node.tagName.toLowerCase();
          const siblings = node.parentElement ? [...node.parentElement.children].filter((x) => x.tagName === node.tagName) : [];
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          parts.unshift(part);
          node = node.parentElement;
        }
        return parts.join(' > ');
      };
      return { visible, pathOf };
    })();
    const inputs = [...document.querySelectorAll('input,textarea')].filter(visible);
    const pwd = inputs.find((el) => (el.getAttribute('type') ?? '').toLowerCase() === 'password') ?? null;
    const user = inputs.find((el) => el !== pwd && /^(text|tel|email|)$/i.test(el.getAttribute('type') ?? '')) ?? null;
    const captchaImg = [...document.querySelectorAll('img,canvas')]
      .filter(visible)
      .find((el) => /captcha|yzm|verify|validate|code/i.test(`${el.getAttribute('src') ?? ''} ${el.getAttribute('alt') ?? ''} ${typeof el.className === 'string' ? el.className : ''}`)) ?? null;
    const captchaInput = inputs.find((el) => el !== pwd && el !== user
      && /验证码|captcha|code|yzm/i.test(`${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('name') ?? ''} ${el.id}`)) ?? null;
    const buttons = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(visible);
    const submit = buttons.find((el) => /登录|登 录|login|sign\s*in/i.test(`${el.textContent ?? ''} ${el.getAttribute('value') ?? ''}`)) ?? null;
    return {
      user: user && pathOf(user),
      pwd: pwd && pathOf(pwd),
      captchaImage: captchaImg && pathOf(captchaImg),
      captchaInput: captchaInput && pathOf(captchaInput),
      submit: submit && pathOf(submit),
      usernameLike: inputs.filter((el) => el !== pwd).map((el) => el.getAttribute('placeholder') ?? ''),
    };
  });
  if (!shape.user || !shape.pwd) {
    throw new Error(`登录页未识别到用户名/密码输入框（用户=${shape.user ?? '无'}，密码=${shape.pwd ?? '无'}）：请提供登录配置 JSON 后重试`);
  }
  const built = {
    project: 'discovered',
    username_target: { by: 'css', value: shape.user },
    password_target: { by: 'css', value: shape.pwd },
    submit_target: { by: 'css', value: shape.submit ?? 'button[type="submit"]' },
    ...(shape.captchaImage && shape.captchaInput
      ? { captcha_image_target: { by: 'css', value: shape.captchaImage }, captcha_input_target: { by: 'css', value: shape.captchaInput } }
      : {}),
    // 成功判定用"密码框数量归零"：等价于"已离开登录页"，不冒充业务可用性。
    success_check: {
      target: { by: 'css', value: shape.pwd },
      condition: 'count',
      value: 0,
      case_id: 'EXPLORE-LOGIN-01',
      title: '提交登录后离开登录页',
      expected: '登录页密码框不再存在（以登录页消失判定，不代表权限范围）',
    },
  };
  log('login_config_discovered', { user: shape.user, pwd: shape.pwd, captcha: !!(shape.captchaImage && shape.captchaInput), submit: shape.submit });
  return validateLoginConfig(built);
}

/**
 * 拉起浏览器：默认用 Playwright 自带 chromium（安装目录 runtime/tools/browsers，
 * 由 PLAYWRIGHT_BROWSERS_PATH 指过去）；显式 QA_BROWSER_CHANNEL 时用它；两者都失败
 * 再退回系统 chrome。旧实现硬编码 channel:'chrome'——只装了 Playwright 浏览器、
 * 没装系统 Chrome 的机器直接报 "Chromium distribution 'chrome' is not found"。
 */
async function launchExploreBrowser() {
  const explicit = process.env.QA_BROWSER_CHANNEL;
  const attempts = explicit
    ? [{ headless: true, channel: explicit }]
    : [{ headless: true }, { headless: true, channel: 'chrome' }];
  let lastError = null;
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      lastError = error;
    }
  }
  const hint = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? `（PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}）`
    : "（未设置 PLAYWRIGHT_BROWSERS_PATH）";
  throw new Error(
    `无法启动浏览器${hint}：内置 chromium 与系统 chrome 均不可用。` +
    `请确认安装目录 runtime/tools/browsers 存在，或执行 npx playwright install chromium。` +
    `原始错误：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
const browser = await launchExploreBrowser();
emit('step', { index: 2, name: '拉起浏览器', status: 'done', detail: '无头浏览器已启动' });
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

/** 读验证码元素的文本线索：显式文本框 > 图片 alt/title。读不到按"无法识别"处理。 */
async function readCaptchaText() {
  try {
    if (config.captcha_text_target) return (await locatorFor(page, config.captcha_text_target).textContent({ timeout: 2000 }))?.trim() || null;
    if (config.captcha_image_target) {
      const img = locatorFor(page, config.captcha_image_target);
      return (await img.getAttribute('alt', { timeout: 2000 }))?.trim() || (await img.getAttribute('title', { timeout: 2000 }))?.trim() || null;
    }
  } catch {
    // 读失败 = 无法识别，不猜测
  }
  return null;
}

/**
 * 验证码策略链：测试后门码 → 本地算术识别（置信度≥0.9）→ 已配置打码服务 → 代理视觉自动识别；短信/扫码/滑块/点选才人工。
 * 自动成功时不写 answer.json、不暂停；全失败才落人工握手。
 */
async function solveCaptchaByStrategy() {
  const attempts = [];
  if (config.test_code) {
    attempts.push({ strategy: 'test_bypass_code', accepted: true, basis: 'project_configured_test_code' });
    return { answer: config.test_code, attempts };
  }
  attempts.push({ strategy: 'test_bypass_code', accepted: false, reason: 'not_configured' });
  const parsed = parseArithmetic(await readCaptchaText());
  const gate = confidenceGate(parsed);
  if (gate.accepted) {
    attempts.push({ strategy: 'local_arithmetic_recognition', accepted: true, confidence: parsed.confidence, basis: parsed.basis });
    return { answer: parsed.answer, attempts };
  }
  attempts.push({ strategy: 'local_arithmetic_recognition', accepted: false, reason: parsed ? 'low_confidence' : 'no_recognizable_arithmetic_expression' });
  attempts.push({ strategy: 'captcha_service', accepted: false, reason: 'service_not_configured' });
  return { answer: null, attempts };
}

/** 登录：填表 → 验证码策略链 → 提交 → 判定。返回是否已登录。 */
async function login() {
  emit('step', { index: 3, name: '登录', status: 'running', detail: '打开登录页' });
  await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(800);
  if (!config) config = await discoverLoginConfig();
  if (!/login/i.test(page.url()) && (await locatorFor(page, config.password_target).count()) === 0) {
    log('login_skipped_already_authenticated', { url: page.url() });
    emit('step', { index: 3, name: '登录', status: 'done', detail: '已存在登录态，跳过登录' });
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
    let answer = null;
    if (captchaStrategy === 'auto') {
      const solved = await solveCaptchaByStrategy();
      emit('captcha', { status: solved.answer ? 'auto_solved' : 'unresolved', attempts: solved.attempts, path: captchaPath });
      if (solved.answer) answer = solved.answer;
    }
    if (!answer) {
      writeFileSync(answerPath, JSON.stringify({ pending: true }));
      emit('captcha', { status: 'waiting', path: captchaPath, strategy: captchaStrategy });
      console.log(`@@AWAIT_ANSWER ${captchaPath}`);
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
      emit('captcha', { status: 'answered' });
    }
    await locatorFor(page, config.captcha_input_target).fill(answer);
  }

  await locatorFor(page, config.submit_target).click();
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(500);
    const stillLogin = (await locatorFor(page, config.password_target).count()) > 0;
    if (!stillLogin) {
      await page.screenshot({ path: resolve(shotsDir, 'after-login.png'), fullPage: true });
      emit('step', { index: 3, name: '登录', status: 'done', detail: '登录成功，已离开登录页' });
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
  emit('step', { index: 3, name: '登录', status: 'failed', detail: '登录未成功（不重试提交，防锁定）' });
  return false;
}

/* ------------------------------------ 全站模式 ------------------------------------ */

/** 与引擎 explorer.extract_routes 同源的路由模式（§15.2）：JS bundle 直解路由表，零 token。 */
const ROUTE_PATTERNS = [
  /path\s*[:=]\s*["']([^"']+)["']/g,
  /(?:push|replace|navigateTo|navigate|redirect)\s*\(\s*["'`](\/[^"'`]*)["'`]/g,
  /replaceState\s*\([^,]*,[^,]*,\s*["'`](\/[^"'`]*)["'`]/g,
  /href\s*=\s*["'](\/[^"'#]*)["']/g,
  /to\s*[:=]\s*["'](\/\w[\w/\-:]*)["']/g,
];
const NOT_ROUTE = /[\s<>{}\\]|:\/\/|\$\{|\.\.\//;
/** 静态资源与站点元文件不是页面：href 采集会扫到 <link>/<script> 引用，不过滤会把
 *  favicon.ico、构建产物 CSS 当成页面去访问（与引擎 explorer.is_page_route 同源）。 */
const STATIC_ASSET = /\.(css|js|mjs|cjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|pdf|zip|gz|json|xml|txt)$/i;
const NON_PAGE_PATHS = new Set(['/favicon.ico', '/robots.txt', '/sitemap.xml', '/manifest.json', '/manifest.webmanifest']);
/** 会话破坏性链接：点了就掉登录态，探索绝不跟随。 */
const SESSION_DESTROYING = /logout|signout|sign-out|退出登录|注销登录|\/login$/i;

/** 归并一条候选路由；返回 null = 判定不是可访问页面。 */
function normalizeRoute(raw, prefix) {
  let p = (raw ?? '').trim();
  if (!p || !p.startsWith('/') || p === '/') return null;
  if (p.startsWith('//')) return null;         // 协议相对/跨域形态，不是本站路径
  if (p.startsWith('http') || p.includes('*') || NOT_ROUTE.test(p)) return null;
  if (p.includes(':')) return null;            // /order/:id 是参数模板，字面访问无意义
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (prefix !== '/' && !p.startsWith(`${prefix}/`) && p !== prefix) return null;  // 只采本应用前缀下的路由
  if (STATIC_ASSET.test(p) || NON_PAGE_PATHS.has(p.toLowerCase())) return null;
  if (SESSION_DESTROYING.test(p)) return null; // 登录页已由「访问墙」知识层覆盖，登出链接不能跟
  return p;
}

/** 汇总候选路由：菜单/链接（DOM）+ JS bundle 路由表，目标页排第一。 */
async function discoverRoutes(targetPath, prefix) {
  const found = new Set([targetPath]);
  try {
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter(Boolean));
    for (const href of hrefs) {
      try {
        const u = new URL(href, page.url());
        if (u.origin === new URL(page.url()).origin) {
          const normalized = normalizeRoute(u.pathname, prefix);
          if (normalized) found.add(normalized);
        }
      } catch { /* 相对路径解析失败按没有处理 */ }
    }
  } catch { /* DOM 采集失败不拦全站 */ }
  try {
    const srcs = await page.evaluate(() =>
      [...document.querySelectorAll('script[src]')]
        .map((s) => s.src)
        .filter((src) => { try { return new URL(src).origin === location.origin; } catch { return false; } }));
    for (const src of srcs) {
      try {
        const res = await fetch(src, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) continue;
        const text = await res.text();
        for (const pattern of ROUTE_PATTERNS) {
          for (const match of text.matchAll(pattern)) {
            const normalized = normalizeRoute(match[1], prefix);
            if (normalized) found.add(normalized);
          }
        }
      } catch { /* 单个 bundle 拉不到按没有处理 */ }
    }
    log('routes_discovered', { count: found.size, bundles: srcs.length, prefix });
  } catch { /* bundle 解析失败不拦全站 */ }
  return [...found].slice(0, maxPages);
}

/** 本页可见的链接清单：全站爬取的队列来源（登出/登录/静态资源由 normalizeRoute 过滤）。 */
async function collectAnchors() {
  try {
    return await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter(Boolean));
  } catch { return []; }
}

/**
 * 语义事实采集（零 LLM，第一批证据层）：价格/字段标签/选项列表 + 问题推导用的
 * 结构线索（表单/下拉/分页）。只读 DOM，不做任何交互——需要"提交了才知道"的
 * 事实（错误文案/状态转换）属会话侧证据轮，这里绝不模拟。
 */
async function collectFacts() {
  try {
    return await page.evaluate(() => {
      const clean = (value) => (value ?? '').toString().trim().replace(/\s+/g, ' ');
      const CURRENCY = /^[¥$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|\d+(?:\.\d{1,2})?\s*[元块钱]$/;
      const cssOf = (el) => {
        if (el.id && !/^el-id-\d+-\d+$/.test(el.id)) return `#${CSS.escape(el.id)}`;
        const testid = el.getAttribute('data-testid') ?? el.getAttribute('data-test');
        if (testid) return `[data-testid="${testid}"]`;
        return null;
      };
      const contextOf = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
          const cls = typeof node.className === 'string' ? node.className : '';
          if (!/(item|card|row|product|entry|goods)/i.test(cls)) continue;
          const named = node.querySelector('h1,h2,h3,h4,h5,h6,a,strong,[data-test],[class*="name" i],[class*="title" i]');
          const text = named ? clean(named.textContent) : '';
          if (text && text !== clean(el.textContent)) return text.slice(0, 120);
        }
        return null;
      };
      const visible = (el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const prices = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!visible(el)) continue;
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
        const text = clean(own);
        if (!text || text.length > 24 || !CURRENCY.test(text)) continue;
        prices.push({ verbatim: text, context: contextOf(el), css: cssOf(el), testid: el.getAttribute('data-testid') });
        if (prices.length >= 60) break;
      }
      const fieldLabel = (el) => {
        if (el.id) {
          const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (explicit) return clean(explicit.textContent);
        }
        const wrap = el.closest('label');
        if (wrap) return clean(wrap.textContent);
        return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
      };
      const labels = [];
      for (const el of document.querySelectorAll('input,textarea,select')) {
        if (!visible(el)) continue;
        if ((el.getAttribute('type') ?? 'text') === 'hidden') continue;
        const text = fieldLabel(el);
        if (!text) continue;
        labels.push({ verbatim: text, name: el.getAttribute('name') ?? null, css: cssOf(el) });
        if (labels.length >= 60) break;
      }
      const options = [];
      for (const el of document.querySelectorAll('select')) {
        if (!visible(el)) continue;
        const items = [...el.querySelectorAll('option')].map((o) => clean(o.textContent)).filter(Boolean);
        if (items.length < 2) continue;
        const name = el.getAttribute('name') ?? el.getAttribute('aria-label') ?? items[0];
        options.push({ verbatim: items.join(' | ').slice(0, 300), name, css: cssOf(el) });
        if (options.length >= 30) break;
      }
      const forms = [...document.querySelectorAll('form')]
        .map((form) => {
          const fields = [...form.querySelectorAll('input,textarea,select')].filter((el) => visible(el) && (el.getAttribute('type') ?? 'text') !== 'hidden' && (el.getAttribute('type') ?? '') !== 'submit');
          if (fields.length < 2) return null;
          const first = fields.map(fieldLabel).find(Boolean);
          return { label: clean(form.getAttribute('aria-label') || form.getAttribute('name') || first || '未命名表单'), fields: fields.length, page: null };
        })
        .filter(Boolean)
        .slice(0, 5);
      const selects = [...document.querySelectorAll('select')]
        .filter(visible)
        .map((el) => ({ label: clean(el.getAttribute('aria-label') || el.getAttribute('name') || fieldLabel(el) || '未命名下拉'), page: null }))
        .slice(0, 5);
      const pagination = [...document.querySelectorAll('a,button,[class*="pager" i],[class*="pagination" i],[aria-label]')]
        .some((el) => visible(el) && /下一页|加载更多|next page|>\s*$/i.test(clean(el.getAttribute('aria-label') || el.textContent).slice(0, 20)));
      return { prices, labels, options, forms, selects, pagination };
    });
  } catch { return { prices: [], labels: [], options: [], forms: [], selects: [], pagination: false }; }
}

/** 逐页采集：goto → pathname 校验（重定向=以最终路径登记，登录墙才记失败）→ 结构 → 截图 → 链接。 */
async function collectPage(route) {
  const entry = { route, ok: false, url: null, reason: null, controls: 0, tables: 0, structure: null, anchors: [], redirected_from: null };
  try {
    await page.goto(new URL(route, targetUrl).toString(), { waitUntil: 'networkidle', timeout: 45_000 });
    await page.waitForTimeout(1500);
    entry.url = page.url();
    const finalPath = new URL(page.url()).pathname.replace(/\/$/, '');
    if (finalPath !== route) {
      // 被重定向本身不是失败：登录后访问 `/` 跳到业务首页是常态。最终页若还没采过，
      // 就以最终路径登记结构（redirected_from 保留真实请求路由）；最终页采过=重复，如实记不重复采。
      if (!finalPath || SESSION_DESTROYING.test(finalPath) || visitedRoutes.has(finalPath)) {
        entry.reason = `redirected:${finalPath || '/'}`;
        return entry;
      }
      entry.redirected_from = route;
      entry.route = finalPath;
      visitedRoutes.add(finalPath);
    }
    const seen = await structure();
    entry.ok = true;
    entry.controls = seen.interactive.length;
    entry.tables = seen.tables.length;
    entry.structure = seen;
    entry.anchors = await collectAnchors();
    entry.facts = await collectFacts();
    entry.observations = buildPageObservations(entry.route, entry.facts);
    const slug = entry.route.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';
    await page.screenshot({ path: resolve(shotsDir, 'pages', `${slug}.png`), fullPage: true }).catch(() => {});
  } catch (error) {
    entry.reason = String(error?.message ?? error).slice(0, 200);
  }
  return entry;
}

async function main() {
  let reused = existsSync(sessionPath) && !publicMode;
  if (reused) {
    emit('step', { index: 3, name: '登录', status: 'running', detail: '检查已保存登录态' });
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
    const targetPath = new URL(targetUrl).pathname.replace(/\/$/, '');
    const currentPath = new URL(page.url()).pathname.replace(/\/$/, '');
    if (currentPath !== targetPath || (await page.locator('input[type="password"]:visible').count()) > 0) {
      log('session_expired', { note: '保存的会话已失效，改为重新登录' });
      reused = false;
    } else {
      emit('step', { index: 3, name: '登录', status: 'done', detail: '已保存登录态有效，目标页可访问' });
    }
  }
  /** 登录后落地页：真实业务入口通常在这里（`/` 常停在登录页），全站爬取优先从它开始。 */
  let landingPath = null;
  if (!reused) {
    if (publicMode) {
      log('public_mode', { note: '公开页模式：不提交登录表单' });
    } else if (!(await login())) throw new Error('登录未成功，已截图 login-failed.png');
    landingPath = new URL(page.url()).pathname.replace(/\/$/, '');
  }

  emit('step', { index: 4, name: '采集页面', status: 'running', detail: siteMode ? '全站模式：目标页先行，随后逐页采集' : '打开目标页并采集控件/表格' });
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  const targetPath = new URL(targetUrl).pathname.replace(/\/$/, '');
  const finalTargetPath = new URL(page.url()).pathname.replace(/\/$/, '');
  if (finalTargetPath !== targetPath && !siteMode) {
    throw new Error('目标页未打开，实际导航到了其他路径；未将该页面登记为目标页探索结果');
  }
  await page.screenshot({ path: resolve(shotsDir, 'target.png'), fullPage: true });
  const seen = await structure();
  writeFileSync(resolve(outDir, 'structure.json'), JSON.stringify(seen, null, 2));

  /** 证据层（第一批）：目标页的事实采集。observations 与 pages.json 分离，避免互相膨胀。 */
  const collectedObservations = [];
  const collectedFacts = { forms: [], selects: [], pagination: false };
  const absorbFacts = (route, facts) => {
    for (const form of facts?.forms ?? []) collectedFacts.forms.push({ ...form, page: route });
    for (const select of facts?.selects ?? []) collectedFacts.selects.push({ ...select, page: route });
    collectedFacts.pagination = collectedFacts.pagination || Boolean(facts?.pagination);
  };
  {
    const targetFacts = await collectFacts();
    collectedObservations.push(...buildPageObservations(finalTargetPath, targetFacts));
    absorbFacts(finalTargetPath, targetFacts);
  }

  /** pages.json：全站模式多页产物（目标页也在内）；页面模式退化为单元素数组。 */
  visitedRoutes.add(targetPath);
  visitedRoutes.add(finalTargetPath);
  const pages = [{ route: finalTargetPath, ok: true, url: page.url(), reason: null,
    controls: seen.interactive.length, tables: seen.tables.length, structure: seen,
    anchors: await collectAnchors(), redirected_from: finalTargetPath !== targetPath ? targetPath : null }];
  if (siteMode) {
    const prefix = `/${targetPath.split('/').filter(Boolean)[0] ?? ''}`;
    const discovered = (await discoverRoutes(targetPath, prefix))
      .filter((route) => route !== targetPath && route !== finalTargetPath);
    const queue = [];
    if (landingPath && !SESSION_DESTROYING.test(landingPath) && !visitedRoutes.has(landingPath)) {
      visitedRoutes.add(landingPath);
      queue.push(landingPath);              // 登录后落地页优先：那里才是真实业务页
    }
    for (const route of discovered) {
      if (!visitedRoutes.has(route)) { visitedRoutes.add(route); queue.push(route); }
    }
    emit('step', { index: 4, name: '采集页面', status: 'running',
      detail: `全站模式：已入队 ${queue.length + 1} 页（预算 ${maxPages}），逐页采集并跟随页面链接` });
    let k = 0;
    while (queue.length && pages.length < maxPages) {
      const route = queue.shift();
      k += 1;
      emit('step', { index: 4, name: '采集页面', status: 'running', detail: `全站 ${k} · ${route}（待采 ${queue.length}）` });
      const entry = await collectPage(route);
      pages.push(entry);
      if (entry.ok) {
        collectedObservations.push(...(entry.observations ?? []));
        absorbFacts(entry.route, entry.facts);
      }
      delete entry.facts;        // 原始事实只在 observations.json / 内存里，pages.json 保持精简
      delete entry.observations;
      // 采集成功页暴露的同源链接继续入队（BFS）：路由表与菜单拿不到的多页站点靠这里覆盖。
      for (const href of entry.ok ? entry.anchors : []) {
        try {
          const u = new URL(href, entry.url ?? targetUrl);
          if (u.origin !== new URL(targetUrl).origin) continue;
          const normalized = normalizeRoute(u.pathname, prefix);
          if (normalized && !visitedRoutes.has(normalized)) {
            visitedRoutes.add(normalized);
            queue.push(normalized);
          }
        } catch { /* 相对路径解析失败按没有处理 */ }
      }
    }
    const failed = pages.filter((item) => !item.ok);
    if (pages.length - failed.length === 0) {
      throw new Error('全站探索没有采到任何页面（目标页与全部路由均未渲染成功）');
    }
    log('site_collected', {
      total: pages.length, ok: pages.length - failed.length, failed: failed.length,
      pending: queue.length,
      failed_routes: failed.map((item) => `${item.route} (${item.reason ?? '?'})`).slice(0, 10),
    });
    emit('step', { index: 4, name: '采集页面', status: 'done',
      detail: `全站 ${pages.length - failed.length}/${pages.length} 页 · 待采 ${queue.length} 页（预算 ${maxPages}）· 目标页 ${seen.interactive.length} 控件` });
  } else {
    emit('step', { index: 4, name: '采集页面', status: 'done', detail: `${seen.interactive.length} 控件 · ${seen.tables.length} 表格` });
  }
  writeFileSync(resolve(outDir, 'pages.json'), JSON.stringify(pages, null, 2));

  // 证据包（第一批）：跨页去重 → 确定性问题与固定事实 → observations.json。
  // 这是 qa_exploration_hypotheses（G4 回流）与知识候选的数据源；零 LLM，逐字可断言。
  const observations = dedupeObservations(collectedObservations);
  const derived = buildQuestionsAndRules(observations, {
    authenticated: !publicMode,
    pagesOk: pages.filter((item) => item.ok).length,
    forms: collectedFacts.forms,
    selects: collectedFacts.selects,
    pagination: collectedFacts.pagination,
  });
  const evidence = buildEvidenceBundle(siteMode ? 'site' : 'page', new Date().toISOString(),
    observations, derived.questions, derived.rules);
  writeFileSync(resolve(outDir, 'observations.json'), JSON.stringify(evidence, null, 2));

  await context.storageState({ path: sessionPath });
  const apiList = [...apis.values()]
    .map((entry) => ({ method: entry.method, path: entry.path, status: entry.status, calls: entry.calls, request_fields: [...entry.request_fields].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(resolve(outDir, 'apis.json'), JSON.stringify(apiList, null, 2));
  emit('step', { index: 5, name: '采集接口', status: 'done', detail: `${apiList.length} 条接口` });

  // 结构指纹只算稳定事实：随机 id、类名里的构建哈希都不能进来，否则同一页面
  // 两次探索永远"不同"，maps diff 会天天报变化，可比性就成了一句空话。
  //
  // 表格数据行里的操作按钮是**模板结构**：同一个"查看 Key"会随行数出现 1 次或 10 次。
  // 行数是数据状态不是页面骨架——真实环境验收时表从 1 行涨到 2 行，控件 14→16，
  // 指纹就变了。指纹按"连续重复归并"只算骨架种类；行数记进 exploration 事实，不进指纹。
  const collapse = (items) => {
    const merged = [];
    for (const key of items) {
      if (merged.length && JSON.stringify(merged[merged.length - 1]) === JSON.stringify(key)) continue;
      merged.push(key);
    }
    return merged;
  };
  const stable = {
    breadcrumb: seen.breadcrumb,
    headings: seen.headings,
    controls: collapse(seen.interactive.map((item) => [item.tag, item.type, item.name, item.text, item.role, item.testid, item.disabled])),
    tables: seen.tables.map((table) => [table.headers]),
  };
  const facts = {
    target_url: targetUrl,
    mode: siteMode ? 'site' : 'page',
    structure_digest: createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16),
    controls: seen.interactive.length,
    tables: seen.tables.length,
    apis: apiList.length,
    pages_total: pages.length,
    pages_ok: pages.filter((item) => item.ok).length,
    pages_failed: pages.filter((item) => !item.ok).length,
    observations: evidence.observations.length,
    questions: evidence.questions.length,
    evidence_rules: evidence.rules.length,
    session_reused: reused,
  };
  writeFileSync(resolve(outDir, 'explore-receipt.json'), JSON.stringify({ ...facts, limitations: [
    '只采结构性事实：控件标签/角色/CSS、表格列、接口路径与请求字段名；不采响应体与字段值。',
    siteMode
      ? '全站逐页快照：只采页面结构与本页触发过的接口，不含跨页业务流程与状态迁移。'
      : '单页面快照：不含业务流程、跳转链与跨页状态。',
    '语义证据（observations.json）只含 DOM 可静态提取的价格/字段标签/选项列表；错误文案与状态转换需要真实交互，本入口不采集。',
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
