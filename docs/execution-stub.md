# 外部依赖桩（P1-5）

## 不做的后果

第三方服务不可用 → 整批用例 fail → 归因成「产品缺陷」→ 研发查半天说「这不是我们的问题」→ 平台可信度掉一格。下次照旧，因为**没有地方可以声明「这一步依赖外部服务」**。

## 规则

```
声明了 stub 的步骤 + 因依赖不可用而失败  → inconclusive
没声明的步骤失败                        → 仍然 fail
```

## 三条不能让步的边界

**一、没声明就不降级。**
`inconclusive` 是个很舒服的结论——不用负责、也不算失败。一旦允许「失败就降级」，所有真缺陷都会被降级掉。必须先声明依赖，才谈得上降级。

**二、打了桩还失败，不降级。**
`mode: 'stub'` / `'replay'` 意味着依赖已被本地替身接管，此时失败是脚本或断言的问题，是真问题。这类进 `kept_fail` 单独统计，不混进降级数。

**三、只有「连不上」才降级。**
判据看错误特征，不看「这一步有没有 stub」：

| 特征 | 判定 |
|---|---|
| `ECONNREFUSED` / `ETIMEDOUT` / `socket hang up` / `502/503/504` / 超时 | 依赖不可用 → 可降级 |
| `expected 3 to equal 4` / `assert` 类 | 产品行为不对 → **不降级** |
| 命中 `stub.target` 的地址 | 归因到该依赖 |

顺序不能反：先排断言类，再看网络类。反过来会让「超时」把断言不成立也吞掉。

## plan 里的写法

两种都支持（agent 产出两种都会出现）：

```json
{ "stubs": [{ "id": "sms", "target": "https://sms.example.com", "mode": "passthrough", "steps": ["S2"] }] }
{ "steps": [{ "step_id": "S1", "stub": "pay" }, { "step_id": "S2", "stub": ["sms"] }] }
```

| mode | 含义 | 失败时 |
|---|---|---|
| `passthrough` | 不拦截，真实调用 | 连不上 → 降级 |
| `stub` | 本地替身接管 | **不降级**（真问题） |
| `record` / `replay` | 录制回放 | `replay` 不降级 |

## 接入

`executionSummary(dir, manifest, { caseCatalog, stubs })`：

```js
import { collectStubs } from './execution-stub.mjs';
const stubs = collectStubs(plan);
const summary = executionSummary(dir, manifest, { caseCatalog, stubs });
// summary.stubs = { applied, declared, downgraded, kept_fail, note }
```

**不传 `stubs` 就完全不变**——这条路径被报告、状态页、交付共用，悄悄改语义会让在跑的报告突然变脸。

## 诚实边界

| 做得到 | 做不到 |
|---|---|
| 依赖不可用与断言失败的区分 | 判断「这个第三方失败是不是产品该处理的」——那要看需求 |
| 未声明时明确说「缺少声明」 | 自动生成桩（那是 M2 的事） |
| 降级/保留两条路径都可见 | 替你做「要不要重跑」的决定 |
