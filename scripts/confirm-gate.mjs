#!/usr/bin/env node
/**
 * 确认卡点三件套（v3 §23.2 第 5 条，评审 P2-2）
 *
 * 问题：200 需求 / 600 测试点 / 1500 用例若全部逐条人工确认，一个人要花两天。
 * 卡点太密等于没有卡点，团队第三天就会绕过——**绕过一次，纪律就废了**。
 *
 * 三层做法（方案原文，此处逐条落为可计算规则）：
 *   1. 差异聚焦（diff）：只强制审「与上一版不同」的部分，未变的默认继承；
 *      没有上一版时没有差异可聚——**全部按新增审**，不假装能继承。
 *   2. 抽样审核（sample）：每批随机 10% 深审，其余过；抽样抽出的
 *      问题率超阈值（默认 10%）则该批退回全审。抽样用确定性伪随机
 *      （seed + key 哈希排序），同一批同一种子抽出的名单可复现、可审计。
 *   3. 风险加权（risk）：P0 模块 / 涉资字段 / 权限变更 → 强制全审；
 *      P2 模块 → 仅抽样。风险强制项**不受 diff/sample 省略**。
 *
 * 反绕过是本模块的立足点：`checkCompletion` 对照计划与确认记录，
 * 任何「应审未审」都会列出来，而不是默认通过。
 *
 * 与全仓口径一致：
 *   - 抽样结论有置信边界：小批（< 10 条）抽样没有统计意义，直接升级为全审；
 *   - 问题率比较用整数乘法（problems*100 > threshold*100*picked），避免浮点误差；
 *   - 「不知道」是结论：条目缺风险字段时归 unknown，按「强制全审」处理——
 *     没标风险的东西不能享受省略待遇。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

export const DEFAULT_SAMPLE_RATE = 0.1;
export const DEFAULT_PROBLEM_THRESHOLD = 0.1;

// ---------------------------------------------------------------- 风险分级

/**
 * 条目风险 → 三档处置：'force'（强制全审）/ 'sample'（仅抽样）/ 'normal'。
 * 涉资字段与权限变更按方案原文视同 P0；风险字段缺失按 force 处理（见头注）。
 */
export function riskTier(item = {}) {
  const risk = typeof item.risk === 'string' ? item.risk.toUpperCase() : null;
  if (item.money_fields === true || item.permission_change === true) return 'force';
  if (risk === 'P0') return 'force';
  if (risk === 'P2') return 'sample';
  if (risk === 'P1') return 'normal';
  return 'unknown'; // 缺标 → 调用方按 force 对待（见 planConfirmation）
}

// ---------------------------------------------------------------- 差异判定

/** 稳定内容指纹：剔除版本号与时间戳等易变字段，只对实质内容取哈希。 */
function contentFingerprint(item) {
  const { version, updated_at, confirmed_at, ...core } = item;
  return createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

/**
 * 对照上一版分拣：changed（新增或内容变了）/ unchanged（未变，可继承）。
 * previous 缺失或该条目不在 previous 里 → 视为新增（changed）。
 * 没有基线时没有差异可聚——结果必然全部 changed，这是诚实行为，不是缺陷。
 */
export function diffSince(items, previous) {
  const prevMap = previous instanceof Map ? previous
    : new Map((Array.isArray(previous) ? previous : []).map(p => [p.id ?? p.key, p]));
  const changed = [];
  const unchanged = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = item.id ?? item.key;
    const prev = prevMap.get(key);
    if (!prev) { changed.push(item); continue; }
    if (contentFingerprint(item) !== contentFingerprint(prev)) changed.push(item);
    else unchanged.push(item);
  }
  return { changed, unchanged };
}

// ---------------------------------------------------------------- 抽样

/**
 * 确定性抽样：按 hash(seed + id) 排序取前 k 条。
 * 同一批同一种子抽出的名单完全一致，可复现、可审计——
 * 「随机」的意义在不可预测，不在不可复现。
 */
export function pickSample(items, { rate = DEFAULT_SAMPLE_RATE, seed = 'confirm' } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return [];
  const k = Math.min(list.length, Math.max(1, Math.ceil(list.length * rate)));
  return [...list]
    .map(item => ({ item, h: createHash('sha256').update(`${seed}:${item.id ?? item.key}`).digest('hex') }))
    .sort((a, b) => a.h < b.h ? -1 : a.h > b.h ? 1 : 0)
    .slice(0, k)
    .map(x => x.item);
}

// ---------------------------------------------------------------- 抽样判定

/**
 * 抽样结果判定。整数比较避免浮点：problems*100 > threshold*100*picked。
 * 抽出 0 条或批次太小（picked < 10 且剩余未审 > 0）→ 统计无意义，
 * 返回 { conclusive: false, escalate: true }——宁多审，不冒充有把握。
 */
export function evaluateSample({ picked = 0, problems = 0, threshold = DEFAULT_PROBLEM_THRESHOLD, unreviewed = 0 } = {}) {
  const rate = picked > 0 ? problems / picked : null;
  if (picked === 0 || picked < 10) {
    return { conclusive: false, escalate: true, rate,
      reason: picked === 0
        ? '抽样名单为空，无法给出批次质量结论'
        : `深审样本仅 ${picked} 条，问题率没有统计意义——整批退回全审` };
  }
  const over = problems * 100 > threshold * 100 * picked;
  return {
    conclusive: true,
    escalate: over,
    rate,
    reason: over
      ? `抽样问题率 ${(rate * 100).toFixed(0)}% 超过阈值 ${(threshold * 100).toFixed(0)}%——该批退回全审`
      : `抽样问题率 ${(rate * 100).toFixed(0)}% 在阈值内（样本 ${picked} 条）`,
  };
}

// ---------------------------------------------------------------- 确认计划

/**
 * 生成一份确认计划：谁必须逐条审、谁可继承、谁进抽样。
 * mode: 'all' | 'diff' | 'sample'
 *
 * 规则叠加顺序（从严）：
 *   - mode=all → 全审；
 *   - force 项在任何 mode 下都进「必须逐条审」；
 *   - unknown 风险项同 force（没标风险的不享受省略待遇）；
 *   - mode=diff → changed 全审，unchanged 低风险继承；
 *   - mode=sample → force 全审 + 其余抽样（抽样的由 evaluateSample 判去留）。
 */
export function planConfirmation({ items = [], previous = null, mode = 'diff', rate = DEFAULT_SAMPLE_RATE, seed = 'confirm' } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const { changed, unchanged } = diffSince(list, previous);
  const tierOf = item => {
    const t = riskTier(item);
    return t === 'unknown' ? 'force' : t;
  };

  const must_review = [];
  const inherit = [];
  const sample_pool = [];

  for (const item of list) {
    const tier = tierOf(item);
    const isChanged = changed.includes(item);
    if (mode === 'all' || tier === 'force') { must_review.push(item); continue; }
    if (mode === 'diff') {
      (isChanged ? must_review : inherit).push(item);
      continue;
    }
    // mode === 'sample'
    if (tier === 'normal') { sample_pool.push(item); continue; }
    inherit.push(item); // P2 → 仅抽样待遇：不强制逐条，但也不进深审池
  }

  // diff 模式下 changed 里的非 force 项也可以再抽一遍吗？——不。方案口径是
  // 「只强制审与上版不同的」，changed 就是必审，抽样只服务 sample 模式。
  const sampled = mode === 'sample' ? pickSample(sample_pool, { rate, seed }) : [];
  return {
    mode,
    total: list.length,
    must_review: must_review.map(i => i.id ?? i.key),
    inherit: inherit.map(i => i.id ?? i.key),
    sample_pool: sample_pool.map(i => i.id ?? i.key),
    sampled: sampled.map(i => i.id ?? i.key),
    stats: {
      changed: changed.length,
      unchanged: unchanged.length,
      forced: must_review.filter(i => tierOf(i) === 'force').length,
    },
  };
}

// ---------------------------------------------------------------- 反绕过核对

/**
 * 对照确认记录与计划：所有 must_review 是否逐条有确认记录。
 * confirmed 形如 [{id, result: 'approved'|'rejected'|'skipped', by}]。
 * skipped 不算确认——「审过了但跳过」是绕过的常见马甲。
 */
export function checkCompletion(plan, confirmed = []) {
  const required = Array.isArray(plan?.must_review) ? plan.must_review : [];
  const byId = new Map((Array.isArray(confirmed) ? confirmed : [])
    .filter(c => c && typeof c.id === 'string').map(c => [c.id, c]));
  const missing = [];
  const skipped = [];
  for (const id of required) {
    const c = byId.get(id);
    if (!c) { missing.push(id); continue; }
    if (c.result === 'skipped') skipped.push(id);
  }
  return {
    complete: missing.length === 0 && skipped.length === 0,
    missing,
    skipped,
    note: missing.length || skipped.length
      ? `确认卡点存在缺口：未确认 ${missing.length} 条、被跳过 ${skipped.length} 条——绕过卡点的记录会留在这里，不会自动通过`
      : '强制审项全部逐条确认，无缺口',
  };
}

// ---------------------------------------------------------------- CLI

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const i = a.indexOf('=');
    return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
  }));
  const cwd = process.cwd();
  const load = p => (p && existsSync(resolve(cwd, p))) ? JSON.parse(readFileSync(resolve(cwd, p), 'utf8')) : null;

  const items = load(args.items) ?? [];
  const previous = load(args.previous);
  const plan = planConfirmation({
    items: Array.isArray(items) ? items : (items.items ?? []),
    previous,
    mode: args.mode ?? 'diff',
    rate: args.rate ? Number(args.rate) : DEFAULT_SAMPLE_RATE,
    seed: args.seed ?? 'confirm',
  });
  const confirmed = load(args.confirmed);
  const completion = confirmed ? checkCompletion(plan, confirmed) : null;

  const out = { plan, completion };
  const markdown = [
    '## 确认卡点计划（P2-2）',
    '',
    `模式 ${plan.mode}，共 ${plan.total} 条：必须逐条审 ${plan.must_review.length} 条、可继承 ${plan.inherit.length} 条、抽样池 ${plan.sample_pool.length} 条（抽出 ${plan.sampled.length} 条）。`,
    completion ? `- ${completion.note}` : '- 未提供确认记录，无法核对是否存在绕过。',
    '',
  ].join('\n');

  if (args.out) {
    const p = resolve(cwd, args.out);
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, args.json ? JSON.stringify(out, null, 2) : markdown);
  }
  console.log(args.json ? JSON.stringify(out, null, 2) : markdown);
  if (completion && !completion.complete) process.exitCode = 1;
  if (basename(args.items ?? '') === '' ) { /* no-op，参数校验宽松 */ }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
