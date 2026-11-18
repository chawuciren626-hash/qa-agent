/**
 * 变更影响选集（批次 5，对应 v3 §13.2「选集五触发源」+ 可解释性）。
 *
 * 参考实现是 `aitestharness-tools/aitestharness_tools/regression/impact.py`；
 * 这里落成 JS 执行层，并在参考实现之上补一条硬要求：
 *
 *   **同一变更，两次选集必须完全一致。**
 *
 * 「AI 帮你选了 42 条」要能被复算——同一份变更输入哪怕用例清单顺序不同、
 * 变更列表有重复项、多跑一遍，选出的集合与理由都必须逐字节相同。
 * 为此本模块做了三件参考实现没写死的事：
 *   1. 输入归一化：变更列表去重排序，用例清单按 id 排序后再遍历——
 *      理由的累积顺序不再依赖调用方给数组的顺序；
 *   2. 输出规范化：每条理由按 (reliability, source, reason) 排序，
 *      reasons 键按 id 排序构建（JSON.stringify 才是稳定的）；
 *   3. selection_fingerprint：对规范化后的 {selected, reasons} 取 sha256，
 *      稳定性检查从「肉眼看两遍」变成「比一个哈希」。
 *
 * 触发源按可靠性排序（§13.2 原文）：
 *   ① 显式指定（人勾选） ② 需求变更溯源 ③ 代码变更影响 ④ 依赖传递（片段）
 *   ⑤ 历史相似（只选不判）
 */

import { createHash } from 'node:crypto';

export const SOURCES_BY_RELIABILITY = Object.freeze([
  'explicit',
  'requirement_change',
  'code_change',
  'dependency',
  'history_similar',
]);

/** 字符串数组入参归一化：拒绝非数组、剥空白、去空串、去重、排序。 */
function normalizeStringList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} expects an array of strings`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label} expects strings, got ${typeof item}`);
    const trimmed = item.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort();
}

/** 片段标识归一化：`frag-login@2` → `frag-login`（版本不是触发键，f.id 才是）。 */
function fragmentKey(fragment) {
  const raw = typeof fragment === 'string' ? fragment : fragment?.id;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.split('@')[0].trim();
}

/**
 * 理由的规范化排序键：可靠性优先，其次按来源与理由文本排序。
 * 同一条用例被多个触发源命中时，输出顺序不随触发源被处理的顺序漂移。
 */
function reasonSortKey(reason) {
  return [reason.reliability, reason.source, reason.reason].join('\u0000');
}

/**
 * 按五个触发源选集，输出可解释的选中理由与稳定指纹。
 *
 * 入参（与 regression.impact 工具签名一致）：
 *   explicit_ids          人勾选的用例 id
 *   changed_requirements  变更的需求 id
 *   changed_modules       变更的代码模块
 *   changed_fragments     变更的片段（可带 @version）
 *   similar_cases         历史相似用例 id（只选不判）
 *   cases                 [{id, derived_from_requirements, modules, fragments}]
 *   quarantine_ids        隔离区名单：命中也不选（隔离用例不进回归）
 *
 * 返回 {kind, selected, reasons, selection_fingerprint, explainable, unselected_risk}
 */
export function selectByChange({
  explicit_ids,
  changed_requirements,
  changed_modules,
  changed_fragments,
  similar_cases,
  cases,
  quarantine_ids,
} = {}) {
  const explicit = normalizeStringList(explicit_ids, 'explicit_ids');
  const reqs = new Set(normalizeStringList(changed_requirements, 'changed_requirements'));
  const mods = new Set(normalizeStringList(changed_modules, 'changed_modules'));
  const frags = new Set(
    normalizeStringList(changed_fragments, 'changed_fragments').map(fragmentKey),
  );
  const similar = normalizeStringList(similar_cases, 'similar_cases');
  const quarantine = new Set(normalizeStringList(quarantine_ids, 'quarantine_ids'));

  if (cases !== undefined && !Array.isArray(cases)) {
    throw new Error('cases expects an array');
  }
  for (const testCase of cases ?? []) {
    if (!testCase || typeof testCase.id !== 'string' || !testCase.id.trim()) {
      throw new Error('each case needs a non-empty string id');
    }
  }

  const reasons = new Map(); // case_id -> reasons[]（累积后统一排序）
  const add = (caseId, source, reason) => {
    if (quarantine.has(caseId)) return; // 隔离区纪律：命中也不进回归选集
    const list = reasons.get(caseId) ?? [];
    list.push({ source, reason, reliability: SOURCES_BY_RELIABILITY.indexOf(source) });
    reasons.set(caseId, list);
  };

  for (const caseId of explicit) add(caseId, 'explicit', '人工显式指定');

  // 用例按 id 排序遍历：两条用例命中同一触发源时，谁先进 reasons 不看调用方给数组的顺序。
  const sortedCases = [...(cases ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const testCase of sortedCases) {
    const caseId = testCase.id;
    if (explicit.includes(caseId)) continue; // 显式指定已给理由，不重复累计
    for (const req of testCase.derived_from_requirements ?? []) {
      if (typeof req === 'string' && reqs.has(req.trim())) {
        add(caseId, 'requirement_change', `source:${req.trim()}`);
        break;
      }
    }
    const hitModules = (testCase.modules ?? [])
      .filter(mod => typeof mod === 'string' && mods.has(mod.trim()))
      .map(mod => mod.trim())
      .sort();
    if (hitModules.length) add(caseId, 'code_change', `module:${hitModules[0]}`);
    for (const fragment of testCase.fragments ?? []) {
      const key = fragmentKey(fragment);
      if (key && frags.has(key)) {
        const version = typeof fragment === 'object' && fragment?.version !== undefined
          ? `@${fragment.version}`
          : '@?';
        add(caseId, 'dependency', `fragment:${key}${version}`);
        break;
      }
    }
  }
  for (const caseId of similar) add(caseId, 'history_similar', '相似用例兜底（只选不判）');

  // 输出规范化：selected 排序；每条理由列表排序；reasons 键按 id 排序构建。
  const selected = [...reasons.keys()].sort();
  const orderedReasons = {};
  for (const caseId of selected) {
    orderedReasons[caseId] = reasons
      .get(caseId)
      .sort((a, b) => (reasonSortKey(a) < reasonSortKey(b) ? -1 : 1));
  }

  // 稳定指纹：只对 {selected, reasons} 的规范化 JSON 取哈希。
  // 两次调用指纹相同 ⇔ 选集与理由逐字节相同。
  const canonical = JSON.stringify({ selected, reasons: orderedReasons });
  const fingerprint = createHash('sha256').update(canonical).digest('hex').slice(0, 16);

  return {
    kind: 'regression-impact-selection',
    generated_at: new Date().toISOString(),
    selected,
    reasons: orderedReasons,
    selection_fingerprint: fingerprint,
    explainable: selected.every(caseId => orderedReasons[caseId].length > 0),
    unselected_risk: {
      note: '未选中用例不代表无风险；影响覆盖度按本结果计算（§13.4）',
      total_cases: (cases ?? []).length,
      selected_count: selected.length,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const usage = '用法：node scripts/regression-impact.mjs select <input.json>  # 输入含五触发源与 cases，输出选集 JSON';
  const [command, inputPath] = process.argv.slice(2);
  if (command !== 'select' || !inputPath) {
    console.error(usage);
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const input = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  console.log(JSON.stringify(selectByChange(input), null, 2));
}
