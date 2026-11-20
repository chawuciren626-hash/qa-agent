# P7 第一切片：失败三分归因（2026-11-20）

> 对应主计划 §8.1 的 **P7 视觉兜底与扩展（二期）** 中的 **M4「三分之一」**：只做
> **三分归因**，不做剧本固化（固化要有视觉走查的输入，等 M2b）。
> 一句话结论：**归因从"一个写死的字符串"变成"带依据、带置信度、判不了会说不准"的结论**，
> 并顺手拆掉了"断言一不对就判产品缺陷"这条默认通道。

## 1. 问题：product 是默认值，而且没人能复核

`web_engine` 里每个失败分支都把归因写死成一个字符串，读起来都合理：

| 位置 | 写死值 | 实际含义 |
|---|---|---|
| `_apply_asserts` → `decide_assert_failed` | `product` | **无条件**，不看环境、不看能否复现 |
| `_apply_waits` → `wait_timeout` | `product` | 同上 |
| `_act` / `_extract` → 定位不到 | `script` | 合理 |
| `_goto` → `env_unreachable` | `env` | 合理 |
| 驱动异常 → `driver_error` | `env` | 合理 |

问题集中在前两行，但它们恰好是**最高频**的两类失败。而"断言不对"至少是四种情况的共同表象：

1. 脚本写错了（预期本身就错）；
2. 数据被上一次执行污染；
3. 环境漂了（mock 换了、关键表结构变了、版本变了）；
4. 产品真的坏了。

把 1/2/3 一并说成 4，后果不是"结论不精确"，而是**团队开始无视所有失败**——这与
v3 §14.2 讲的 "flaky 靠重试掩盖，最后没人看失败"是同一个失效模式。

第二层问题：一个字符串没有依据、没有置信度。事后争"这算不算产品 bug"时，双方手里
只有那一个词。所以 §14.3 第三步要求的输入（结构化证据）在这里也不存在。

## 2. 做法：规则表 + 三路事实 + 护栏

新增 `aitestharness_tools/defect/attribution.py`（纯函数，不读文件、不调模型、不起浏览器）：

```
attribute_failure(exec_ir, *, preflight=None, replay=None, history=None) -> {
    category:    product_bug | script_issue | env_issue | data_issue | flaky | unknown
    confidence:  high | medium | low | none
    rule:        "A9" / "A9+guard" / ...
    because:     一句人话
    evidence:    [{kind, detail}]         ← 结论所依据的具体事实
    considered:  [{id, matched, because}] ← 11 条规则逐条命中情况（含"为什么没用")
    human_review: bool
    missing:     [...]                    ← 只在 unknown 时非空
    signals / environment / reproducibility
}
```

三路事实都是**已有产物**，不新增采集：

| 路 | 来源 | 回答什么 |
|---|---|---|
| 失败事实 | `exec_ir`（`halt` / `failure_kind` / `locator` / `assertions` / `waits` / `teardown`） | 失败发生在哪、什么类型 |
| 环境事实 | `exec.preflight()` 的 `status` + `comparison.drift` | 跑的环境还是不是基线 |
| 可复现事实 | `exec.replay()` 的 `deterministic` / `rounds_done`、`exec_ir.consistency`、历史 | 这次失败复现得了吗 |

### 2.1 规则表（顺序即优先级）

按"多能直接解释这次失败"排序，**不按严重性排序**：

| # | 规则 | 结论 | 置信度 |
|---|---|---|---|
| A1 | 未执行就失败（编译期 / 授权期） | `script_issue` | high |
| A2 | 结论不可复现（重放不一致 / 引擎 flaky / 历史摇摆） | `flaky` + **候选归因** | high |
| A3 | 定位失败 / 歧义 / 等待条件多命中 | `script_issue` | high |
| A4 | 动作失败 / 取值取空 | `script_issue` | high |
| A5 | 环境不可达 | `env_issue` | high |
| A6 | 驱动异常 | `env_issue` | high |
| A7 | 环境存在 blocking 漂移（非版本类） | `env_issue` | high |
| A8 | 历史残留 + 数量类断言不符 | `data_issue` | medium |
| A9 | decide 断言不成立，且环境可比、定位稳定、可复现 | `product_bug` | 见矩阵 |
| A10 | 等待超时且环境可比 | `product_bug` | 见矩阵，且**最高 medium** |
| A11 | 以上都不能解释 | `unknown` + `missing` | none |

三个排序决定值得记一笔：

1. **A2 在 A3 之前。** 一次没复现出来的定位失败，归 `script` 会让人去改一个其实没坏的
   选择器。先判 flaky，再给"稳定下来会归谁"的候选（`candidate`）——只给 flaky 不给
   候选等于没说，人还是不知道该查什么。
2. **A7 在 A9 之前。** mock 变了以后"断言不符"是必然结果，此时判产品就是假缺陷。
3. **A7 排除 `sut_version`。** 版本变了不等于环境坏了，更不等于产品有缺陷——只是
   "这次结论不可比"。单列成 `version_unknown` 档，由护栏降为 `unknown`。

### 2.2 product 的置信度矩阵

`product_bug` 是**要求最高**的结论，不是默认值：

| 环境档位 | 可复现 | 单次 |
|---|---|---|
| clean（`comparable`） | **high** | medium |
| warnings（文件 / 凭据漂移） | medium | low |
| unverified（没做前置校验 / 首次运行） | low | low |
| blocking / version_unknown | **不成立 → unknown** | 同 |

`A10`（等待超时）在矩阵之上再压一级：元素没出现可能是产品没渲染，也可能是声明的阈值
比该元素历史耗时还短。置信度最高 medium，`because` 里直接写"先怀疑阈值本身"。

「定位不稳定」也压级：靠第 2、3 个指纹才定位到的元素，断言比的可能不是同一个东西。
判 `low` 并写明"未排除定位漂移"。

### 2.3 两道护栏（在规则之后）

* **护栏一（环境）**：`product_bug` 在 blocking / version_unknown 档不成立，降为 `unknown`；
  unverified 压到 `low`；warnings 把 high 压到 medium。
* **护栏二（单次）**：只跑过一次的失败，无论环境多干净，最高 medium——
  "一次观测"不是"可复现"。

## 3. 三条阴性对照（这层存在的理由）

值得单独列出，因为它们是"归因有没有用"的分水岭：

1. **断言不符 + mock 变了 → `env_issue`**（旧写法：`product`，假缺陷）；
2. **断言不符 + 只有版本变了 → `unknown`**（不许判产品，也不许判环境——该做的是按新版重跑）；
3. **历史有残留 + 只有数量类断言不符 → `data_issue`；文案类断言不服 → 仍判产品**
   （残留不能变成第二个"兜底类别"）。

## 4. 可疑信号（§14.3 第二步，零额外成本）

`collect_signals(exec_ir, history=…)` 独立可用，**不改结论**，只回答"这条用例正在变脆吗"：

| 信号 | 判据 |
|---|---|
| 降级定位 | `step.locator.degraded`（首选指纹没命中，靠后位跑通） |
| 位置耦合 | `step.locator.positional`（按第 N 列 / 第 N 个定位） |
| 慢等待 | 任一 `waits[].elapsed_ms > 3000` |
| 耗时波动 | 与同计划**通过的**历史比，单步耗时偏离中位数 > 50% |

两个信号**取不到**，如实写在 `not_available` 而不是返回空数组：

* 控制台 / 网络异常——`exec_ir` 不携带控制台与网络事件（`_step_ir` 没有这两个字段），
  这是执行侧的真实缺口，不是本模块的取舍；
* 重试——引擎**不重试**（设计如此，v3 §14.6），N 轮重放是重放不是重试，该信号不适用。

`pass` 的 run 也照常给信号：一条靠第 3 个指纹、等了 4 秒才通过的用例，下个版本大概率会挂。

## 5. 接线

| 位置 | 改动 |
|---|---|
| `defect/attribution.py` | 新增（规则表 + 信号 + 护栏） |
| `runtime_cli.py` | `defect.tools` 增 `attribution`：**只在 payload 带 `exec_ir` 时**计算；不带则输出与之前完全一致（向后兼容已验证） |
| `scripts/stage-tool-runtime.mjs` | `defect.tools` 的 payload 声明与允许键增 `exec_ir` / `preflight` / `replay`（三者均为可选对象） |
| `scripts/central-mcp.mjs` | `PAYLOAD_SCHEMAS['defect.tools']` 同步三键 |

**没有新增 tool_id**：`failure_attribution` 契约（`agent/tasks.py`）本来就允许
`("defect.evidence", "defect.tools", "irval.check")`，归因挂在已有工具上，
所以 B1「契约⊆出口」不受影响。

### 5.1 `step.attribution` 与 `attribute_failure` 不是一回事

引擎在失败瞬间写的 `step.attribution` 是**初判**：那一刻它只有单点事实，看不到环境基线，
也看不到能不能复现。`attribute_failure` 是**结论**：拿到三路事实之后判。

所以规则表**完全不读** `step.attribution`。用例 `test_step_attribution_hint_is_ignored`
双向验证：初判说 product 而事实是定位失败 → 判 `script_issue`；初判说 script 而事实支持
产品 → 判 `product_bug`。

## 6. 验收

| 项 | 结果 |
|---|---|
| 新增用例 | `tests/smoke_attribution.py` **32 例**全过 |
| 其中真实引擎对齐 | 2 例：用 `WebEngine` + 内存驱动跑真计划，拿**引擎真的会产出**的 IR 再归因（定位失败→script，断言失败→product high） |
| 回归 | `smoke_tools` / `smoke_authorization` / `smoke_baseline` / `smoke_maps` / `smoke_preflight_replay` / `smoke_web_engine` / `smoke_run_trace` 全 PASS |
| CI | `check-capability-source.mjs` PASS（B1-B4）；`check-tool-contract.mjs` PASS（A1-A4） |
| 契约验收 | `tests/acceptance/central-mcp.test.mjs` 9 例、`stage-tool-scenarios.test.mjs` 1 例全过（schema 与校验层同源） |
| 确定性 | `test_same_input_same_output`：同一份事实两次调用结果逐字节相同 |

真实引擎对齐这一组是**必须**的：前面 30 例的 IR 是我按规格手写的，规格与实现漂了就会
"夹具全绿、线上全错"。写这组时当场抓到一处自己写错的夹具假设——`url_contains` 断言默认
`level=observe`（只记录不判定），不写 `level=decide` 时 `verdict` 是 pass。

## 7. 边界（明确不做什么）

1. **不替代 LLM Advisor。** 这是 `model_capability.failure_attribution` 声明的 fallback
   （"按 §14.3 规则表做确定性归因，人工复核"）。反过来，它产出的 `evidence` + `considered`
   正是第三步 LLM 分类该吃的结构化输入。
2. **不做剧本固化。** M4 的后半"首轮视觉走一遍反查稳定指纹"依赖 M2b，没有视觉输入时
   固化出来的只是"把执行轨迹抄成 YAML"，价值不足且会误导。
3. **不改引擎的分支归因。** `step.attribution` 保留原样：它是有用的初判，且已被
   `report` / `manifest` 消费。改它会牵动一串既有断言，收益只是"名字更准"。
4. **不补控制台 / 网络采集。** 那是执行侧证据缺口，属 P4 遗留（`_step_ir` 未带
   `console_errors` / `network`），补它要让 `web_driver` 挂事件监听，与本切片无关。
5. **不判 flaky 的根因。** 只判"不可复现"并给出候选类别；§14.4 的人工 triage
   （修资产 / 转偶发缺陷 / 进隔离区）是流程，不是函数。

## 8. 已知不准的地方

* **A8 只认数量类断言。** 数据污染也可能表现为"提示已存在"这类文案断言，但把文案类
  也算进来会让 `data_issue` 变成兜底类别，把真实产品缺陷漏掉。宁可判窄。
* **历史残留只看同 `plan.id`。** 跨计划共享数据的场景（A 计划造的脏数据坏了 B 计划）
  现在判不出来——需要数据血缘，当前没有。
* **`unknown` 的比例会比以前高。** 这是有意的：以前那些"product"里本来就混着环境与
  数据问题，现在它们落在 `unknown` 并带 `missing`。若 `unknown` 长期过半，说明缺的是
  **前置校验覆盖**与**重放覆盖**，不是这条规则表要放宽。
