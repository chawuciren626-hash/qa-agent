/**
 * 部分成功通道（L-7 落地，对应 §25.2 P1-1）。
 *
 * **问题**：契约层是全有或全无——40 条需求抽到 38 条，整批阻塞；重试还是卡在那 2 条。
 * 结果是「为了 2 条，38 条一起等着」。这是把「完整性」当成了「原子性」，两者不是一回事。
 *
 * **决策**：给契约层一条 `partial` 通道——
 *
 *     accept: true, partial: true, missing_ids: ['REQ-0017', 'REQ-0023']
 *
 * 缺的进「待人工补」队列，其余照常进下一阶段。阻塞的应该是那 2 条，不是整批。
 *
 * **但要守住一条**：部分成功不等于降低标准。放行的那 38 条必须逐条合规；
 * 一条都不合规时不能 return partial:true 蒙混过去——那是把「部分成功」用成「失败也放行」。
 */

/**
 * 判定一次采集能不能部分放行。
 *
 * @param expectedIds 应有尽有的 ID（来自上游，比如需求台账声明的范围）
 * @param submitted   这次实际采到的条目 `{id, ...}`；其余字段由调用方按自己的 schema 校验
 * @param options.validId  条目是否合规的判据，默认「有非空 id」；返回 false 的条目**不算采到**
 * @param options.blockOn  这些 ID 缺失时整体阻塞（比如范围声明本身就没定下来）
 *
 * 三种结果：
 *   - `accepted`：一条不缺
 *   - `partial` ：缺了一部分，但采到的都合规且比例够高 → 值得往下走
 *   - `blocked` ：缺得太多（或范围未定），部分放行会让下游拿半张图去设计
 */
export function assessCollection(expectedIds, submitted, options = {}) {
  const fail = message => { throw new Error(`Invalid collection: ${message}`); };
  if (!Array.isArray(expectedIds)) fail('expectedIds must be an array');
  if (!Array.isArray(submitted)) fail('submitted must be an array');
  const expected = uniqueIds(expectedIds, fail, 'expectedIds');
  const entries = uniqueIds(submitted.map(entry => entry?.id), fail, 'submitted ids');
  const submittedSet = new Set(entries);

  const valid = typeof options.validId === 'function' ? options.validId : id => typeof id === 'string' && id.trim().length > 0;
  const accepted = entries.filter(id => valid(id));
  const rejected = entries.filter(id => !valid(id));
  const missing = expected.filter(id => !submittedSet.has(id));
  const unexpected = entries.filter(id => !expected.includes(id));

  const blockOn = new Set(Array.isArray(options.blockOn) ? options.blockOn : []);
  const blockedByScope = missing.filter(id => blockOn.has(id));

  // 覆盖率门槛：默认 80%。低于这个数还部分放行，下游就是在用不到一半的需求做设计，
  // 拿到的「部分成功」是假的成功。门槛可调，但**不能关**——`minCoverage: 0` 会被拒。
  const minCoverage = options.minCoverage ?? 0.8;
  if (typeof minCoverage !== 'number' || !(minCoverage > 0) || minCoverage > 1) fail('minCoverage must be in (0, 1]; there is no setting that lets an empty collection through');

  const coverage = expected.length === 0 ? 1 : accepted.length / expected.length;
  const base = {
    expected: expected.length,
    accepted: accepted.length,
    missing,
    unexpected,
    rejected,
    coverage: Math.round(coverage * 1000) / 1000,
  };

  // 采到的条目里有不合规的：那不是「缺」，那是「错」，必须打回重做而不是排队等人补。
  if (rejected.length) {
    return { ...base, status: 'blocked', partial: false, reason: `${rejected.length} 条采到的内容不合规（${rejected.slice(0, 5).join('、')}），这是错不是缺，需要重做而不是补录` };
  }
  if (!missing.length) return { ...base, status: 'accepted', partial: false, reason: '一条不缺' };
  if (blockedByScope.length) {
    return { ...base, status: 'blocked', partial: false, reason: `范围声明本身缺失（${blockedByScope.join('、')}），部分放行会让下游拿半张图去设计` };
  }
  if (accepted.length === 0) {
    return { ...base, status: 'blocked', partial: false, reason: '一条都没采到，不构成部分成功' };
  }
  if (coverage < minCoverage) {
    return { ...base, status: 'blocked', partial: false, reason: `覆盖率 ${(coverage * 100).toFixed(1)}% 低于门槛 ${(minCoverage * 100).toFixed(0)}%，半张图不足以支撑下游设计` };
  }
  return { ...base, status: 'partial', partial: true, reason: `缺 ${missing.length} 条（${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' 等' : ''}），其余 ${accepted.length} 条合规，放行` };
}

/** 待人工补队列。每一条都要能回答「缺什么、为什么缺、谁来补」。 */
export function toBacklog(assessment, { stage, at = new Date().toISOString() } = {}) {
  if (!assessment || typeof assessment !== 'object') throw new Error('toBacklog requires an assessment');
  return assessment.missing.map(id => ({
    id,
    stage: stage ?? null,
    kind: assessment.status === 'partial' ? 'awaiting_human_completion' : 'blocking',
    // 「为什么缺」不是已知的——不要在这里编一个理由，留空让人填。
    reason: null,
    detected_at: at,
  }));
}

/** 契约层要回给调用方的那一层结论。`accept` 与 `partial` 一起才能说清「放行了多少」。 */
export function contractDecision(assessment) {
  return {
    accept: assessment.status !== 'blocked',
    partial: assessment.status === 'partial',
    missing_ids: [...assessment.missing],
    coverage: assessment.coverage,
    reason: assessment.reason,
  };
}

/**
 * 下游拿到的这批条目该怎么标注。
 *
 * 部分放行时必须让**下游**知道这批是不完整的——否则它会在报告里写「已覆盖全部需求」。
 * 这不是防御性编程，是防止「部分成功」在上游被允许、在下游被忘掉。
 */
export function downstreamNote(assessment) {
  if (assessment.status === 'accepted') return null;
  if (assessment.status === 'partial') {
    return `本批基于 ${assessment.accepted}/${assessment.expected} 条（覆盖率 ${(assessment.coverage * 100).toFixed(1)}%），缺 ${assessment.missing.length} 条：${assessment.missing.join('、')}。下游结论不得表述为「已覆盖全部」。`;
  }
  return `本批未放行：${assessment.reason}`;
}

function uniqueIds(list, fail, label) {
  const out = [];
  const seen = new Set();
  for (const [index, value] of list.entries()) {
    if (typeof value !== 'string' || !value.trim()) fail(`${label}[${index}] is not a usable id`);
    if (seen.has(value)) fail(`${label} contains duplicate ${value}`);
    seen.add(value);
    out.push(value);
  }
  return out;
}
