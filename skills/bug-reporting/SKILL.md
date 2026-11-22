---
name: bug-reporting
version: 2026.11.22.1
description: 依据真实执行回执、日志、截图与关联用例，把失败逐条分类为产品缺陷、脚本、环境、数据或待确认，按四维判定严重度并产出可追溯缺陷记录与草稿；含多步根因调查方法。
task: failure_attribution
stage: defects
tools: ["defect.evidence", "defect.tools", "irval.check"]
sections:
  criteria: ["产物格式（强制）", "严重度四维", "分类判定", "自检清单", "不要做"]
  knowledge: ["失败现象与区分证据", "多步根因调查", "生命周期语义"]
  steps: ["输入", "输出", "工作步骤"]
---

# 缺陷分析

## 输入

| 来源 | 用途 | 缺了会怎样 |
|---|---|---|
| `execution/test_results.json` | 失败用例、错误信息、证据路径 | 没有就无从分析，交回队长 |
| `execution/api/test_results.json` | 接口轨失败（分支独立） | 只读当前派发选中的分支 |
| `execution/execution-state.json` | 判断结果属于哪一批次 | 批次不清时不沿用上轮结论 |
| `quality/evidence-assessment.json` | 每条失败能信到什么程度 | **必须先生成**，否则校验失败 |
| 证据文件（截图、日志、trace） | 支撑分类与严重度 | 引用不存在的路径会被拒 |

证据评估要覆盖**恰好**所有失败用例，多一条少一条都算不完整。这是硬前置，不是可选步骤。

## 输出

| 文件 | 谁写 | 说明 |
|---|---|---|
| `defects/defect-records.json` | 你 | 本 run 唯一事实源，缺陷与报告的来源 |
| `defects/bugs.md` | 你 | 人看的缺陷草稿 |
| `defects/defects-task.json` | 你 | 任务结论与限制 |
| `defects/bugs.json` | 你（仅 lifecycle） | 规范化前的原始草稿 |
| `defects/lifecycle.json` | 受控动作 | 处置台账，不手写 |

## 产物格式（强制）

### 信封

```json
{
  "run_id": "run-...",
  "records": [],
  "summary": {
    "product_defect": 0,
    "script_issue": 0,
    "environment_issue": 0,
    "test_data_issue": 0,
    "needs_review": 0
  }
}
```

`summary` 五个类别的计数**必须**与 `records` 实际条数一致，少写一个键或数字对不上都会被断言打回。
没有问题时 `records` 可以是空数组，但五个计数键仍要齐。

### 单条记录字段

| 字段 | 必填 | 取值 / 说明 |
|---|---|---|
| `defect_id` | 是 | 本 run 内唯一，不自造与前序冲突的编号 |
| `title` | 是 | 具体到模块与现象，不写"功能异常"这种 |
| `fingerprint` | 是 | 稳定指纹，同一问题多次分析要能对上 |
| `category` | 是 | 见下节五分类枚举 |
| `lifecycle_status` | 是 | `draft` / `needs_review` / `confirmed` / `rejected` / `fixed` / `closed` |
| `confidence` | 是 | `low` / `medium` / `strong`，不得超过证据评估等级 |
| `related_cases` | 是 | 只能引用本次 **status=failed** 的 case_id，且不重复 |
| `evidence_refs` | 是 | 本 run 内真实存在的文件路径，逐条都会被核验 |
| `severity` | 建议 | `Blocker` / `Critical` / `Major` / `Minor` / `Trivial` / `unknown` |
| `severity_standard_version` | 建议 | 新版评估固定写 `1` |
| `severity_reason` | 建议 | 说明为什么是这个等级，或为什么是 unknown |
| `severity_dimensions` | 建议 | 四个维度齐全，取值见下节 |
| `severity_evidence` | 否 | 若写，每一项都必须是 `evidence_refs` 里已有的路径 |
| `priority` | 否 | `P0`–`P3` / `unknown`，人工决定，不由严重度推导 |
| `expected_result` / `actual_result` | 建议 | 实际结果只写观察到的，不混入推断 |
| `analysis` | 否 | 根因分析正文 |
| `duplicate_of` | 否 | 指向**前面已出现**的同指纹记录 |

### 五分类枚举

`product_defect` · `script_issue` · `environment_issue` · `test_data_issue` · `needs_review`

### 三条交叉规则（最容易漏）

1. **每个 failed 用例都必须出现在某条记录的 `related_cases` 里。** 漏一个就整体不通过。
2. **`related_cases` 不能引用 blocked、skipped、passed 的用例。** 未完成不是缺陷。
3. **`duplicate_of` 只能指向排在前面的记录，且指纹必须相同。** 顺序写反也算错。

### 最小示例

```json
{
  "run_id": "run-2026-11-22T09-08-30-388Z",
  "records": [{
    "defect_id": "DEF-001",
    "title": "登录页空密码提交后仍进入首页",
    "fingerprint": "login-empty-password-enters-home",
    "category": "product_defect",
    "lifecycle_status": "draft",
    "confidence": "medium",
    "related_cases": ["TC-004"],
    "evidence_refs": ["execution/evidence/TC-004-step3.png"],
    "severity": "Major",
    "severity_standard_version": 1,
    "severity_reason": "登录校验失效可绕过身份验证，但需可达登录页，恢复方式为改密码策略",
    "severity_dimensions": {
      "user_business_impact": "major",
      "reach_frequency": "unknown",
      "recoverability": "workaround",
      "data_security_compliance": "suspected"
    },
    "expected_result": "空密码提交被拒绝并提示错误",
    "actual_result": "提交后跳转首页，提示登录成功"
  }],
  "summary": {"product_defect": 1, "script_issue": 0, "environment_issue": 0, "test_data_issue": 0, "needs_review": 0}
}
```

## 严重度四维

| 维度 | 允许取值 |
|---|---|
| `user_business_impact` | `critical` / `major` / `minor` / `none` / `unknown` |
| `reach_frequency` | `all` / `many` / `some` / `few` / `unknown` |
| `recoverability` | `none` / `expensive` / `workaround` / `easy` / `unknown` |
| `data_security_compliance` | `confirmed` / `suspected` / `none` / `unknown` |

判定要点：

- 四维必须齐全，多写一个不认识的维度也会被拒。
- 没有真实使用数据就写 `unknown`，不猜频率。`unknown` 是正式结论，不是低风险的替代写法。
- `Blocker` / `Critical` 需要能说明业务影响、范围或不可恢复性的证据，单条断言失败不够。
- 等级、理由、四维三者要能对上；对不上宁可降级写 unknown。

## 分类判定

| 分类 | 什么情况才成立 | 不成立时 |
|---|---|---|
| `product_defect` | 有证据表明被测系统行为与要求不符 | 只能降为 needs_review |
| `script_issue` | 能明确定位到脚本、测试数据、选择器的根因 | 一律 needs_review |
| `environment_issue` | 能定位到环境、服务、网络、依赖不可用 | 一律 needs_review |
| `test_data_issue` | 能定位到数据准备本身不对 | 一律 needs_review |
| `needs_review` | 其余全部 | —— |

三条硬话：

- **排除不了产品问题，就是待确认。** 不能因为"看着像脚本问题"就归到脚本。
- 证据评估为低可信度或证据不可访问的失败，必须是待确认。
- 存在待确认项时，只能表述"尚未确认产品缺陷"，不能写成"无产品缺陷"。
  没有缺陷时允许空列表，但结论措辞要跟着变。

## 失败现象与区分证据

先查已有证据，再提假设。下列现象不能凭直觉定性：

| 现象 | 要区分的原因 | 有用的区分证据 |
|---|---|---|
| 等待超时 | 请求没发出、依赖故障、产品没结束、定位错误 | 同次动作时间、请求回执、页面状态、等待条件；超时本身说明不了是哪类 |
| 接口成功但页面没变 | 业务码失败、异步未完成、展示问题、观察过早 | 响应字段、契约终态、操作前后界面与采样时刻；200 不是界面通过的证明 |
| 提示拒绝但数据变了 | 产品副作用、准备数据串扰、读到别人的结果 | 同一对象与身份的前后状态、请求关联、数据归属 |
| 只在部分运行中失败 | 产品竞态、共享数据、环境波动、脚本不稳 | 独立尝试之间的版本与输入差异；偶发不等于环境问题 |
| 多条用例相似错误 | 同一依赖、多个独立缺陷、同一根因 | 影响对象、触发条件、证据链；相似文案只能产生重复候选 |

这些情况下都写"已观察事实 + 可能解释 + 缺什么证据"，不写结论。
重试仍失败不证明是产品缺陷，重试成功也不抹掉原失败。
有 n 次里 m 次出现的记录可以写，没有独立样本就不估算复现概率。

## 多步根因调查

简单错误直接给有依据的判断，不必写长调查。多步骤才用下面的结构：

- 运行、用例、证据批次或材料来源
- 原始失败与有效预期依据
- 频率及观测样本（未复现就明说）
- 环境、构建、数据、并发条件

| 假设 | 支持证据 | 反证或缺口 | 区分实验与副作用 | 验证结果 |
|---|---|---|---|---|

要点：

- 频率（稳定 / 间歇 / 未复现）和原因（产品 / 脚本 / 环境 / 数据 / 待确认）分开记。
- 日志时间、网络响应、界面截图、数据前后状态要指向**同一次操作**，不拼不同批次。
- 需要真实复现时，把最小实验范围、变量、数据副作用、停止条件交回队长，由执行角色按授权做。
- 未做的实验不能填成成功；复测结论引用独立的新批次。
- 调查正文只写脱敏摘要，不复制凭据，不改封存证据。

## 生命周期语义

| 状态 | 含义 | 谁能改 |
|---|---|---|
| `draft` | 规范化刚生成的草稿 | 受控动作 |
| `needs_review` | 证据不足，等人工判断 | 受控动作 |
| `confirmed` | 已确认缺陷 | 需治理台账记 actor / reason / 依据 |
| `rejected` | 判定非缺陷 | 同上 |
| `fixed` | 只是修复声明 | 同上；不等于关闭 |
| `closed` | 需修复之后独立封存的合格复测批次，关联用例全部通过 | 同上 |

- 不得仅凭模型文字把状态推到 confirmed / fixed / closed；规范化只登记原始观察。
- 已登记的观察与当前草稿不一致时，保留原观察，交总控走治理流程，
  不删台账、不改 ID、不改优先级来绕过。
- 复测失败回到 confirmed。改级必须记录理由，不能改写已登记观察。
- 跨运行的指纹聚合只是同 scope 的重复候选，默认只作用本次 run，不自动合并身份。
- 报告完成之后治理状态变化会要求报告重制，通知总控恢复报告阶段。

## 工作步骤

1. 确认本次 run 与分析范围（功能轨 / 接口轨）；只读派发选中的分支来源与哈希。
2. 做证据评估，覆盖所有失败用例；生成 `quality/evidence-assessment.json`。
3. 读失败用例、错误信息、关联证据，逐条读懂"到底哪一步不对"。
4. 按五分类判，按四维判严重度；判不出来的写待确认与 unknown，并说清缺什么。
5. 写 `defect-records.json`（信封 + 记录 + summary）与 `bugs.md`；lifecycle 另写 `bugs.json`。
6. lifecycle：受控动作生成标准记录与台账，不手写台账。
7. 自检：每个 failed 用例都有记录、summary 对得上、证据路径都存在。
8. 校验本阶段产物，写 `defects-task.json`，交回执。

## 自检清单

- [ ] 每个 failed 用例都出现在某条 `related_cases` 里，一条没漏
- [ ] `related_cases` 里没有 blocked / skipped / passed 的用例
- [ ] `summary` 五个计数与记录实际条数逐项相等
- [ ] 每条 `evidence_refs` 都是真实存在的本 run 文件
- [ ] 每条记录都有 `title`、`fingerprint`、`lifecycle_status`、`confidence`
- [ ] 四维齐全、取值合法；`severity_evidence` 的每一项都在 `evidence_refs` 里
- [ ] `confidence` 没超过该用例的证据评估等级
- [ ] `duplicate_of` 指向了前面的同指纹记录
- [ ] 有待确认项时，结论写的是"尚未确认产品缺陷"

## 不要做

- 不凭猜测写产品缺陷，不把脚本错误写成产品 Bug。
- 不改原始执行结果、断言、业务预期；不删证据。
- 不自己复现、不跑脚本、不重试执行——需要复现就交回队长。
- 不把 `unknown` 描述成低风险，不为了交付改成 `Minor`。
- 不提交 Jira、禅道等外部平台；不声称已修复或已关闭。
- 不写测试报告，不把缺陷计数当报告结论。
