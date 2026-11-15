/**
 * 阶段作用域与产物失效（L-2 + L-11 落地）。
 *
 * 解决两个在真项目上必然暴露的问题：
 *
 * **P0-4 单状态机不支持多模块并行。** 产物表按「产物 kind」单键存，`design/test_cases.json`
 * 只有一个槽位，于是订单模块和支付模块的用例互相覆盖——先跑那份的 `derived_from` 指向的
 * 需求版本就此丢失，而且不报错。这里把「哪个模块的产物」显式写进状态记录，模块间真实
 * 依赖必须声明 `depends_on`。
 *
 * **P0-3 失效粒度不匹配。** 改一句话就让整个阶段作废，1500 条用例全部失效；而增量重算算出来
 * 只有 12 条受影响。两个模块单独都对，接起来编排层两难。这里把「失效」拆成三级：
 *
 *   valid            —— 产物整体仍然可用
 *   partially_stale  —— 产物可用，但其中 stale_ids 那几条基于旧版本（报告要写「1500 条中 12 条
 *                       基于旧版本」，而不是「全部有效」或「全部失效」）
 *   stale            —— 产物整体不可用
 *
 * 只做这两件事，不做「重算」——重算属于 knowledge/incremental 的职责，这里只产出**谁失效了**。
 */

/** 产物失效的三级状态。`partially_stale` 存在的意义：拒绝在「全有效」和「全失效」之间二选一。 */
export const artifactStates = Object.freeze(['valid', 'partially_stale', 'stale']);

/**
 * 一个失效请求的形状校验。
 *
 * `artifact_subset` 是 L-2 的核心参数：不给就是整阶段失效（旧行为，保持不变），给了就只失效
 * 点名的那部分。三种点名方式并存，因为它们回答的是不同问题：
 *   - ids：我知道是哪几条（增量重算的产出）
 *   - kinds：我知道是哪类产物（比如只改了接口清单，用例要重算但测试点不用）
 *   - selector：我知道按什么条件筛（比如「只看 related_test_point 在这几个里的」）
 */
export function normalizeInvalidation(input) {
  const fail = message => { throw new Error(`Invalid invalidation: ${message}`); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('expects an object');
  const stage = input.stage;
  if (typeof stage !== 'string' || !/^[a-z][a-z0-9_]*$/.test(stage)) fail('stage must be a stage identifier');
  const reason = input.reason;
  if (typeof reason !== 'string' || !reason.trim()) fail('reason is required: an invalidation without a stated cause cannot be reviewed later');
  const subset = input.artifact_subset;
  if (subset === undefined || subset === null) return Object.freeze({ stage, reason, scope: 'stage', subset: null });

  if (typeof subset !== 'object' || Array.isArray(subset)) fail('artifact_subset expects an object');
  const ids = subset.ids;
  const kinds = subset.kinds;
  const selector = subset.selector;
  if (ids === undefined && kinds === undefined && selector === undefined)
    fail('artifact_subset must name ids, kinds or a selector; an empty subset means "whole stage", which is the scope it was meant to narrow');

  const cleanIds = ids === undefined ? undefined : (Array.isArray(ids) ? ids : fail('artifact_subset.ids expects an array'));
  // 判 `!== undefined` 而不是真值：空数组是真值陷阱的重灾区——`[]` 会被当成「没给」，
  // 于是「我点名了 0 条」悄悄退化成「整阶段失效」，而调用方以为自己收窄了范围。
  if (cleanIds !== undefined) {
    if (!cleanIds.length) fail('artifact_subset.ids is empty');
    if (!cleanIds.every(id => typeof id === 'string' && id.trim())) fail('artifact_subset.ids expects non-empty strings');
    if (new Set(cleanIds).size !== cleanIds.length) fail('artifact_subset.ids contains duplicates');
  }
  const cleanKinds = kinds === undefined ? undefined : (Array.isArray(kinds) ? kinds : fail('artifact_subset.kinds expects an array'));
  if (cleanKinds !== undefined) {
    if (!cleanKinds.length) fail('artifact_subset.kinds is empty');
    if (!cleanKinds.every(kind => typeof kind === 'string' && /^[a-z][a-z0-9_]*$/.test(kind))) fail('artifact_subset.kinds expects kind identifiers');
    if (new Set(cleanKinds).size !== cleanKinds.length) fail('artifact_subset.kinds contains duplicates');
  }
  const cleanSelector = selector === undefined ? undefined : (typeof selector === 'object' && selector !== null && !Array.isArray(selector) ? selector : fail('artifact_subset.selector expects an object'));
  if (cleanSelector && Object.values(cleanSelector).some(value => value === undefined))
    fail('artifact_subset.selector has an undefined condition; drop the key instead');

  return Object.freeze({
    stage,
    reason,
    scope: 'subset',
    subset: Object.freeze({
      ...(cleanIds ? { ids: Object.freeze([...cleanIds]) } : {}),
      ...(cleanKinds ? { kinds: Object.freeze([...cleanKinds]) } : {}),
      ...(cleanSelector ? { selector: Object.freeze({ ...cleanSelector }) } : {}),
    }),
  });
}

/**
 * 一条产物记录受不受这次失效影响。
 *
 * 三种点名方式是**或**关系：任何一个命中就算受影响。这不是宽松，而是因为调用方
 * 只需要知道「这条要不要重算」，多算一条的代价是浪费一次执行，少算一条的代价是拿旧结论
 * 出报告——两者不对称。
 *
 * 没给 selector 时最后那个 `return false` 是**对的**：ids/kinds 都没命中，就说明这条
 * 没被点名。但它前面必须用 `if (subset.selector)` 把「没给 selector」和「给了但没命中」
 * 分开——早先这里写成了无条件的 `return false`，于是只给 ids 时全部产物都被判失效，
 * `partially_stale` 永远退化成 `stale`，L-2 等于没做。
 */
export function matchesSubset(record, subset) {
  if (!subset) return true;
  if (subset.ids !== undefined && subset.ids.includes(record.id)) return true;
  if (subset.kinds !== undefined && subset.kinds.includes(record.kind)) return true;
  if (subset.selector === undefined) return false;
  for (const [key, expected] of Object.entries(subset.selector)) {
    const actual = record.fields?.[key];
    if (Array.isArray(expected)) {
      // 数组条件按「有交集」判：产物字段是集合时，命中一个就够。
      if (!Array.isArray(actual) || !actual.some(value => expected.includes(value))) return false;
    } else if (actual !== expected) return false;
  }
  return true;
}

/**
 * 把一个阶段的产物记录按失效请求归类，算出三级状态。
 *
 * `records` 是这个阶段已登记的产物记录 `{id, kind, fields}`。没有记录时不能声称「部分失效」
 * ——那是不知道，不是知道一部分，返回 `unknown` 让调用方去查，而不是猜一个好看的答案。
 */
export function assessStageArtifacts(records, invalidation) {
  const entries = Array.isArray(records) ? records : [];
  if (!entries.length) return Object.freeze({ state: 'unknown', reason: 'no artifact records registered for this stage', staleIds: [], validIds: [] });
  const staleIds = [];
  const validIds = [];
  for (const record of entries) (matchesSubset(record, invalidation.subset) ? staleIds : validIds).push(record.id);
  const state = staleIds.length === 0 ? 'valid' : validIds.length === 0 ? 'stale' : 'partially_stale';
  return Object.freeze({ state, staleIds: Object.freeze(staleIds), validIds: Object.freeze(validIds) });
}

/**
 * 报告该怎么写这件事。**这是 L-2 真正的验收点**：不是状态机里多了一个枚举值，
 * 而是报告里那句人话能不能经得起追问。
 */
export function describeStaleness(assessment, { total } = {}) {
  const count = Number.isSafeInteger(total) ? total : assessment.staleIds.length + assessment.validIds.length;
  switch (assessment.state) {
    case 'valid':
      return `${count} 条全部基于当前版本。`;
    case 'partially_stale':
      return `${count} 条中 ${assessment.staleIds.length} 条基于旧版本（${assessment.staleIds.join('、')}），其余 ${assessment.validIds.length} 条有效。`;
    case 'stale':
      return `${count} 条全部基于旧版本，不可作为本次结论的依据。`;
    case 'unknown':
    default:
      return `无法判断这 ${count} 条是否基于当前版本（${assessment.reason}）。`;
  }
}

/**
 * 阶段状态是否允许这一条产物被引用。
 *
 * 单个产物级判定，给「执行前选集」用：`partially_stale` 的产物里，不在 `stale_ids` 里的
 * 那些**可以照常入选**——这正是 L-2 想要的效果，12 条重算、其余继续用。
 */
export function artifactUsable(assessment, id) {
  if (assessment.state === 'valid') return true;
  if (assessment.state === 'unknown') return false;
  if (assessment.state === 'stale') return false;
  return !assessment.staleIds.includes(id);
}

/* ─────────────────────────── 多模块作用域（L-11） ─────────────────────────── */

/**
 * ProjectState / PhaseState 两级结构。
 *
 * 为什么必须是两级而不是「在 stages 上加一个 module 字段」：跨模块的东西（回归集、报告、
 * 准出结论）不属于任何一个模块。挂在模块下面，就必然出现「谁都能写全局」或「谁都不写」。
 * 两级结构把「谁能写全局」变成一个结构问题，而不是一条要靠人记住的纪律。
 */
export function createProjectState({ project, modules }) {
  if (typeof project !== 'string' || !project.trim()) throw new Error('ProjectState requires a project id');
  const list = Array.isArray(modules) ? modules : [];
  if (!list.length) throw new Error('ProjectState requires at least one module');
  const seen = new Set();
  for (const module of list) {
    if (typeof module !== 'string' || !/^[a-z][a-z0-9_]*$/.test(module)) throw new Error(`Invalid module identifier: ${module}`);
    if (seen.has(module)) throw new Error(`Duplicate module: ${module}`);
    seen.add(module);
  }
  return {
    version: 1,
    project,
    modules: [...list],
    /** 每个模块一个 PhaseState，作用域显式带上——这是 §5.6 要求的签名。 */
    phases: Object.fromEntries(list.map(module => [module, createPhaseState(module)])),
    /** 跨模块产物的单一写入点。 */
    crossModule: { reports: [], regressionSets: [], releaseDecisions: [] },
    /** 模块间真实依赖：{module: [dependency, ...]}。隐式依赖是并行测试最大的假失败来源。 */
    dependsOn: {},
  };
}

export function createPhaseState(scope) {
  if (typeof scope !== 'string' || !scope) throw new Error('PhaseState requires a scope');
  return {
    version: 1,
    scope,
    /** stageId → 该阶段在本模块下的状态。模块之间互不覆盖。 */
    stages: {},
    /** stageId → 产物评估结果（assessStageArtifacts 的产出）。 */
    artifacts: {},
  };
}

/** 声明模块依赖；必须显式、必须无环、不能自己依赖自己。 */
export function declareModuleDependency(state, module, dependsOn) {
  requireModule(state, module);
  const deps = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
  for (const dependency of deps) {
    if (dependency === module) throw new Error(`Module ${module} cannot depend on itself`);
    requireModule(state, dependency);
  }
  state.dependsOn[module] = [...new Set([...(state.dependsOn[module] ?? []), ...deps])].sort();
  try {
    assertNoModuleCycle(state);
  } catch (error) {
    // 成环时把这半条依赖撤回：留着一个连自己都过不了的图，后面每个调用点都得再判一次。
    state.dependsOn[module] = (state.dependsOn[module] ?? []).filter(dependency => !deps.includes(dependency));
    if (!state.dependsOn[module].length) delete state.dependsOn[module];
    throw error;
  }
  return state;
}

function requireModule(state, module) {
  if (!state?.modules?.includes(module)) throw new Error(`Unknown module: ${module}`);
}

/** 深度优先找环。有环就说明这两块根本不能并行——早点报错，好过在调度时死锁。 */
export function assertNoModuleCycle(state) {
  const visiting = new Set();
  const done = new Set();
  const visit = (module, path) => {
    if (done.has(module)) return;
    if (visiting.has(module)) throw new Error(`Module dependency cycle: ${[...path, module].join(' -> ')}`);
    visiting.add(module);
    for (const dependency of state.dependsOn[module] ?? []) visit(dependency, [...path, module]);
    visiting.delete(module);
    done.add(module);
  };
  for (const module of state.modules) visit(module, []);
  return state;
}

/**
 * 某个模块的某个阶段现在能不能派发。
 *
 * 判据只有一条**额外**的：这个模块声明的依赖模块，同一个阶段必须已经完成。这正是
 * 「订单依赖库存」时该有的行为——库存的需求还没定，订单的用例写了也是白写。
 * 别的（阶段自己内部的前置、人工确认）不在这里判，那是 orchestration-state 的职责，
 * 两处都判会让错误信息打架。
 */
export function moduleStageReady(state, module, stageId) {
  requireModule(state, module);
  const blockers = [];
  for (const dependency of state.dependsOn[module] ?? []) {
    const status = state.phases[dependency]?.stages?.[stageId]?.status;
    if (!['completed', 'skipped'].includes(status)) blockers.push({ module: dependency, stage: stageId, status: status ?? 'planned' });
  }
  return { ready: blockers.length === 0, blockers };
}

/**
 * 写一个模块阶段的产物评估。**只允许写自己模块**——跨模块产物走 writeCrossModule。
 *
 * `unknown` 可以写：它来自 assessStageArtifacts 的如实回答（这个阶段没有登记任何产物记录）。
 * 一条「不知道」进得了账，才能被汇总成 `incomplete`；把它挡在门外，它就会变成沉默。
 * 真正被拒的是**凭空造词**——状态值不在三级枚举里。
 */
export function recordArtifacts(state, module, stageId, assessment) {
  requireModule(state, module);
  if (typeof stageId !== 'string' || !stageId) throw new Error('recordArtifacts requires a stage id');
  const allowed = new Set([...artifactStates, 'unknown']);
  if (!assessment || !allowed.has(assessment.state))
    throw new Error(`artifact state must be one of ${[...allowed].join(', ')} (got ${assessment?.state})`);
  state.phases[module].artifacts[stageId] = assessment;
  return state;
}

const CROSS_MODULE_KINDS = new Set(['report', 'regression_set', 'release_decision']);

/**
 * 跨模块产物的唯一写入口。传入模块名则拒绝——这不是权限检查，是结构保证：
 * 一个模块不能代表全局出结论。放开这一条，「报告是谁写的」就再也查不清了。
 */
export function writeCrossModule(state, kind, value, { by } = {}) {
  if (!CROSS_MODULE_KINDS.has(kind)) throw new Error(`Unknown cross-module artifact kind: ${kind}`);
  if (by !== undefined) throw new Error(`Cross-module ${kind} may only be written by ProjectState, not by module "${by}"`);
  const bucket = kind === 'report' ? state.crossModule.reports : kind === 'regression_set' ? state.crossModule.regressionSets : state.crossModule.releaseDecisions;
  bucket.push(value);
  return state;
}

/**
 * 全局结论的汇总口径。给报告层用：不能只报「N 个模块完成」，要报每个模块里有多少产物
 * 基于旧版本——否则「全部有效」和「全部失效」又在更高一层重演。
 */
export function summarizeProject(state) {
  const perModule = {};
  let staleCount = 0;
  let partialCount = 0;
  let unknownCount = 0;
  for (const module of state.modules) {
    const assessments = Object.values(state.phases[module].artifacts);
    const counts = { valid: 0, partially_stale: 0, stale: 0, unknown: 0 };
    for (const assessment of assessments) {
      counts[assessment.state] = (counts[assessment.state] ?? 0) + 1;
      if (assessment.state === 'stale') staleCount++;
      if (assessment.state === 'partially_stale') partialCount++;
      if (assessment.state === 'unknown') unknownCount++;
    }
    perModule[module] = counts;
  }
  return {
    project: state.project,
    modules: state.modules.length,
    /** 只要有任何一个阶段不知道状态，全局就不能说「有效」。 */
    verdict: unknownCount > 0 ? 'incomplete' : staleCount + partialCount > 0 ? 'mixed' : 'valid',
    staleStages: staleCount,
    partiallyStaleStages: partialCount,
    unknownStages: unknownCount,
    perModule,
  };
}
