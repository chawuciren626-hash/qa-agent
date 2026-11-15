/**
 * 预期结果的写入权与变更审计（架构方案 §17.8）。
 *
 * 要堵的那条通路，长这个样子：
 *
 *     执行 fail → agent 归因 → agent 说「预期写错了」→ 改 expected → 重跑 → pass
 *
 * 它每一步都合规，而且比伪造 engine_version 自然得多——「预期写错了当然要改」，
 * 谁都不会觉得可疑。三个月后通过率 95%，缺陷密度不变。
 *
 * 规则按**来源**分级，不按字段分级（按字段分级可以靠换字段绕过）：
 *   - source.type=doc / human / derived，且由人提案 → 立即生效（人是责任主体，但必须留痕）
 *   - source.type=model，或提案人是 agent        → 进待审队列，人批了才生效
 *
 * 另外两条计数规则：
 *   - 同一断言一个版本周期内变更 ≥ driftThreshold（默认 2）次 → 标 drifted（交回
 *     expected-source 的 R5：drifted 按未确认处理），防止「反复微调直到跑通」。
 *   - 一轮内改动预期的用例占比 > 5% → 阻塞并提示复核需求阶段。单条改是修预期，
 *     大面积改是需求理解出了系统性偏差，那时候该回去看需求，不是继续改断言。
 */

import { sourceTypes } from './expected-source.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const fail = message => { throw new Error(`Expectation audit: ${message}`); };
const requireValue = (condition, message) => { if (!condition) fail(message); };
const STATUS = new Set(['pending', 'applied', 'approved', 'rejected']);
/** 已生效：applied（人直接改）与 approved（人批了 agent 的提案）。 */
const EFFECTIVE = new Set(['applied', 'approved']);
const MIN_REASON = 4;

export class ExpectationAuditQueue {
  constructor({ version = 1, maxChangeRatio = 0.05, driftThreshold = 2 } = {}) {
    requireValue(version === 1, `不支持的队列版本：${version}`);
    requireValue(typeof maxChangeRatio === 'number' && maxChangeRatio > 0 && maxChangeRatio <= 1, 'maxChangeRatio 必须在 (0,1] 之间');
    requireValue(Number.isSafeInteger(driftThreshold) && driftThreshold >= 2, 'driftThreshold 必须是不小于 2 的整数（只改一次不算漂移）');
    this.version = version;
    this.maxChangeRatio = maxChangeRatio;
    this.driftThreshold = driftThreshold;
    this.items = [];
    this.seq = 0;
  }

  /**
   * 提案一次预期变更。返回落库后的记录。
   * `assertion` 是断言在用例内的稳定标识（如 `expected[0]` 或断言 id），
   * 用下标在断言重排后会串号，调用方应优先给 id。
   */
  propose({ caseId, assertion, before, after, reason, by, executionId, sourceType = 'human' } = {}) {
    requireValue(text(caseId), 'caseId 必填');
    requireValue(text(assertion), 'assertion 必填');
    requireValue(text(by) && (by.startsWith('agent:') || by.startsWith('human:')), '提案人必须是 agent:<id> 或 human:<id>，不接受匿名改动');
    requireValue(text(reason) && reason.trim().length >= MIN_REASON, `变更理由必填且不少于 ${MIN_REASON} 个字；没有理由的改动等于运行期悄悄改资产`);
    requireValue(typeof before === 'string' && typeof after === 'string', 'before/after 必须是字符串（空字符串表示从无到有或从有到无）');
    requireValue(before !== after, 'before 与 after 相同，没有需要审批的变更');
    requireValue(sourceTypes.includes(sourceType), `未知来源类型：${JSON.stringify(sourceType)}；允许：${sourceTypes.join(', ')}`);

    // 模型来源的预期永远走待审：它不能自己给自己找台阶下。
    const pending = by.startsWith('agent:') || sourceType === 'model';
    const now = new Date().toISOString();
    const record = {
      proposalId: `exp_${String(++this.seq).padStart(4, '0')}`,
      caseId: caseId.trim(),
      assertion: assertion.trim(),
      before,
      after,
      reason: reason.trim(),
      by,
      sourceType,
      status: pending ? 'pending' : 'applied',
      ...(text(executionId) ? { executionId } : {}),
      createdAt: now,
      ...(pending ? {} : { decidedAt: now, decidedBy: by }),
    };
    this.items.push(record);
    return { ...record };
  }

  /** 人工批准一条待审提案。批准只能由人做，且必须给出理由。 */
  approve(proposalId, { by, reason } = {}) {
    const record = this.#require(proposalId);
    requireValue(record.status === 'pending', `只能批准待审提案，当前状态：${record.status}`);
    requireValue(text(by) && by.startsWith('human:'), '批准必须由人签字（by=human:<id>）');
    requireValue(text(reason) && reason.trim().length >= MIN_REASON, `批准理由必填且不少于 ${MIN_REASON} 个字`);
    record.status = 'approved';
    record.decidedAt = new Date().toISOString();
    record.decidedBy = by.trim();
    record.decisionReason = reason.trim();
    return { ...record };
  }

  reject(proposalId, { by, reason } = {}) {
    const record = this.#require(proposalId);
    requireValue(record.status === 'pending', `只能驳回待审提案，当前状态：${record.status}`);
    requireValue(text(by) && by.startsWith('human:'), '驳回必须由人签字（by=human:<id>）');
    requireValue(text(reason) && reason.trim().length >= MIN_REASON, '驳回理由必填：不写理由，下一个人会再提一遍');
    record.status = 'rejected';
    record.decidedAt = new Date().toISOString();
    record.decidedBy = by.trim();
    record.decisionReason = reason.trim();
    return { ...record };
  }

  list({ status } = {}) {
    if (status === undefined) return this.items.map(item => ({ ...item }));
    requireValue(STATUS.has(status), `未知状态：${status}`);
    return this.items.filter(item => item.status === status).map(item => ({ ...item }));
  }

  pending() { return this.list({ status: 'pending' }); }

  /** 某条用例已生效的预期变更（不含被驳回的）。 */
  changesOf(caseId) {
    return this.items.filter(item => item.caseId === caseId && EFFECTIVE.has(item.status));
  }

  /** 漂移判定：同一断言在本周期内被改到第 N 次就把整条用例标出来。 */
  driftedCases() {
    const counts = new Map();
    for (const item of this.items) {
      if (!EFFECTIVE.has(item.status)) continue;
      const key = `${item.caseId}\u0000${item.assertion}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const cases = new Map();
    for (const [key, count] of counts) {
      if (count < this.driftThreshold) continue;
      const [caseId, assertion] = key.split('\u0000');
      const entry = cases.get(caseId) ?? { caseId, changes: 0, assertions: [] };
      entry.changes += count;
      entry.assertions.push({ assertion, changes: count });
      cases.set(caseId, entry);
    }
    return [...cases.values()];
  }

  /**
   * 一轮之内大面积改预期 → 阻塞。
   * `casesInCycle` 是本轮参与评估的用例总数（分支/版本周期内的存量），不是「本轮跑了几条」。
   */
  assess({ casesInCycle } = {}) {
    requireValue(Number.isSafeInteger(casesInCycle) && casesInCycle > 0, 'casesInCycle 必须是正整数：没有分母就算不出比例');
    const changed = new Set(this.items.filter(item => EFFECTIVE.has(item.status)).map(item => item.caseId));
    const ratio = changed.size / casesInCycle;
    const blocked = ratio > this.maxChangeRatio;
    return {
      blocked,
      ratio: Number(ratio.toFixed(4)),
      threshold: this.maxChangeRatio,
      changedCases: changed.size,
      casesInCycle,
      message: blocked
        ? `本轮 ${casesInCycle} 条用例中有 ${changed.size} 条（${Math.round(ratio * 100)}%）修改了预期，超过 ${Math.round(this.maxChangeRatio * 100)}% 阈值。先复核需求阶段，再继续改断言——大面积改预期通常意味着需求理解出了系统性偏差。`
        : `${casesInCycle} 条用例中有 ${changed.size} 条（${Math.round(ratio * 100)}%）修改了预期，在 ${Math.round(this.maxChangeRatio * 100)}% 阈值内。`,
    };
  }

  /** 待审 + 漂移 + 比例，一次性给报告层用。 */
  health({ casesInCycle } = {}) {
    const pending = this.pending();
    const drifted = this.driftedCases();
    return {
      pending: pending.length,
      pendingCases: [...new Set(pending.map(item => item.caseId))].length,
      drifted,
      ...(casesInCycle === undefined ? {} : { cycle: this.assess({ casesInCycle }) }),
    };
  }

  #require(proposalId) {
    const record = this.items.find(item => item.proposalId === proposalId);
    requireValue(record, `提案不存在：${proposalId}`);
    return record;
  }

  toJSON() {
    return { version: this.version, maxChangeRatio: this.maxChangeRatio, driftThreshold: this.driftThreshold, seq: this.seq, items: this.items };
  }

  static fromJSON(data) {
    requireValue(data && typeof data === 'object', '队列数据必须是对象');
    const queue = new ExpectationAuditQueue(data);
    requireValue(Array.isArray(data.items), 'items 必须是数组');
    for (const item of data.items) {
      requireValue(STATUS.has(item.status), `未知状态：${item.status}`);
      queue.items.push({ ...item });
    }
    queue.seq = Number.isSafeInteger(data.seq) ? data.seq : queue.items.length;
    return queue;
  }
}

/** 报告的固定措辞：把「有多少 pass 不可信」说成一句人能直接引用的话。 */
export function describeExpectationHealth(health) {
  const parts = [`${health.pending} 条待审提案（涉及 ${health.pendingCases} 条用例）`];
  if (health.drifted.length) parts.push(`${health.drifted.length} 条用例的预期反复变更，已按 drifted 处理`);
  if (health.cycle) parts.push(health.cycle.message);
  return parts.join('；') + '。';
}
