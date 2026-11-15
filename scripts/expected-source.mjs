/**
 * 预期结果的来源与状态（架构方案 §6.4）。
 *
 * 为什么需要这个模块：一条用例「跑通」只证明执行没问题，不证明**预期是对的**。
 * 现状里需求项、测试点 `expected`、用例断言都由模型依次生产，闸门校验的是
 * 「断言是否回指测试点」——这是内部自洽。若第二环把「满100减10」读成「满100打9折」，
 * 测试点、断言、用例会一起错，而且一起自洽、一起通过，真实缺陷被错误预期盖住。
 *
 * 所以给每一条预期加两样东西：
 *   source: 它从哪来（doc 原文 / human 确认 / derived 从已确认规则推导 / model 模型生成）
 *   state:  它被谁认过（verified / unverified / drifted）
 *
 * 五条判定规则（R1~R5，与方案一致）：
 *   R1 无源的 decide 断言不进冒烟集——冒烟集是最常被当成「都绿了」看的那个集合。
 *   R2 模型推导不能自证：source.type=model 的断言永远是 unverified，只能由人转正。
 *   R3 一条用例的 decide 断言全部 unverified（含 drifted 折算）时，verdict 上限是
 *      inconclusive——不许出 pass。
 *   R4 一票通过制：pass 需要至少一条 verified 的 decide 断言；任何 verified 断言实际
 *      失败，整条即 fail（这条由执行层保证，本模块只给上限）。
 *   R5 drifted 的断言按 unverified 处理：状态是「预期改过太多次」，不是「预期更正过」。
 *
 * 做不到的（写在代码里，避免被当万能件）：
 *   - 本模块不比对 quote 与原文。原文比对复用 `requirement-provenance.mjs` 的 capture 校验，
 *     它保证 quote 是源文件里的连续原文；本模块只保证「有源、源类型合法、状态与源匹配」。
 *   - 本模块不判断「预期在语义上对不对」。它能把「没有依据的 pass」拦下来，不能把
 *     「有依据但读错的 pass」拦下来——后者要靠人复核与种子缺陷集。
 */

const text = value => typeof value === 'string' && value.trim().length > 0;
const fail = message => { throw new Error(`Expected provenance: ${message}`); };
const requireValue = (condition, message) => { if (!condition) fail(message); };
const fields = (value, allowed, label) => {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label}: 期望一个对象；允许字段：${allowed.join(', ')}`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  requireValue(!unknown.length, `${label}: 未知字段：${unknown.join(', ')}；允许字段：${allowed.join(', ')}。预期里的实质内容请放进 text，不要靠额外字段承载。`);
};

/** doc=文档原文；human=人工确认；derived=从已确认规则推导；model=模型生成。 */
export const sourceTypes = ['doc', 'human', 'derived', 'model'];
/** verified=有人认过；unverified=没认过；drifted=改过太多次，按未认过处理。 */
export const expectationStates = ['verified', 'unverified', 'drifted'];
/** decide=判定性断言（决定通过与否）；observe=观察性断言（只记录）。 */
export const assertionKinds = ['decide', 'observe'];
/** 可以被称为「认过」的来源：模型与推导都不行，必须有人签。 */
const verifiableTypes = new Set(['doc', 'human', 'derived']);

/**
 * drifted 折算成 unverified：状态字段表达的是「可信度」，不是「变更历史」。
 * 变更历史在 expectation-audit 里，两者不要混在一个字段里读。
 */
export const effectiveState = expectation => (expectation.state === 'drifted' ? 'unverified' : expectation.state ?? 'unverified');

export function inspectExpectation(value, label = 'expected') {
  fields(value, ['text', 'kind', 'source', 'state', 'verified_by', 'verified_at'], label);
  requireValue(text(value.text), `${label}.text 必须是非空文本`);
  const kind = value.kind ?? 'decide';
  requireValue(assertionKinds.includes(kind), `${label}.kind 无效：${JSON.stringify(value.kind)}；允许：${assertionKinds.join(', ')}`);
  const state = value.state ?? 'unverified';
  requireValue(expectationStates.includes(state), `${label}.state 无效：${JSON.stringify(value.state)}；允许：${expectationStates.join(', ')}`);
  if (value.verified_at !== undefined) requireValue(text(value.verified_at) && !Number.isNaN(Date.parse(value.verified_at)), `${label}.verified_at 必须是 ISO 时间`);

  if (kind === 'decide') {
    requireValue(value.source, `${label}: decide 断言必须有 source{type,ref,quote}；没有来源的判断不能决定一条用例的通过与否（观察性断言请用 kind=observe）`);
  }
  if (value.source !== undefined) {
    const source = value.source;
    fields(source, ['type', 'ref', 'quote'], `${label}.source`);
    requireValue(sourceTypes.includes(source.type), `${label}.source.type 无效：${JSON.stringify(source.type)}；允许：${sourceTypes.join(', ')}`);
    requireValue(text(source.ref), `${label}.source.ref 必填（文档段落号 / 确认记录 ID / 规则 ID）`);
    requireValue(text(source.quote), `${label}.source.quote 必填：没有原文的引用等于没有引用`);
    // R2：模型推导不能自证。
    requireValue(!(source.type === 'model' && state === 'verified'), `${label}: source.type=model 不能标记 verified——模型生成的预期只能由人转正（R2）`);
  }
  if (state === 'verified') {
    requireValue(value.source, `${label}: verified 必须带 source`);
    requireValue(verifiableTypes.has(value.source.type), `${label}: source.type=${value.source.type} 不能支撑 verified；只有 ${[...verifiableTypes].join('/')} 可以`);
    requireValue(text(value.verified_by) && value.verified_by.startsWith('human:'), `${label}: verified 必须由人签字（verified_by=human:<id>），agent 不能给自己发证书`);
  }
  return {
    text: value.text.trim(), kind, state,
    ...(value.source === undefined ? {} : { source: { type: value.source.type, ref: value.source.ref.trim(), quote: value.source.quote } }),
    ...(value.verified_by === undefined ? {} : { verified_by: value.verified_by }),
    ...(value.verified_at === undefined ? {} : { verified_at: value.verified_at }),
  };
}

/** 一条用例的预期集合。缺 expectations 视为空集合，而不是报错——旧用例要能读，只是判不了 pass。 */
export function inspectCaseExpectations(testCase, label = 'case') {
  requireValue(testCase && typeof testCase === 'object', `${label}: 期望一个对象`);
  const raw = testCase.expectations ?? [];
  requireValue(Array.isArray(raw), `${label}.expectations 必须是数组`);
  const expectations = raw.map((item, index) => inspectExpectation(item, `${label}.expectations[${index}]`));
  return { caseId: testCase.id ?? testCase.caseId ?? label, expectations };
}

/**
 * R1：能否进冒烟集。
 * 冒烟集的门槛不是「全部 verified」——那会让冒烟集长期空着，团队就绕过它；
 * 门槛是「每条 decide 断言都有来源，且没有 drifted」。unverified 但写明来源的可以进，
 * 因为它至少能被追溯；没有来源的不行，因为它连错在哪都说不清。
 */
export function smokeEligible(testCase) {
  // 这里刻意不做严格校验：冒烟选集遇到结构不合法的用例应当「排除并说明」，
  // 而不是让整轮选集崩掉——选集崩了，团队会绕过冒烟直接跑全量。
  const raw = Array.isArray(testCase?.expectations) ? testCase.expectations : [];
  const decide = raw.filter(item => item && typeof item === 'object' && (item.kind ?? 'decide') === 'decide');
  if (!decide.length) return { eligible: false, reason: '没有 decide 断言：无法判断通过与否' };
  const unsourced = decide.filter(item => !item.source || !text(item.source?.ref) || !text(item.source?.quote));
  if (unsourced.length) return { eligible: false, reason: `${unsourced.length} 条 decide 断言没有来源（R1）` };
  const drifted = decide.filter(item => item.state === 'drifted');
  if (drifted.length) return { eligible: false, reason: `${drifted.length} 条 decide 断言处于 drifted（R5）` };
  return { eligible: true, reason: '每条 decide 断言都有来源' };
}

/** R3/R5：这条用例的 verdict 上限。只有 pass 会被拉低，fail 不受影响。 */
export function verdictCeiling(testCase) {
  const { expectations } = inspectCaseExpectations(testCase);
  const decide = expectations.filter(item => item.kind === 'decide');
  if (!decide.length) return { ceiling: 'inconclusive', verified: 0, total: 0, reason: '没有 decide 断言，只能出 inconclusive' };
  const verified = decide.filter(item => effectiveState(item) === 'verified');
  if (!verified.length) {
    return { ceiling: 'inconclusive', verified: 0, total: decide.length, reason: `${decide.length} 条 decide 断言均未被人工确认（R3）；drifted 按未确认计（R5）` };
  }
  return { ceiling: 'pass', verified: verified.length, total: decide.length, reason: `${verified.length}/${decide.length} 条 decide 断言已确认` };
}

/**
 * 把执行结论套上上限。这是报告层唯一应该调用的入口：
 * 直接把执行器的 pass 写进报告，等于让「预期没被认过」的用例也算通过。
 */
export function applyCeiling(intended, testCase) {
  requireValue(['pass', 'fail', 'inconclusive', 'blocked'].includes(intended), `未知的执行结论：${JSON.stringify(intended)}`);
  if (intended !== 'pass') return { verdict: intended, downgraded: false, ...verdictCeiling(testCase) };
  const ceiling = verdictCeiling(testCase);
  if (ceiling.ceiling === 'pass') return { verdict: 'pass', downgraded: false, ...ceiling };
  return { verdict: 'inconclusive', downgraded: true, ...ceiling };
}

/** 批量体检：给报告一份「哪些 pass 不可信」的清单。 */
export function auditExpectations(testCases) {
  requireValue(Array.isArray(testCases), 'auditExpectations 需要用例数组');
  const rows = [];
  const totals = { cases: 0, assertions: 0, verified: 0, unverified: 0, drifted: 0, withoutSource: 0 };
  for (const testCase of testCases) {
    const { caseId, expectations } = inspectCaseExpectations(testCase, String(testCase?.id ?? testCase?.caseId ?? `case[${totals.cases}]`));
    totals.cases += 1;
    totals.assertions += expectations.length;
    for (const item of expectations) {
      totals[item.state] = (totals[item.state] ?? 0) + 1;
      if (!item.source) totals.withoutSource += 1;
    }
    const ceiling = verdictCeiling(testCase);
    const smoke = smokeEligible(testCase);
    rows.push({
      caseId, ceiling: ceiling.ceiling, verified: ceiling.verified, total: ceiling.total,
      smokeEligible: smoke.eligible, reason: ceiling.ceiling === 'pass' ? ceiling.reason : `${ceiling.reason}；${smoke.reason}`,
    });
  }
  const blocked = rows.filter(row => row.ceiling !== 'pass');
  return {
    summary: totals,
    rows,
    // 「能出 pass」的用例占比：这个数比通过率重要，它是通过率的分母修正。
    passEligibleRatio: rows.length ? Number(((rows.length - blocked.length) / rows.length).toFixed(4)) : 0,
    blocking: blocked,
  };
}

/** 报告里的一句话结论，避免每个调用方各写一套措辞。 */
export function describeExpectationAudit(audit) {
  const { summary } = audit;
  if (!summary.cases) return '没有用例，无法评估预期可信度。';
  const percent = Math.round(audit.passEligibleRatio * 100);
  const head = `${summary.cases} 条用例中 **${percent}%** 的预期足以支撑 pass 结论`;
  const detail = `（${summary.assertions} 条断言：${summary.verified} 已确认 / ${summary.unverified} 未确认 / ${summary.drifted} drifted / ${summary.withoutSource} 无来源）`;
  return audit.blocking.length ? `${head}${detail}；其余 ${audit.blocking.length} 条只能出 inconclusive。` : `${head}${detail}。`;
}
