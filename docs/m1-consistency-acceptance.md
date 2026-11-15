# M1 一致性验收报告（L-§18.2 四条）

M1 的四条验收标准是进 M2 的硬门槛。这份报告的价值不在于「算出多少分」，而在于**把三条能判的判掉、把一条不能判的明确交回给人**。

## 四条与判定方式

| # | 验收项 | 标准 | 程序能做 | 结果取值 |
|---|---|---|---|---|
| 1 | N 次执行结果一致 | 3 次执行 100% 一致 | 全自动 | `pass` / `fail` / `unknown` |
| 2 | 失败可从取证包定位 | 抽检 10 个失败，8 个能判根因 | 只能算「可判依据齐全率」 | `pass` / `fail` / `unknown` |
| 3 | 单条耗时与资源占用被记录 | — | 只覆盖耗时 | `pass` / `fail` |
| 4 | 计划改动可读 diff | 人能在 10 分钟内改完一条 | **程序无法判** | 恒 `manual` |

## 三个不许糊弄的口径

**一、单次执行没有一致性可言。** `consistent` 在重复次数不足时是 `null`，不是 `true`。把跑过 1 次的用例算成「一致」，是这类报告最常见也最害人的地方——它让「没验证过」看起来和「验证通过」一模一样。

**二、`inconclusive` 不算不一致，也不算一致。** 它单列。算进不一致会把环境问题误判成脚本不稳；算进一致会把不确定性藏起来。只有 `passed` / `failed` 进可判集。

**三、`N=3` 是入库门口径，不是运行期口径。** §20.2.1 的 3 次重复是**入库门**；运行期按 L-6 分层采样，并非每条都跑 3 次。报告的 `scope: 'entry_gate'` 字段和 `scope_note` 会把这个区别写在正文里，避免「一致性 100%」被误读成「每次回归都跑 3 遍」。

## 三种 `overall`

```
not_ready             任一条 fail 或 unknown
ready_pending_manual  1/2/3 都 pass，仅第 4 条待人工
ready                 第 4 条也拿到人工结论（当前实现不会自动到这一态）
```

关键在于 **`unknown` 归到 `not_ready`**。「没跑过」「没有失败记录所以无法判取证包」都不等于通过。

## 第 2 条为什么只能是「上限」

程序能判的是：失败记录里有没有 `evidence_paths`、有没有 `error.type` / `error.message` / `failure_summary`。这是「可判依据齐全」，**不是**「人看了能直接判断根因」。后者必须人工按 §18.2 抽 10 个失败逐个看。报告 `note` 里写明了这一点，且在没有失败记录时输出 `available:false` + `不适用不等于满分`。

## 第 3 条的落地修复

原先 `duration_ms` 只记在**请求回执**（`execution/api/evidence/<request_id>.json`）上，用例级结果里没有。§18.2 要的是「单条用例耗时」，只留在回执上等于没记。

`scripts/api-worker.mjs` 的 `persistResults` 现在按 `row.requests` 汇总：

```js
const stepDurations = stepReceipts.map(r => r?.duration_ms);
const durationMs = stepDurations.length && stepDurations.every(v => Number.isFinite(v))
  ? stepDurations.reduce((sum, v) => sum + v, 0)
  : null;
```

规则：**缺任何一条回执耗时即为 `null`**。不拿部分和冒充整条。

资源占用（CPU/内存）仍未采集，报告写明「第 3 条只满足一半」——宿主侧采集是下一轮的事，不在这里假装已完成。

## 用法

```bash
node scripts/consistency-report.mjs --run-id=<run_id> [--repeats=3]
```

输出 `output/runs/<run_id>/report/m1-consistency.md`，并打印 `overall` 与四条摘要。

多次尝试来自 `execution/attempts/<attempt>/test_results.json`（存在则纳入），`attempt` 字段用于区分轮次。

## 自检

`tests/acceptance/consistency-report.test.mjs`，23 条用例全绿，已纳入 `--suite=smoke`。覆盖：无记录、单次执行、重复不足、全一致、不一致明细、inconclusive 单列、blocked/skipped 不进可判集、部分达标分母修正、入库门口径、取证包不适用、取证包缺证据、无耗时、p50/p95/max、第 4 条恒 manual、`overall` 三态、markdown 渲染。

真实 run 验证：`run-ba3980c2-…` 上产出报告，`overall: not_ready`——该 run 只有 1 条 blocked 记录，报告如实给出 `unknown` / `unknown` / `fail` / `manual`，没有编造通过。
