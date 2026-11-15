# 回归采样分层（L-6 落地说明）

> 对应方案：§20.2.1（采样策略必须分层）、评审 P1-8、§25.5 落地项 L-6。
> 代码：`scripts/regression-sampling.mjs`。测试：`tests/acceptance/regression-sampling.test.mjs`（12 条）。

## 1. 问题不在「N=3 对不对」

方案 §1.3 写「N=3 一致性 100%」，§21 决策 34 写「入库前必跑 N=3」。两句话都对，但放在一起会被读成「**每轮回归都跑 3 次**」。

按这个理解：1500 条用例 × 3 = 4500 次执行，单条 20 秒就是 25 小时，跨两个夜晚。客户一算成本就放弃。

> **指标定义得不清，指标自己会杀死方案。**

## 2. 三档采样，写死

| 场景 | 采样 | `mode` | 为什么 |
|---|---|---|---|
| **入库门** | N=3 强制 | `always` | 一次性成本，换「这条用例本身稳定」的结论 |
| **冒烟集** | N=1，失败复跑到 3 | `fail_only` | 冒烟要 ≤5 分钟，不能 ×3；失败才值得多花时间 |
| **全量回归** | N=1，仅 fail 复跑 | `fail_only` | 4500 次不可接受；失败通常 <10%，复跑成本可控 |
| **flaky 敏感集** | N=3 | `always` | 历史 flaky / 本版新增 / 改动跨 ≥3 模块，多采有收益 |

分档顺序有意义：**敏感集优先于调用场景**。一条历史 flaky 的用例，即使在冒烟集里也采满 3 次——冒烟集的时间预算不该用来掩盖一个已知的不稳定项。

`max_runs` 是**上限不是承诺**：`fail_only` 档的用例首次通过就只跑 1 次。字段名刻意没用 `runs`，免得有人把它当承诺去对账。

## 3. 一条不可绕的规则：复跑只能确认失败，不能洗成通过

| 首次 | 后续 | 判定 | 含义 |
|---|---|---|---|
| `passed` | — | `passed` | 首次通过就停，不再为攒通过多跑 |
| `failed` | 有 `passed` | **`flaky`** | **不稳定，这是关于这条用例的结论，不是通过** |
| `failed` | 全 `failed` | `failed` | 正常取证 |
| `failed` | 未采满 | `incomplete` | 没判清楚，不提前下结论 |
| `blocked` / `skipped` | — | `unknown` | 没测到，既不算通过也不算失败 |

两条容易写错的：

1. **`failed, passed` 只有两次时判 `incomplete` 而不是 `flaky`**。「复跑到 3 次」的目的就是把 flaky 判清楚，没采满就是没判清楚。早先这里我一开始想直接判 flaky，测试逼出了正确答案——采两次就说 flaky，等于用半个证据下结论。
2. **首次就 `blocked`，后面即使有 `passed` 也判 `unknown`**。第一次就没测到，后面的「通过」没有可比对象。

## 4. 汇总口径：flaky 永不并入 passed

```
flaky 单独计数 → 通过率分母只含 passed + failed + flaky
unknown / incomplete 既不算通过也不算失败
一条都没跑出结论时 passRate = null（不是 0%，也不是 100%）
```

一条「flaky 也算通过」的汇总，会让 flaky 率这个指标永远显示为 0——那这个指标就白设了。

## 5. 成本对照（可复算）

`planSampling(cases, { suite, failureRate })` 直接产出 §20.2.1 那张表，不是文档里抄来的数字：

```js
const plan = planSampling(cases1500, { suite: 'full', failureRate: 0.08 });
// plan.expectedRuns  → 1740   （1500 + 120×2）
// plan.misreadRuns   → 4500   （误读版：每条 ×3）
// plan.worstRuns     → 4500   （上界：全部失败都要采满）
// plan.savingVsMisread → 61.3
```

期望值按 `1 + p×(max-1)` 估——**是估算不是承诺**，报告要带这个词。同时保留 `worstRuns` 上界：客户问「最坏要跑多久」时不能说「大概 1740」。

## 6. 边界

- **不调度执行**。这里只回答「这条该跑几次、跑完算什么」，真正的重跑由执行层按 `max_runs` 与 `mode` 驱动。
- **`touched_modules` 需要上游提供**。改动跨 ≥3 模块这个判据要有模块级 diff 才能算，不在本模块职责内；没有这个字段时该条不触发敏感集，不会误判成 flaky。
- **`failureRate` 是要传进来的**。不传默认 8%（§20.2.1 的示例值），但真实调用方应该用上一轮的实际失败率。

## 7. 验证

```bash
node scripts/run-engineering-tests.mjs \
  tests/acceptance/regression-sampling.test.mjs \
  tests/acceptance/artifact-scope.test.mjs \
  tests/acceptance/stage-recovery.test.mjs \
  tests/acceptance/execution-attempts.test.mjs \
  tests/acceptance/execution-safety.test.mjs
# 63 tests, 63 pass, 0 fail
```
