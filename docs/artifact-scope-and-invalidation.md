# 失效粒度与多模块作用域（L-2 + L-11 落地说明）

> 对应方案：§5.6（多模块作用域）、§25.1 P0-3 / P0-4、§25.5 落地项 L-2 / L-11。
> 代码：`scripts/artifact-scope.mjs`（新增）、`scripts/recover-stage.mjs`（接入）。
> 测试：`tests/acceptance/artifact-scope.test.mjs`（16 条）、`tests/acceptance/stage-recovery.test.mjs`（新增 2 条端到端）。

## 1. 它堵的是哪两条路

### P0-3：粒度不匹配，一句改动判死 1500 条

改一句判定规则 → `invalidate` 把整个 `test_cases` 阶段作废 → 1500 条全部 stale。而 `incremental_plan` 算出来只有 12 条真的受影响。

两个模块单独都对。接起来编排层两难：

| 走法 | 结果 |
|---|---|
| 按状态机走 | 增量优化白做，1500 条全跑一遍 |
| 按增量走 | 绕过状态机，属于违约 |

于是 §6.2 承诺的「500 条只触及 2~5 条」根本无法兑现。

### P0-4：单状态机撑不住多模块

`artifacts["requirements"]` 一个 kind 只容一份。订单模块在跑用例、支付模块刚进需求时，只有一个状态位；后跑的模块还会**静默覆盖**前者，先前的 `derived_from` 指向的需求版本就此丢失——血缘断了，而且不报错。

## 2. L-2：三级失效状态

```json
{
  "stage": "test_cases",
  "artifact_subset": {
    "ids": ["TC-0007", "TC-0012"],
    "kinds": ["case"],
    "selector": { "module": "order" }
  },
  "reason": "REQ-0007 第 3 条判定规则变更"
}
```

| 状态 | 含义 | 报告怎么写 |
|---|---|---|
| `valid` | 产物整体可用 | `1500 条全部基于当前版本。` |
| `partially_stale` | 产物可用，但 `staleIds` 那几条基于旧版本 | `1500 条中 12 条基于旧版本（…），其余 1488 条有效。` |
| `stale` | 产物整体不可用 | `1500 条全部基于旧版本，不可作为本次结论的依据。` |
| `unknown` | 没有产物登记，无从判断 | `无法判断这 N 条是否基于当前版本（no artifact records…）。` |

**`partially_stale` 的存在意义：拒绝在「全有效」和「全失效」之间二选一。** 这不是状态机里多一个枚举值，而是报告里那句人话能不能经得起追问。

### 三种点名方式并存，因为它们回答不同问题

| 方式 | 什么时候用 | 例子 |
|---|---|---|
| `ids` | 我已经知道是哪几条（增量重算的产出） | `["TC-0007","TC-0012"]` |
| `kinds` | 我知道是哪类产物 | 只改了接口清单 → `["case"]` 重算、测试点不动 |
| `selector` | 我知道按什么条件筛 | `{"module":"order"}` 只失效订单模块的 |

三者是**或**关系。多算一条的代价是浪费一次执行，少算一条的代价是拿旧结论出报告——两者不对称，所以宁可多算。

### 关键取舍：`unknown` 不是「有效」

一条产物记录都还原不出来时，返回 `unknown`，`artifactUsable()` 一律给 `false`。**不知道基于哪个版本，就不能拿去出结论**——它不能退化成「大概没问题」。

## 3. L-11：两级作用域

```
ProjectState（1 个）          跨模块：reports / regressionSets / releaseDecisions
  └─ PhaseState(scope=module)  每个模块一个：stages / artifacts
```

三条配套规则，全部落在代码里而不只是文档：

| 规则 | 实现 | 为什么 |
|---|---|---|
| 阶段推进按模块独立 | `phases[module].stages` 各自一份 | 模块 A 的用例与模块 B 的需求可同时 `in_progress` |
| 跨模块产物只允许 `ProjectState` 写 | `writeCrossModule(state, kind, value, {by})` 传 `by` 直接抛错 | 一个模块不能代表全局出结论；放开这条，「报告是谁写的」就查不清 |
| 跨模块依赖显式声明 | `declareModuleDependency` + `assertNoModuleCycle` | 隐式依赖是并行测试最大的假失败来源 |

依赖声明**当场**校验成环并回滚那条边：留着一个连自己都过不了的图，后面每个调用点都得再判一次。

## 4. 接入点：`recover-stage --invalidate`

```bash
node scripts/recover-stage.mjs <run_id> analysis \
  --expected-sha256=... --actor=... --reason=... --approval-ref=... \
  --evidence=inputs/recovery.md --parent-session-id=... \
  --invalidate='{"ids":["analysis/requirement_analysis.md"],"reason":"REQ-0007 判定规则变更"}'
```

| 行为 | 说明 |
|---|---|
| 不带 `--invalidate` | **整阶段失效，一个字都不多写**——旧行为完全保持（12 条既有测试全绿验证了这一点） |
| 带了 | 追加一条 `artifacts_invalidated` 审计事件，并在 `stages.<stage>` 上写 `artifact_state` / `artifact_summary` |
| 参数走 JSON | 三种点名方式拆成三个命令行开关会让「我到底失效了多少」需要读代码才能算清 |

审计事件长这样，它是复盘时要查的账：

```json
{
  "type": "artifacts_invalidated", "stage": "analysis", "scope": "subset",
  "artifact_state": "partially_stale",
  "stale_ids": ["analysis/requirement_analysis.md"],
  "valid_ids": ["analysis/requirement-ledger.json"],
  "summary": "2 条中 1 条基于旧版本（analysis/requirement_analysis.md），其余 1 条有效。",
  "reason": "REQ-0007 判定规则变更"
}
```

产物登记表用的是 `manifest.artifacts`——`record-orchestration-event` 每次派发/完成时累加的那份，是 run 目录里唯一完整可信的产物清单。

## 5. 实现过程中自己踩的三个坑（都已修，都有测试钉住）

这三个都是「测试写对了、代码写错了」的典型，值得单独记一笔：

1. **`[]` 是真值陷阱**：`if (cleanIds)` 对空数组为假，于是 `{"ids":[]}` 跳过校验、退化成整阶段失效。改成 `!== undefined` 判断。
2. **`matchesSubset` 的尾部 `return false`**：只给 `ids` 时，`selector` 分支静默落空，所有产物都被判失效，`partially_stale` 永远退化成 `stale`——**L-2 等于没做，而且测试还能过**（因为单测同时给了 ids 和 selector）。靠一个最小探针跑真实路径才抓到。
3. **`parseInvalidation` 展开 JSON 到顶层**：`{ids:[...]}` 里的 `ids` 到了顶层就是未知字段，被静默丢弃。现在把 `ids/kinds/selector` 原样落进 `artifact_subset`，并拒绝未知键、拒绝 `{}`、拒绝 inline 与嵌套同时给。

## 6. 边界（没有做的事）

- **不做重算**。重算属于 `knowledge/incremental` 的职责，这里只产出「谁失效了」。
- **不自动传播到下游阶段**。`test_cases` 部分失效后，`plan`/`execution` 要不要跟着失效取决于计划里引用了哪几条——那是编排层的判断，且需要计划产物里的引用关系，不是这层能决定的。
- **`selector` 目前只支持等值与数组交集**，不做表达式。够用，且能用一句话讲清楚。
- **没有接 UI**。`stages.<stage>.artifact_state` 已经写进 manifest，管理后台读它即可展示；页面改造不在本项范围内。

## 7. 验证

```bash
node scripts/run-engineering-tests.mjs \
  tests/acceptance/artifact-scope.test.mjs \
  tests/acceptance/stage-recovery.test.mjs \
  tests/acceptance/command-runtime.test.mjs \
  tests/acceptance/expected-provenance.test.mjs
# 56 tests, 56 pass, 0 fail
```
