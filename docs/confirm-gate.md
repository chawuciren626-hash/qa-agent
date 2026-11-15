# 确认卡点三件套（P2-2）

> 对应《AITestHarness 测试平台架构重构方案 v3》§23.2 第 5 条、§26 评审问题 P2-2。
> 脚本：`scripts/confirm-gate.mjs`　测试：`tests/acceptance/confirm-gate.test.mjs`（19 用例）

## 问题

200 需求 / 600 测试点 / 1500 用例若全部逐条人工确认，一个人要花两天。
**卡点太密等于没有卡点，团队第三天就会绕过——绕过一次，纪律就废了。**

## 三层设计

| 层 | 做法 | 落点 |
|---|---|---|
| ① 差异聚焦 | 只强制审「与上一版不同」的，未变默认继承（可一键全审） | `diffSince` / `mode:'diff'` |
| ② 抽样审核 | 每批随机 10% 深审，其余过；抽出的**问题率超阈值（默认 10%）退回全审** | `pickSample` / `evaluateSample` |
| ③ 风险加权 | P0 / 涉资字段 / 权限变更 → 强制全审；P2 → 仅抽样 | `riskTier` |

## 关键口径

**差异判定**：对剔除 `version` / `updated_at` / `confirmed_at` 后的实质内容取 SHA-256 指纹比对——版本号变了、内容没变不算差异；没有上一版时全部按新增审（不假装能继承）。

**抽样可复现**：按 `sha256(seed + id)` 排序取前 k 条（`k = max(1, ceil(n*rate))`）。同一批同一种子名单完全一致，可复现、可审计；换种子即换名单。

**问题率整数比较**：`problems*100 > threshold*100*picked`，避免浮点误差（如 2/19=10.5% 对 10% 阈值的误判）。

**统计诚实**：
- 深审样本 < 10 条 → 问题率没有统计意义，整批退回全审（宁多审，不冒充有把握）；
- 条目缺风险字段 → 按 `force` 对待——**没标风险的东西不享受省略待遇**；
- 强制项在任何 mode 下都进 `must_review`，diff/sample 都不能省略它。

**反绕过（`checkCompletion`）**：对照确认计划与确认记录，必审项缺记录逐条列出；`result: 'skipped'` 不算确认——「审过了但跳过」是绕过的常见马甲。有缺口时 CLI 退出码 1。

## 确认计划结构

```json
{
  "mode": "diff",
  "total": 1500,
  "must_review": ["TP-0001", "..."],   // 逐条审（changed + force）
  "inherit":   ["TP-0007", "..."],     // 未变低风险，默认继承
  "sample_pool": ["TC-0100", "..."],   // sample 模式的抽样池
  "sampled":   ["TC-0133"],            // 实际抽中
  "stats": { "changed": 320, "unchanged": 1180, "forced": 45 }
}
```

## CLI

```bash
node scripts/confirm-gate.mjs \
  --items=output/phase/test-points.json \
  --previous=output/phase/test-points.prev.json \
  --mode=diff --rate=0.1 --seed=batch-42 \
  --confirmed=output/phase/confirm-records.json \
  --out=output/phase/confirm-plan.json --json
```

`--confirmed` 提供时做反绕过核对；有缺口退出码 1，CI 可直接拦截。

## 边界

- 方案原文「抽样比例走服务端下发能力包（可调，不必发版）」——本模块把 rate/seed 做成 CLI 参数，服务端下发属产品层接线，不在本仓；
- 本模块产出**计划与核对**，不产出人机交互界面；`PhaseState.confirm(mode:...)` 的接线属 M2 产品化范围；
- 抽样审核的「深审」仍是人工动作，本模块只保证抽谁、判去留、防绕过三件事是机器做且可审计的。
