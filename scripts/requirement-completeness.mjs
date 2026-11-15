/**
 * 需求完备性检查（L-8 落地，对应 §25.4 元问题一）。
 *
 * **要补的那个洞**：V-33 对的是「需求 → 测试点」，算得很细。但没有人对「业务真相 → 需求」
 * 做对账。于是系统能诚实地说「我覆盖了 90% 的需求」，而这 90% 的分母可能只有真实业务的
 * 40%——缺陷逃逸主要来自没被写进需求的那 60%。
 *
 * 这里做的是**分母修正**：按五张检查表逐项问「这一类需求在不在」，把「业务上该有、
 * 文档里没有」的部分显式列出来。不替代 V-33，是让 V-33 的分母第一次有可信度。
 *
 * ## 三条口径（比检查表本身更重要）
 *
 * 1. **零 LLM**。全部是程序判定：关键词 + 结构字段。不做语义理解，所以也**不许假装理解**。
 * 2. **「判不了」是独立结论**。`unknown` 有三类来源：台账没声明实体、文本里抽不到证据、
 *    有证据但相互矛盾。它**不参与打分**，但必须在报告里占一行——把 unknown 当 0 分，
 *    会让团队为一个其实不缺的需求补文档；当满分，会让覆盖率的谎言继续。
 * 3. **声明优先于推断**。台账里写了 `entities[].operations` 就用它，抽不出来才退到文本推断，
 *    并在结果里标 `basis`。文本推断的结论一律 `confidence: low`。
 *
 * ## 五张检查表
 *
 * | 检查项 | 问什么 | 缺了会怎样 |
 * |---|---|---|
 * | 实体完整性 | 每个业务实体是否都有 CRUD 类需求 | 整个「删除」功能没人测过 |
 * | 状态流转完整性 | 有状态实体是否声明了流转与回退（含非法流转） | 只测了正向流转，回退与越权流转裸奔 |
 * | 数值边界 | 金额/数量/长度/时间字段是否有上下界与精度 | 边界值测试没有依据，全靠人拍脑袋 |
 * | 权限矩阵 | 角色 × 操作是否有明确的允许/禁止 | 越权访问这类高危缺陷靠运气发现 |
 * | 异常与超时 | 每个外部依赖是否有失败路径需求 | 依赖挂了算产品缺陷，或干脆没人想到要测 |
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 五张检查表：id / 问的问题 / 判定用的关键词。 */
export const CHECKS = [
  {
    id: 'entity_crud',
    label: '实体完整性',
    question: '每个业务实体是否都有 CRUD 类需求',
    operations: ['create', 'read', 'update', 'delete'],
  },
  {
    id: 'state_transitions',
    label: '状态流转完整性',
    question: '有状态实体是否声明了流转与回退（含非法流转）',
  },
  {
    id: 'numeric_bounds',
    label: '数值边界',
    question: '金额/数量/长度/时间字段是否有上下界与精度要求',
  },
  {
    id: 'permission_matrix',
    label: '权限矩阵',
    question: '角色 × 操作是否有明确的允许/禁止声明',
  },
  {
    id: 'failure_paths',
    label: '异常与超时',
    question: '每个外部依赖是否有失败路径需求',
  },
];

/** 操作动词。只认明确的动作词，不认「管理」「处理」这类含糊词。 */
const OPERATION_WORDS = {
  create: ['新增', '创建', '添加', '录入', 'create', 'add'],
  read: ['查询', '查看', '列表', '详情', '展示', 'search', 'list', 'get'],
  update: ['修改', '更新', '编辑', 'update', 'edit'],
  delete: ['删除', '移除', '作废', 'delete', 'remove'],
};

const BOUND_WORDS = /(范围|区[间域]|上限|下限|最大|最小|最多|至少|不得超过|不少于|位数|精度|小数|整数|\d+\s*[-~—]\s*\d+|[<>≤≥]=?\s*\d+)/;
const FIELD_WORDS = /(金额|预算|价格|数量|库存|余额|长度|字数|时间|日期|时长|折扣|积分|次数|年龄|重量)/;
const ROLE_WORDS = /(管理员|普通用户|用户|游客|访客|运营|审核员|财务|角色|权限|越权|无权|仅.*可见|只读)/;
const DENY_WORDS = /(不得|不能|禁止|不允许|无权|越权|仅.*可|只有.*能|拒绝)/;
const DEPENDENCY_WORDS = /(接口|API|第三方|支付|短信|邮件|消息|推送|网络|超时|依赖|外部服务|webhook|回调)/i;
const FAILURE_WORDS = /(超时|失败|异常|重试|降级|兜底|熔断|报错|不可用|断开|错误码)/;
const STATE_WORDS = /(状态|流[转程]|回退|撤回|作废|重新提交|草稿|待审|已审|已发布|已关闭)/;

function asRules(ledger) {
  return Array.isArray(ledger?.rules) ? ledger.rules.filter(rule => rule?.scope !== 'out_of_scope') : [];
}

function textOf(rules) {
  return rules.map(rule => `${rule?.statement ?? ''}`).filter(Boolean);
}

/** 证据引用：只回 rule id 与一小段原文，报告里能点回去。 */
function evidenceOf(rules, pattern) {
  return rules
    .filter(rule => pattern.test(rule?.statement ?? ''))
    .map(rule => ({ rule_id: rule.id ?? null, quote: String(rule.statement ?? '').slice(0, 80) }))
    .slice(0, 5);
}

/**
 * 实体 × 操作矩阵。
 *
 * 来源优先级：`ledger.entities`（声明） > 文本推断（低置信）。
 * 声明里的 `operations` 可以只写部分——**没写的视为「没有这条需求」**，这正是要暴露的。
 */
export function buildEntityMatrix(ledger, rules) {
  const declared = Array.isArray(ledger?.entities) ? ledger.entities.filter(item => typeof item?.name === 'string') : [];
  if (declared.length) {
    return {
      basis: 'declared',
      confidence: 'high',
      entities: declared.map(item => ({
        name: item.name,
        operations: Array.isArray(item.operations) ? [...new Set(item.operations)] : [],
        stateful: item.stateful === true,
        roles: Array.isArray(item.roles) ? item.roles : [],
      })),
    };
  }
  // 文本推断：只认「实体词 + 明确动作词」同时出现，不强凑
  const names = new Map();
  for (const text of textOf(rules)) {
    for (const [operation, words] of Object.entries(OPERATION_WORDS)) {
      if (!words.some(word => text.includes(word))) continue;
      const entity = text.match(/([\u4e00-\u9fa5]{1,8}(?:订单|商品|草稿|文档|用户|账户|账号|配置|任务|工单|项目|角色|权限|优惠券|库存|发票|合同))/)?.[1];
      if (!entity) continue;
      if (!names.has(entity)) names.set(entity, { name: entity, operations: [], stateful: STATE_WORDS.test(text), roles: [] });
      names.get(entity).operations.push(operation);
    }
  }
  return {
    basis: 'text_inference',
    confidence: 'low',
    entities: [...names.values()].map(item => ({ ...item, operations: [...new Set(item.operations)] })),
  };
}

function checkActions(status, extra = {}) {
  return { status, ...extra };
}

/**
 * 五项检查。每项返回 `status`：covered / missing / unknown。
 *
 * 注意 `unknown` 的判定条件写得比较宽——**宁可说「判不了」，也不要给一个看着像结论的默认值**。
 * 这与 §11.11 里 `available=false`、健康度 `None` 是同一条口径。
 */
export function runChecks(ledger, rules) {
  const matrix = buildEntityMatrix(ledger, rules);
  const texts = textOf(rules);
  const checks = [];

  // —— 1. 实体 CRUD ——
  if (!matrix.entities.length) {
    checks.push(checkActions('unknown', {
      id: 'entity_crud', label: '实体完整性', question: CHECKS[0].question,
      note: '台账既没有声明业务实体，文本里也没有「实体 + 明确动作词」的组合，无法核对 CRUD 完整性。',
      missing: [],
    }));
  } else {
    const gaps = [];
    for (const entity of matrix.entities) {
      const absent = ['create', 'read', 'update', 'delete'].filter(op => !entity.operations.includes(op));
      if (absent.length) gaps.push({ entity: entity.name, missing_operations: absent });
    }
    checks.push(checkActions(gaps.length ? 'missing' : 'covered', {
      id: 'entity_crud', label: '实体完整性', question: CHECKS[0].question,
      basis: matrix.basis, confidence: matrix.confidence,
      covered: matrix.entities.filter(entity => entity.operations.length >= 4).map(entity => entity.name),
      missing: gaps,
      evidence: rules.filter(rule => matrix.entities.some(entity => String(rule?.statement ?? '').includes(entity.name)))
        .slice(0, 5).map(rule => ({ rule_id: rule.id ?? null, quote: String(rule.statement ?? '').slice(0, 80) })),
      note: matrix.basis === 'text_inference' ? '实体与操作由文本推断得出，可能漏判；建议在台账里显式声明 entities[].operations。' : undefined,
    }));
  }

  // —— 2. 状态流转 ——
  const statefulEntities = matrix.entities.filter(entity => entity.stateful);
  const stateRules = rules.filter(rule => STATE_WORDS.test(rule?.statement ?? ''));
  if (!statefulEntities.length && !stateRules.length) {
    checks.push(checkActions('unknown', {
      id: 'state_transitions', label: '状态流转完整性', question: CHECKS[1].question,
      note: '没有识别到有状态实体，也没有声明状态流转的需求。若业务确实无状态，请在台账里显式标注 entities[].stateful=false，否则这条会被长期误判为「缺」。',
      missing: [],
    }));
  } else {
    const hasRollback = /(回退|撤回|作废|重新提交|拒绝|驳回|取消)/.test(texts.join('\n'));
    const hasIllegal = /(非法|不允许|不得|状态.*(?:不能|无法)|越级)/.test(texts.join('\n'));
    const missing = [];
    if (!hasRollback) missing.push({ aspect: '回退路径', detail: '有状态实体但没有任何回退/撤回/作废的需求' });
    if (!hasIllegal) missing.push({ aspect: '非法流转', detail: '没有声明哪些流转是禁止的（这类往往是缺陷高发区）' });
    checks.push(checkActions(missing.length ? 'missing' : 'covered', {
      id: 'state_transitions', label: '状态流转完整性', question: CHECKS[1].question,
      covered: stateRules.slice(0, 5).map(rule => rule.id ?? null).filter(Boolean),
      missing, evidence: evidenceOf(rules, STATE_WORDS),
    }));
  }

  // —— 3. 数值边界 ——
  const fieldRules = rules.filter(rule => FIELD_WORDS.test(rule?.statement ?? ''));
  if (!fieldRules.length) {
    checks.push(checkActions('unknown', {
      id: 'numeric_bounds', label: '数值边界', question: CHECKS[2].question,
      note: '需求里没有出现金额/数量/长度/时间类字段，无法判断是否缺边界。',
      missing: [],
    }));
  } else {
    const unbounded = fieldRules
      .filter(rule => !BOUND_WORDS.test(rule.statement))
      .map(rule => ({ rule_id: rule.id ?? null, quote: String(rule.statement).slice(0, 80) }));
    checks.push(checkActions(unbounded.length ? 'missing' : 'covered', {
      id: 'numeric_bounds', label: '数值边界', question: CHECKS[2].question,
      covered: fieldRules.filter(rule => BOUND_WORDS.test(rule.statement)).map(rule => rule.id ?? null).filter(Boolean),
      missing: unbounded.map(item => ({ field_rule: item.rule_id, detail: '提到了数值字段但未给出上下界/精度' })),
      evidence: unbounded.slice(0, 5),
    }));
  }

  // —— 4. 权限矩阵 ——
  const roleRules = rules.filter(rule => ROLE_WORDS.test(rule?.statement ?? ''));
  if (!roleRules.length) {
    checks.push(checkActions('unknown', {
      id: 'permission_matrix', label: '权限矩阵', question: CHECKS[3].question,
      note: '需求里没有出现角色/权限相关表述。若产品确无多角色，请在台账里显式说明；否则这条应被视为缺失。',
      missing: [],
    }));
  } else {
    const hasDeny = roleRules.some(rule => DENY_WORDS.test(rule.statement));
    checks.push(checkActions(hasDeny ? 'covered' : 'missing', {
      id: 'permission_matrix', label: '权限矩阵', question: CHECKS[3].question,
      covered: roleRules.filter(rule => DENY_WORDS.test(rule.statement)).map(rule => rule.id ?? null).filter(Boolean),
      missing: hasDeny ? [] : [{ aspect: '禁止性声明', detail: '只写了谁能做什么，没写谁不能做什么——越权类缺陷无从断言' }],
      evidence: evidenceOf(rules, ROLE_WORDS),
    }));
  }

  // —— 5. 异常与超时 ——
  const dependencyRules = rules.filter(rule => DEPENDENCY_WORDS.test(rule?.statement ?? ''));
  if (!dependencyRules.length) {
    checks.push(checkActions('unknown', {
      id: 'failure_paths', label: '异常与超时', question: CHECKS[4].question,
      note: '没有识别到外部依赖。若系统确实不依赖外部服务，这条不适用；否则应视为缺失。',
      missing: [],
    }));
  } else {
    const withoutFailure = dependencyRules
      .filter(rule => !FAILURE_WORDS.test(rule.statement))
      .map(rule => ({ rule_id: rule.id ?? null, detail: '提到了外部依赖，但没有失败/超时/重试路径' }));
    checks.push(checkActions(withoutFailure.length ? 'missing' : 'covered', {
      id: 'failure_paths', label: '异常与超时', question: CHECKS[4].question,
      covered: dependencyRules.filter(rule => FAILURE_WORDS.test(rule.statement)).map(rule => rule.id ?? null).filter(Boolean),
      missing: withoutFailure,
      evidence: evidenceOf(rules, DEPENDENCY_WORDS),
    }));
  }

  return { matrix, checks };
}

/**
 * 主入口。
 *
 * 打分口径：`covered / (covered + missing)`。**`unknown` 不进分母**——它进分母就会
 * 让「台账没写清楚」变成一个分数惩罚，而团队的第一反应会是「把台账写宽松点」，
 * 那等于亲手把这项检查废掉。
 */
export function inspectCompleteness(ledger) {
  const rules = asRules(ledger);
  if (!rules.length) {
    return {
      version: 1,
      available: false,
      reason: 'no_in_scope_requirements',
      note: '台账里没有 in_scope 需求，完备性检查不适用。此结论不代表需求完整。',
      score: null,
      checks: [],
    };
  }
  const { matrix, checks } = runChecks(ledger, rules);
  const covered = checks.filter(item => item.status === 'covered').length;
  const missing = checks.filter(item => item.status === 'missing').length;
  const unknown = checks.filter(item => item.status === 'unknown').length;
  const judged = covered + missing;
  const score = judged ? Math.round((covered / judged) * 1000) / 1000 : null;

  const warnings = [];
  if (unknown) warnings.push(`${unknown} 项无法判定（证据不足），未计入打分。报告须单列，不得当作已覆盖，也不得当作缺失。`);
  if (matrix.basis === 'text_inference') warnings.push('实体与操作来自文本推断（低置信），建议在需求台账中显式声明 entities 以提升判定可靠性。');
  if (missing) warnings.push(`存在 ${missing} 项结构性缺口，需求覆盖率的分母应相应放大——否则「覆盖 90%」只是覆盖了已写下来的那部分。`);

  return {
    version: 1,
    available: true,
    basis: matrix.basis,
    confidence: matrix.confidence,
    score,
    denominator: { covered, missing, unknown, judged },
    checks,
    entities: matrix.entities,
    warnings,
  };
}

/**
 * 需求覆盖率的分母修正。
 *
 * `reported = coveredRequirements / totalRequirements` 的分子分母都只统计「写下来的」需求。
 * 完备性检查发现的结构性缺口，意味着真实分母更大。这里给的是**修正后的分母**，
 * 以及一句能直接写进报告的说明——不直接改 V-33 的分子分母，两套口径各说各的会打架。
 */
export function adjustCoverage({ covered = 0, total = 0 } = {}, completeness) {
  if (!completeness?.available || completeness.score === null) {
    return {
      available: false,
      reported: total ? Math.round((covered / total) * 1000) / 1000 : null,
      adjusted: null,
      note: '需求完备性无法判定，覆盖率分母未修正。此时的覆盖率只覆盖「已写下来的需求」，不代表业务完整性。',
    };
  }
  const gaps = completeness.checks
    .filter(item => item.status === 'missing')
    .reduce((sum, item) => sum + Math.max(1, item.missing?.length ?? 0), 0);
  const adjustedTotal = total + gaps;
  return {
    available: true,
    reported: total ? Math.round((covered / total) * 1000) / 1000 : null,
    adjusted: adjustedTotal ? Math.round((covered / adjustedTotal) * 1000) / 1000 : null,
    gaps,
    note: `按需求完备性检查补入 ${gaps} 项结构性缺口后，分母由 ${total} 修正为 ${adjustedTotal}。修正后的数值才是对业务的有效覆盖。`,
  };
}

/* ------------------------------------------------------------------ */
/* CLI：node scripts/requirement-completeness.mjs --run-id=<run_id>     */
/* ------------------------------------------------------------------ */

function main() {
  const root = resolve(import.meta.dirname, '..');
  const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9);
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? '')) {
    console.error('用法: node scripts/requirement-completeness.mjs --run-id=<run_id>');
    process.exit(2);
  }
  const path = resolve(root, 'output/runs', runId, 'analysis/requirement-ledger.json');
  if (!existsSync(path)) {
    console.error(`缺少 ${path}；先完成需求分析阶段。`);
    process.exit(2);
  }
  const result = inspectCompleteness(JSON.parse(readFileSync(path, 'utf8')));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
