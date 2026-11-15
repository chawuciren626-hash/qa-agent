# 数据生命周期纪律（P1-6）

> 对应《AITestHarness 测试平台架构重构方案 v3》§9 第 4 条资产纪律、§26 评审问题 P1-6。
> 脚本：`scripts/data-lifecycle.mjs`　测试：`tests/acceptance/data-lifecycle.test.mjs`（22 用例）

## 问题

上一轮建的订单留在库里，下一轮查「最新一笔」查到脏数据——测试数据只建不清，
越跑越脏，而且脏数据造成的失败会被误判为产品缺陷。

## 三条纪律

| 纪律 | 要求 | 违规码 |
|---|---|---|
| 1. 必须声明且必须清理 | 每个数据集声明 `setup`/`teardown`；清理失败进 `data_residue`，不许静默 | `MISSING_SETUP`、residue 条目 |
| 2. 无 teardown 只许只读 | 未声明 teardown 的数据集只允许查、比对，不允许增删改 | `MUTATING_WITHOUT_TEARDOWN` |
| 3. 基础数据与临时数据分开 | `persistent: true` 的数据集纳入建档，不许被用例级步骤增删改 | `PERSISTENT_MUTATED`、`PERSISTENT_UNFILED` |

另有 `UNDECLARED_DATASET`：写步骤引用了没声明的数据集——连生命周期都没进系统，谈不上清理。

## 数据集声明格式

```json
{
  "id": "orders",
  "setup": "POST /api/orders 批量造 20 单",
  "teardown": "DELETE /api/orders?batch=batch-42",
  "persistent": false,
  "filed": false
}
```

- `teardown` 缺失 → 自动获得 `readonly_only` 标记（纪律 2）；
- `persistent: true` 但未 `filed: true` → `PERSISTENT_UNFILED`（基础数据的变更将没有 diff 可查）。

## 写语义判定（`stepMutates`）

判定顺序：显式声明（`writes: true` / `readonly: true`）→ HTTP 方法（POST/PUT/DELETE/PATCH 写，GET 只读）→ 动作词缀（`create_/delete_/fill_/submit_…` 写，`query_/verify_/…` 只读）。三步都判不出时归入 `unknown_mutation` 正面列出——**不冒充只读，也不冒充违规**。

## 数据集引用识别

两种写法都认：步骤字段 `dataset: "orders"`；输入占位 `${data.orders.username}`。

## residue 口径（`collectResidue`）

| 情形 | 处理 |
|---|---|
| teardown 执行且 `ok=true` | 进 `cleaned` |
| teardown 执行失败 | 进 `data_residue`，带原因 |
| 声明了 teardown 但没有执行记录 | 进 `data_residue`——**没跑 ≠ 没残留** |
| 清理结果对应的数据集未声明 | 进 `data_residue`——孤儿结果不许静默丢弃 |
| 未声明 teardown 的数据集 | 不进 residue（纪律 2 下本就不许写），归 `readonly_sets` 单列 |

## CLI

```bash
node scripts/data-lifecycle.mjs \
  --datasets=data/datasets.json \
  --plan=output/runs/<run>/plan/plan.json \
  --teardown=output/runs/<run>/execution/teardown-results.json \
  --out=output/runs/<run>/execution/data-lifecycle.json --json
```

有残留或违规时退出码 1（CI 可直接拦截）。产物 `execution/data-lifecycle.json` 会被
`buildRuntimeSections` 读取，作为报告「运行时事实」第 6 段正面呈现；缺产物时报告写
「本轮未生成数据生命周期检查」并说明后果，不省略。

## 边界

- 本模块**只判定与呈现，不执行清理**。teardown 结果由执行器传入，避免「假装清理过」；
- 写语义词缀表按现有计划的动词约定维护，新动词先补 `MUTATING_ACTIONS` / `READONLY_ACTIONS`
  再上计划——否则会落进 `unknown_mutation`（可见但不可拦截），这是有意为之的保守口径。
