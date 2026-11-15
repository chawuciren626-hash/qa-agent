# 预期结果的来源与状态（L-1 落地说明）

> 对应方案：§6.4（来源与状态）、§17.8（写入权与变更审计）、评审问题 P0-1 / P0-2。
> 代码：`scripts/expected-source.mjs`、`scripts/expectation-audit.mjs`。
> 测试：`tests/acceptance/expected-provenance.test.mjs`（16 条）。

## 1. 它堵的是哪条路

```
执行 fail → agent 归因 → agent 说「预期写错了」→ 改 expected → 重跑 → pass
```

这条路每一步都合规，而且比伪造 `engine_version` 自然得多——「预期写错了当然要改」，谁都不会觉得可疑。三个月后通过率 95%，缺陷密度不变。

更根本的问题是：如果预期本身是错的，五道闸保证的只是「一条错误的用例被正确地执行了」。所以断言不只要回指测试点（已有的闸门），还要能回答**「这个预期凭什么算数」**。

## 2. 两个字段

```json
{
  "text": "下单后订单状态为「已支付」，金额 90.00 元",
  "kind": "decide",
  "source": { "type": "doc", "ref": "§3.2", "quote": "满 100 元减 10 元" },
  "state": "verified",
  "verified_by": "human:qa_lead",
  "verified_at": "2026-11-14T08:00:00.000Z"
}
```

- `source.type`：`doc` 文档原文 / `human` 人工确认 / `derived` 从已确认规则推导 / `model` 模型生成；
- `source.quote` **必填**。没有原文的引用等于没有引用；
- `state`：`verified` / `unverified` / `drifted`；
- `verified_by` 必须是 `human:<id>`。**agent 不能给自己发证书**。

`kind=observe` 的观察性断言可以不带 source——它不决定通过与否，只记录。

## 3. 五条规则

| 规则 | 内容 | 为什么这么定 |
|---|---|---|
| **R1** | 无源的 `decide` 断言不进冒烟集 | 冒烟集是最常被当成「都绿了」看的集合。门槛不是「全部 verified」（那会让冒烟集长期空着，团队就绕过它），而是「每条都有来源且无 drifted」 |
| **R2** | `source.type=model` 永远不能 `verified` | 模型推导不能自证。它只能被提交，由人转正 |
| **R3** | decide 断言全部未确认 → verdict 上限 `inconclusive` | 宁可报「不知道」，不可报「以为知道」 |
| **R4** | pass 需要至少一条 verified 的 decide 断言；上限只拉低 pass，不影响 fail | 失败本来就该报失败，不需要「预期已确认」才能成立 |
| **R5** | `drifted` 按 `unverified` 处理 | 状态字段表达可信度，不表达变更历史。改过两次不等于改对了 |

## 4. 待审队列

`ExpectationAuditQueue` 是内存对象（`toJSON` 可落盘），按**来源**分级而不是按字段分级——按字段分级可以靠换字段绕过：

| 提案人 | 来源类型 | 结果 |
|---|---|---|
| `agent:*` | 任意 | `pending`，人批了才生效 |
| `human:*` | `doc`/`human`/`derived` | `applied`，立即生效但留痕 |
| `human:*` | `model` | `pending`（模型来源即便人提也要复核） |

另外两条计数规则：

- 同一断言一个版本周期内生效变更 ≥ 2 次 → 该用例进 `driftedCases()`，交回 R5 按未确认处理。防的是「反复微调直到跑通」；
- 一轮内被改预期的用例占比 > 5% → `assess()` 返回 `blocked=true`，提示复核需求阶段。**单条改是修预期，大面积改是需求理解出了系统性偏差**，那时候该回去看需求，不是继续改断言。

## 5. 怎么接进现有链路

三处，都是加法：

```js
// 1) 用例生成后：给每条 decide 断言补 source，没来源的直接标 unverified
import { inspectExpectation, auditExpectations } from '../scripts/expected-source.mjs';

// 2) 执行结论合成：不要直接写执行器的 pass
import { applyCeiling } from '../scripts/expected-source.mjs';
const verdict = applyCeiling(executorVerdict, testCase);   // 可能降级为 inconclusive

// 3) agent 提交预期改动：不再直改，走队列
import { ExpectationAuditQueue } from '../scripts/expectation-audit.mjs';
queue.propose({ caseId, assertion, before, after, reason, by: 'agent:test_case_agent' });
```

第 2 处是**唯一**能让这套机制起作用的地方。只加字段不接 `applyCeiling`，等于给报告加了一列注释。

## 6. 边界

- **不比对 quote 与原文**。原文比对复用 `requirement-provenance.mjs` 的 capture 校验（它保证 quote 是源文件里的连续原文）；本模块只保证「有源、类型合法、状态与源匹配」；
- **不判断预期在语义上对不对**。它能拦住「没有依据的 pass」，拦不住「有依据但读错的 pass」——后者只能靠人复核与种子缺陷集；
- **不是所有断言都要 verified**。只要求 `decide`；`observe` 允许 `unverified`。全都要人签的话，200 需求 × 3~5 断言 = 上千次签字，团队三天就绕过——**卡点太密等于没有卡点**；
- **`state` 不由程序自动改成 verified**。任何自动转正都会让这套机制变成装饰。

## 7. 与草案的差别（为什么没照单全收）

评审时提过两条，这里没有采纳：

1. **「所有 expected 都必须人工确认」** → 降级为只要求 decide 断言，理由见上；
2. **「用语义相似度判断预期漂移」** → 不采纳，改用变更次数 + 血缘。中文短句上语义相似度误判率高，而且会引入新的不可解释环节。**能用计数解决的不要用模型**。

---

## 8. L-3 落地部分：把上限接到执行结论上（`scripts/execution-verdict.mjs`）

第 1~7 节是规则。规则不接在数据路径上，等于没写——一份报告里 95% 的通过率如果全来自「预期从未被人工确认」的用例，这个 95% 只是在陈述「机器认为机器是对的」。

### 三个动作

| 动作 | 入口 | 说明 |
|---|---|---|
| 取用例的预期字段 | `expectationOf(testCase)` | 兼容 `expectations`（新）与 `expected_source` + `assertions`（散装）两种形态；用例级来源继承到断言级 |
| 求上限并折算 | `buildCeilingIndex(cases)` + `applyCeilings(rows, index)` | `passed` 按上限降为 `inconclusive`；**`failed` 不折算** |
| 汇总口径 | `summarizeWithCeilings(rows, index)` | 通过率的分母跟着改，并给出 `inflatedPassRate` 作对照 |

### 接在哪儿

`scripts/execution-summary.mjs` 的 `executionSummary(dir, manifest, { caseCatalog })`：

- **不传 `caseCatalog`**：行为与改动前逐字段一致，只多一个 `expectations.applied=false` 的说明；
- 传了：`cases` 与 `summary` 换成收权后的口径，并附 `expectations` 块：

```json
{
  "expectations": {
    "applied": true,
    "pass_rate": 33.3,
    "inflated_pass_rate": 100,
    "downgraded": [{ "case_id": "TC-2", "from": "passed", "to": "inconclusive", "reason": "1 条 decide 断言均未被人工确认（R3）…" }],
    "unmatched": ["GHOST"],
    "note": "通过率 33.3%；其中 2 条原本通过，因预期未被人工确认而降级为 inconclusive（不套上限时通过率为 100%）。"
  }
}
```

**为什么默认关闭**：这条路径被报告、状态页、交付多处共用，悄悄改语义会让一条已经在跑的报告突然变脸。要收权的地方显式传清单。

### 三条不能含糊的口径

1. **只降不升**。执行器说 `fail`，预期再可信也不能变 `pass`；说 `pass`，预期不可信就降 `inconclusive`。
2. **清单缺失单独计**。执行结果里有、用例清单里没有的 `case_id` 记进 `unmatched`，保留原结论并标 `expectation_unknown`——把它拉低成失败会让「清单缺失」看起来像「用例问题」，那是两件事。
3. **`blocked`/`skipped` 不进通过率分母**。没测到的用例不该拉低通过率，也不该被算作通过。

### 验证

```bash
node scripts/run-engineering-tests.mjs \
  tests/acceptance/execution-verdict.test.mjs \
  tests/acceptance/expected-provenance.test.mjs \
  tests/acceptance/regression-sampling.test.mjs \
  tests/acceptance/artifact-scope.test.mjs \
  tests/acceptance/stage-recovery.test.mjs
# 65 tests, 65 pass, 0 fail
```
