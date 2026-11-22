---
name: requirement-analysis
version: 2026.11.22.2
description: 分析需求中的功能、业务规则、风险和待澄清问题。
task: requirement_extract
stage: analysis
tools: ["requirement.testability", "requirement.acceptance", "irval.check"]
sections:
  criteria: ["什么算写足了", "不要做"]
  knowledge: ["怎么看一条需求写没写清", "六类东西要分清"]
  steps: ["输入", "输出", "产物格式", "工作步骤"]
---

# 需求分析

## 适用范围

从需求文档、用户故事、原型说明或代码变更里，识别功能范围、业务规则、风险点和真实待确认问题。
接口契约走《接口契约分析》，不在这里做。

**性能/安全测试不在当前范围**：原文里的压测、并发、漏洞、渗透要求只作为范围说明标注
"当前能力范围外"，不拆成功能规则、不列为必答澄清，也不阻塞其余需求的分析。

## 输入

- 本 run 的 `inputs/` 原文：用户文字、文档、链接快照。
- 可选：原型说明、代码变更 Diff、历史缺陷。
- Word 保留原始 `.docx`，读提取出的正文与结构化结果。正文与表格按顺序提取，定位是段落/表格/行/单元格，不是页码；引用指向提取文本，并注明原文件与提取方式。
- 先看提取告警。图片、批注、修订可能没读到，**没读到的不能宣称已读**，作为材料局限写出来。
- 原文已明确写出的数值、否定、条件和文案，不重复要求确认。

## 输出

1. 需求摘要
2. 模块列表
3. 功能点列表
4. 业务规则
5. 异常流程
6. 风险点
7. 待确认问题
8. 当前 run 的 `analysis/requirement_analysis.md` 与 `analysis/requirement-ledger.json`，原始材料快照留在同 run 的 `inputs/`

## 产物格式

台账是唯一来源，正文从台账生成。字段与取值固定，**未知字段会被拒绝**，不要加 `notes`、`assumptions` 这类自创键。

```json
{
  "version": 1,
  "run_id": "run-example",
  "sources": [
    { "id": "SRC-1", "kind": "user_requirement", "path": "inputs/request.txt",
      "origin": "材料名称或会话", "locator": "版本及章节，或消息时间与段落" }
  ],
  "rules": [
    { "id": "RULE-1", "statement": "删除不存在的记录时应返回错误",
      "kind": "requirement", "scope": "in_scope", "status": "confirmed",
      "module": "记录管理", "category": "functional", "reason": "",
      "citations": [ { "source_id": "SRC-1", "quote": "删除不存在的记录时应返回错误" } ] }
  ]
}
```

| 字段 | 允许取值 |
|---|---|
| `sources.kind` | `user_requirement` / `user_confirmation` / `specification` / `implementation` / `observation` / `historical` |
| `rules.kind` | `requirement` / `observation` / `assumption` |
| `scope` | `in_scope` / `out_of_scope` |
| `status` | `confirmed` / `pending` / `conflicted` / `rejected` / `observed` |
| `category` | `functional` / `constraint` / `context` / `environment` / `risk` / `clarification` |
| `module` | 非空文字，用原文的模块名 |

硬约束：

- `sources.kind` 前三类才能支撑业务需求；`implementation` / `observation` / `historical` 只能作观察，不能单独定义预期。
- `status=observed` 只能配 `kind=observation`。
- 非 `confirmed` 或 `out_of_scope` 必须写 `reason`。
- 至少有一条 `in_scope` 的 `requirement`。
- `quote` 放连续原文，释义放 `statement` 或 `reason`。
- 假设若标 `confirmed`，必须引用 `user_confirmation` 类型来源的真实确认原文。

正文按台账 ID 分块：需求 → 观察 → 假设 → 待确认与未决 → 范围排除，块内按 ID 排序。正文结构由生成器决定，不要手改章节或手工补正文。

## 工作步骤

1. 读输入文档，先看告警。
2. 按模块拆分功能。
3. 提取主流程、异常流程和约束条件。
4. 标记高风险点。
5. 为每条规则分配稳定 ID，填齐范围、状态、分类、引用与未决原因。
6. 登记待确认问题，说明关联规则和不同理解会带来的不同结果。
7. 存台账，跑结构检查，通过后生成正文，再校验产物。
8. 逐条做语义核对，确认没有释义削弱原文。

## 怎么看一条需求写没写清

逐条问五个问题，任何一个答不上来就是缺口：

1. 输什么、什么范围、什么单位，边界值算哪一边。
2. 做了什么之后，状态从什么变成什么。
3. 成功看到什么、失败看到什么——是不是只有一种合理解释。
4. 数值、精度、指定文案，是不是原文说了算。
5. 条件、否定、AND/OR，有没有被读反。

只有"不同理解会改变原文已要求行为的结果"才算待确认。实现方式（前端还是后端、字段存在哪、用什么存储）不算。

## 六类东西要分清

| 类别 | 是什么 | 怎么落 |
|---|---|---|
| 需求 | 原文要求的业务行为 | `kind=requirement`，`scope=in_scope` |
| 实现观察 | 代码、页面现状、历史测试呈现的样子 | `kind=observation`，`status=observed` |
| 背景 | 架构与上下文说明 | `category=context`，仍是有来源的条目 |
| 环境前提 | 账号、服务可达、数据准备 | `category=environment`，不要求业务测试点 |
| 假设 / 待确认 | 不同理解会改变结果 | `kind=assumption` + `pending` + `category=clarification` |
| 排除 | 原文明确不包含 | `scope=out_of_scope` 并引原话 |

性能/安全类要求属于当前能力范围外，用 `out_of_scope` 并写明是能力排除，不能说成原文排除。
端标签只按原文判断：`web` / `web_admin` / `app` / `miniprogram` / `desktop` / `api`；原文没说就留"未指定"，不根据实现细节猜。

## 什么算写足了

- 原文的必须/不得、条件、否定、数值、指定文案，一字未削。
- 多个同时要求的结果，没被改成任选其一。
- 原文只写"返回错误"，没被升级成具体状态码、文案或接口路径。
- 每条结论能追到来源；推断写进 `statement` / `reason`，不混进 `quote`。
- 每条规则挂了锚点（页面/接口/代码三选一），挂不上的标"暂不可测"并写清缺哪种。
- 结构校验通过只证明格式对；语义对不对，自己逐条核。

## 不要做

- 把猜测写成事实，凭空补需求。
- 删除待确认问题，或把待确认改成已确认而不给依据。
- 把"确认本阶段"说成用户已逐项确认所有未决规则。
- 手写正文绕开台账。
