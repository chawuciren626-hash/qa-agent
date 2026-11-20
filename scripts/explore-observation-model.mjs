/**
 * 探索语义证据模型（第一批：零 LLM 部分）。
 *
 * 为什么单独成模块：explore-authenticated.mjs 是带浏览器会话的执行脚本，不能在 CI 里
 * 直接跑；而证据的"成条规则"（哈希、去重、问题与规则生成）必须可确定性测试——这里
 * 只做纯函数，DOM 采集由脚本喂原始事实进来。
 *
 * 证据纪律（来自 browser-exploration-playbook 第 4/7 章，按本仓库口径落地）：
 *   - 逐字原样 + 规范化副本并存：verbatim 直接可断言，normalized 用于检索与去重；
 *   - 每条证据带内容哈希：多轮探索重复覆盖不产生冗余，哈希变化 = 站点改版信号；
 *   - verification 是枚举字段不是注释：本批只有 verified（直接观察）；
 *   - question / rule 是独立实体：question 进 qa_exploration_hypotheses（G4 回流的
 *     数据源），rule 进知识候选（所有者确认后版本化）——都不与 observation 混存。
 *
 * 诚实边界：本批只产 DOM 可静态提取的语义事实（价格/字段标签/选项列表）与由它们
 * 确定性推导的未知项。错误文案、状态转换需要真实交互，属会话侧证据轮（第二批），
 * 这里绝不虚构。
 */

import { createHash } from 'node:crypto';

const MAX_OBSERVATIONS_PER_PAGE = 50;
const MAX_OBSERVATIONS_PER_RUN = 200;
const MAX_QUESTIONS_PER_RUN = 10;
const MAX_RULES_PER_RUN = 20;
const MAX_SELECT_QUESTIONS = 3;
const MAX_FORM_QUESTIONS = 3;

/** 金额文本：$29.99 / ¥1,299 / €9.5——只认带货币符号的独立短文本，避免把版本号当价格。 */
const CURRENCY_TEXT = /^[¥$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*[元块钱]$/;

export const OBSERVATION_KINDS = ['price', 'field_label', 'option_list'];

function contentHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function toMinorUnits(verbatim) {
  const m = /(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/.exec(verbatim);
  if (!m) return null;
  const digits = m[1].replace(/,/g, '');
  const [int, frac = ''] = digits.split('.');
  return `${Number(int)}.${(frac + '00').slice(0, 2)}`.replace('.', '');
}

/**
 * 把一页的原始 DOM 事实整理成观察记录。raw 来自 explore-authenticated 的页面采集：
 *   { prices:[{verbatim, context, css, testid}], labels:[{verbatim, name, css}],
 *     options:[{verbatim, name, css}] }
 * 原始结构里的字段都是采集侧已经清洗过的短文本；本函数不做任何语义判断，只做
 * 规范化、哈希与封顶——判定规则变了改这里，浏览器脚本不动。
 */
export function buildPageObservations(page, raw) {
  const out = [];
  const push = (kind, verbatim, normalized, locators, context) => {
    if (out.length >= MAX_OBSERVATIONS_PER_PAGE) return;
    const clean = normalizeText(verbatim);
    if (!clean) return;
    const id = `obs-${contentHash({ kind, page, normalized, context: context ?? null, verbatim: clean })}`;
    out.push({
      id,
      page,
      kind,
      verbatim: clean,
      normalized,
      element: { locators },
      context: context ? normalizeText(context).slice(0, 120) : null,
      verification: 'verified',
      content_hash: contentHash({ kind, page, verbatim: clean, context: context ?? null }),
    });
  };
  for (const item of raw.prices ?? []) {
    const verbatim = normalizeText(item.verbatim);
    if (!CURRENCY_TEXT.test(verbatim)) continue;
    const minor = toMinorUnits(verbatim);
    if (minor === null) continue;
    push('price', verbatim, `price.${minor}`, locators(item), item.context);
  }
  for (const item of raw.labels ?? []) {
    push('field_label', item.verbatim, `field.${normalizeText(item.name || item.verbatim).toLowerCase().replace(/\s+/g, '_').slice(0, 60)}`,
      locators(item), null);
  }
  for (const item of raw.options ?? []) {
    push('option_list', item.verbatim, `options.${normalizeText(item.name || item.verbatim).slice(0, 60).replace(/\s+/g, '_').toLowerCase()}`,
      locators(item), null);
  }
  return out;
}

function locators(item) {
  const out = [];
  if (item.css) out.push({ type: 'css', value: item.css });
  if (item.testid) out.push({ type: 'testid', value: item.testid });
  if (item.verbatim) out.push({ type: 'text', value: normalizeText(item.verbatim).slice(0, 80) });
  return out;
}

/**
 * 由一轮全部观察推导「确定性未知项」与「可直接确认的固定事实」。
 *
 * questions 全部是可判定句子（qa_exploration_hypotheses.statement 的要求），
 * why_unknown 用库里的枚举：business / data / role / async / external。
 * facts: { authenticated:boolean, pagesOk:number, forms:[{page,label,fields:number}],
 *          selects:[{page,label}], pagination:boolean }
 */
export function buildQuestionsAndRules(observations, facts) {
  const questions = [];
  const pushQuestion = (statement, whyUnknown, expectation, evidenceIds, moduleKey) => {
    if (questions.length >= MAX_QUESTIONS_PER_RUN) return;
    const id = `q-${contentHash({ statement, moduleKey: moduleKey ?? null })}`;
    if (questions.some((q) => q.id === id)) return;
    questions.push({
      id, statement, why_unknown: whyUnknown, expectation,
      evidence_ids: evidenceIds, module_key: moduleKey ?? null,
      content_hash: contentHash({ statement, expectation }),
    });
  };

  // ① 表单校验规则：有字段就必有"提交了才知道"的校验语义——这是异常态矩阵的第一格。
  const forms = (facts.forms ?? []).slice(0, MAX_FORM_QUESTIONS);
  for (const form of forms) {
    pushQuestion(
      `表单「${form.label}」各字段的校验规则（必填/格式/长度）未确认`,
      'business',
      '逐字段提交空值与非法值，记录首个命中字段的逐字错误文案与校验优先级',
      observations.filter((o) => o.page === form.page && o.kind === 'field_label').slice(0, 5).map((o) => o.id),
      form.page,
    );
  }
  // ② 授权范围：登录成功只证明凭据被接受（探索回执的固定局限），会话能到哪是独立未知。
  if (facts.authenticated && (facts.pagesOk ?? 0) > 0) {
    pushQuestion(
      '登录会话可访问的页面与可执行操作范围未确认',
      'role',
      '以当前会话遍历已发现路由，记录访问被拒或被重定向的页面',
      [],
      null,
    );
  }
  // ③ 分页/排序：结构巡检看得到控件，看不到数据集怎么变。
  if (facts.pagination) {
    pushQuestion(
      '列表分页、排序与筛选的业务行为未确认',
      'async',
      '翻页/改排序后核对数据集变化与 URL/请求参数变化',
      observations.filter((o) => o.kind === 'option_list').slice(0, 3).map((o) => o.id),
      null,
    );
  }
  // ④ 下拉联动：选项列表拿到了，选了之后业务结果怎么变是独立未知。
  for (const select of (facts.selects ?? []).slice(0, MAX_SELECT_QUESTIONS)) {
    pushQuestion(
      `「${select.label}」选项与业务结果的联动未确认`,
      'business',
      '逐选项提交并记录结果差异（列表内容/跳转/报错）',
      observations.filter((o) => o.page === select.page && o.kind === 'option_list').slice(0, 2).map((o) => o.id),
      select.page,
    );
  }

  // 规则：只有"绑定到业务对象上下文"的固定事实才够格成规则——孤立的价格文本
  // （页面上随便一个数字）成不了「某商品定价 X」这样的可断言规则。
  const rules = [];
  for (const obs of observations) {
    if (rules.length >= MAX_RULES_PER_RUN) break;
    if (obs.kind !== 'price' || !obs.context) continue;
    const statement = `「${obs.context}」定价 ${obs.verbatim}（当前版本实测）`;
    const id = `rule-${contentHash({ statement })}`;
    if (rules.some((r) => r.id === id)) continue;
    rules.push({
      id, statement, kind: 'fixed_value', verification: 'verified',
      evidence_ids: [obs.id], content_hash: contentHash({ statement }),
    });
  }

  return { questions, rules };
}

/** 跨页去重：同一 run 内同页同元素重复出现只留一条（内容哈希即身份）。 */
export function dedupeObservations(all) {
  const seen = new Map();
  for (const obs of all) {
    if (!seen.has(obs.content_hash)) seen.set(obs.content_hash, obs);
  }
  return [...seen.values()].slice(0, MAX_OBSERVATIONS_PER_RUN);
}

/** 证据包落盘口径：version/mode/captured_at + 三类实体。 */
export function buildEvidenceBundle(mode, capturedAt, observations, questions, rules) {
  return {
    version: 1,
    mode,
    captured_at: capturedAt,
    observations,
    questions,
    rules,
    counts: {
      observations: observations.length,
      questions: questions.length,
      rules: rules.length,
    },
  };
}
