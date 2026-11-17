// 批次 1F：图形验证码自动登录策略链（docs/captcha-auto-login-followup-20261117.md）。
// 规则与 aitestharness_tools/exec/login.py 的红线保持一致：
// 先分类再处理；验证码失败最多重试 1 次；按项目成功率排序；会话复用优先。
// 本模块只做纯逻辑与 DOM 采集；填码、提交、成功信号与回执由 browser-task  worker 完成。
// 验证码答案与凭据只进入 worker 的 secrets 掩码集合，绝不写入普通回执文本。
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const assert = (ok, message) => { if (!ok) throw new Error(message); };

export const CAPTCHA_TYPES = Object.freeze(['none', 'image', 'slider', 'click_select', 'sms', 'unknown']);

export const STRATEGY_ORDER = Object.freeze({
  none: ['direct'],
  image: ['test_bypass_code', 'ocr', 'captcha_service', 'manual'],
  slider: ['slider_solver', 'captcha_service', 'manual'],
  click_select: ['captcha_service', 'manual'],
  sms: ['sms_fixed_code', 'manual'],
  unknown: ['manual'],
});

// 红线 2：首次提交 + 最多 1 次重试，防止风控锁号。
export const MAX_CAPTCHA_SUBMITS = 2;
export const MIN_SOLVE_CONFIDENCE = 0.9;

export const loginSessionFile = 'execution/browser-login-session.json';
export const loginSessionMetaFile = 'execution/browser-login-session.meta.json';

export async function collectLoginDom(page) {
  return page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].slice(0, 50).map(e => ({
      type: (e.type || 'text').toLowerCase(), name: e.name || '', placeholder: e.getAttribute('placeholder') || '',
    }));
    const hints = [];
    for (const img of [...document.querySelectorAll('img')].slice(0, 30)) {
      hints.push('img', img.getAttribute('alt') || '', (img.getAttribute('src') || '').split('/').pop());
    }
    for (const e of [...document.querySelectorAll('label,span,div,button,a')].slice(0, 800)) {
      const text = (e.textContent || '').trim();
      if (text && text.length <= 40 && /captcha|验证码|滑块|slider|点选|短信|sms|扫码|yzm/i.test(text)) hints.push(text);
    }
    for (const input of inputs) hints.push(input.name, input.placeholder);
    return {
      inputs,
      iframes: document.querySelectorAll('iframe').length,
      canvas: document.querySelectorAll('canvas').length,
      hints: hints.filter(Boolean).slice(0, 60),
    };
  });
}

// 零 LLM 探测：与 login.py detect_login_form 相同的 DOM 规则。
export function classifyLoginForm(summary) {
  const inputs = summary?.inputs ?? [];
  const index = inputs.findIndex(i => (i.type || '').toLowerCase() === 'password');
  if (index >= 0) {
    const adjacent = inputs.slice(Math.max(index - 1, 0), index);
    return {
      is_login: true, confidence: 'high',
      username_field: adjacent[0]?.name || null, password_field: inputs[index].name || null,
      reason: '命中 input[type=password] 及相邻 input（零 LLM 规则）',
    };
  }
  if ((summary?.iframes ?? 0) > 0 || (summary?.canvas ?? 0) > 0) {
    return { is_login: null, confidence: 'low', reason: 'iframe/canvas 场景：DOM 规则不适用，需人工确认登录形态' };
  }
  return { is_login: false, confidence: 'medium', reason: '未发现密码框特征' };
}

// 与 login.py detect_captcha_type 相同的关键词分类；扫码等未识别形态归 unknown → 人工。
export function classifyCaptcha(summary) {
  const blob = (summary?.hints ?? []).join(' ').toLowerCase();
  const type = !/captcha|验证码|slider|滑块|yzm/.test(blob) ? 'none'
    : /slider|滑块/.test(blob) ? 'slider'
    : /click|点选/.test(blob) ? 'click_select'
    : /sms|短信|code_input/.test(blob) ? 'sms'
    : /image|img/.test(blob) ? 'image'
    : 'unknown';
  return { type, basis: 'dom_keyword_rules', interpretation: '分类不是识别结果，也不构成自动登录能力证明' };
}

// 算术码：严格文法解析并计算，不使用 eval；无法确定解析时返回 null（不得猜测提交）。
export function parseArithmetic(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/\s+/g, '').replace(/[=＝?？]+$/, '');
  const match = normalized.match(/^(\d{1,3})([+\-×xX*÷/])(\d{1,3})$/);
  if (!match) return null;
  const a = Number(match[1]), b = Number(match[3]), op = match[2];
  let answer;
  if (op === '+') answer = a + b;
  else if (op === '-') answer = a - b;
  else if (op === '÷' || op === '/') { if (b === 0 || a % b !== 0) return null; answer = a / b; }
  else answer = a * b;
  return { answer: String(answer), confidence: 1, basis: 'arithmetic_expression' };
}

export function confidenceGate(solution, minimum = MIN_SOLVE_CONFIDENCE) {
  if (!solution || typeof solution.answer !== 'string' || !solution.answer) return { accepted: false, reason: 'no_solution' };
  if (!(typeof solution.confidence === 'number' && solution.confidence >= minimum)) return { accepted: false, reason: 'low_confidence' };
  return { accepted: true };
}

// 红线 3：有成功记录的策略按成功率降序提前；manual 永远最后。
export function strategyOrder(captchaType, stats = {}, project = '') {
  const base = STRATEGY_ORDER[captchaType] ?? ['manual'];
  const projectStats = stats[project] ?? {};
  return base
    .map(strategy => {
      const row = projectStats[strategy];
      const rate = row?.attempt ? (row.success ?? 0) / row.attempt : -1;
      return { strategy, rate };
    })
    .sort((a, b) => (a.strategy === 'manual') - (b.strategy === 'manual') || b.rate - a.rate)
    .map(row => row.strategy);
}

export function recordStrategyOutcome(stats, project, strategy, ok) {
  const slot = stats[project] ??= {};
  const row = slot[strategy] ??= { success: 0, attempt: 0 };
  row.attempt += 1;
  if (ok) row.success += 1;
  return stats;
}

const targetOk = t => t && typeof t === 'object' && ['role', 'label', 'placeholder', 'text', 'css'].includes(t.by)
  && typeof t.value === 'string' && t.value.trim()
  && Object.keys(t).every(k => ['by', 'value', 'name'].includes(k))
  && (t.name === undefined || typeof t.name === 'string');

const checkOk = (check, withCase) => check && typeof check === 'object'
  && Object.keys(check).every(k => ['target', 'condition', 'value', 'case_id', 'title', 'expected', 'case_ref'].includes(k))
  && targetOk(check.target) && ['visible', 'text', 'value', 'count'].includes(check.condition)
  && (check.condition !== 'text' || typeof check.value === 'string' || (check.value === undefined && check.target.by === 'text'))
  && (check.condition !== 'value' || typeof check.value === 'string')
  && (check.condition !== 'count' || Number.isInteger(check.value) && check.value >= 0)
  && (!withCase || (typeof check.case_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(check.case_id)
    && typeof check.title === 'string' && check.title.trim() && typeof check.expected === 'string' && check.expected.trim()));

export function validateLoginConfig(config) {
  assert(config && typeof config === 'object' && !Array.isArray(config), 'Login config must be an object');
  assert(Object.keys(config).every(k => ['project', 'username_target', 'password_target', 'submit_target', 'success_check', 'failure_check', 'captcha_image_target', 'captcha_input_target', 'captcha_text_target', 'test_code', 'reuse_session'].includes(k)), 'Unknown login config field');
  assert(typeof config.project === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.project), 'Login config needs a short project key');
  for (const key of ['username_target', 'password_target', 'submit_target']) assert(targetOk(config[key]), `Login config ${key} must be an observed target`);
  for (const key of ['captcha_image_target', 'captcha_input_target', 'captcha_text_target']) if (config[key] !== undefined) assert(targetOk(config[key]), `Login config ${key} must be an observed target`);
  assert(checkOk(config.success_check, true), 'success_check needs an observed target, condition and case_id/title/expected');
  if (config.failure_check !== undefined) assert(checkOk(config.failure_check, false), 'failure_check must be a read-only UI check');
  if (config.test_code !== undefined) assert(typeof config.test_code === 'string' && config.test_code.length >= 1 && config.test_code.length <= 32, 'test_code must be the project-configured short test string');
  if (config.reuse_session !== undefined) assert(config.reuse_session && Object.keys(config.reuse_session).every(k => k === 'run_id') && /^run-[A-Za-z0-9-]+$/.test(config.reuse_session.run_id ?? ''), 'reuse_session needs an exact prior run_id');
  return config;
}

export function loadLoginConfig(dir, configPath, quote) {
  const path = resolve(dir, configPath);
  assert(existsSync(path), 'Login config must be an archived run input');
  const text = readFileSync(path, 'utf8');
  assert(typeof quote === 'string' && quote.trim() && text.includes(quote), 'Login config needs a verbatim supplied excerpt');
  return validateLoginConfig(JSON.parse(text));
}

// 会话固化元数据：不含 cookie/localStorage 值；存储本体单独 0600 保存且不进证据清单。
export function loginSessionMeta({ runId, origin, project, formTargets }) {
  return {
    version: 1, run_id: runId, origin, project, saved_at: new Date().toISOString(),
    form_signature_sha256: formTargets, storage_path: loginSessionFile,
    interpretation: '会话存储受保护保存，复用前必须重新验证登录信号；过期即重走策略链',
  };
}