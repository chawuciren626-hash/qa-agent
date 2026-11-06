# 缺陷严重程度分级标准

本文件是缺陷分析阶段判定 `severity` 的唯一标准，适用于独立任务（task）和生命周期（lifecycle）两种交付。它只规定“问题有多严重、依据是什么”，不替代产品修复优先级，也不把未验证的推测写成已确认缺陷。

## 1. 等级定义

| 等级 | 定义 | 典型判定 | 发布影响 |
| --- | --- | --- | --- |
| `Blocker` | 目标主流程完全不可用，或造成不可接受的数据/安全/合规后果，且没有可用的绕过方式。 | 无法登录、无法下单、数据被破坏且不可恢复、明确的安全或隐私泄露。 | 阻断发布，必须先处置。 |
| `Critical` | 核心业务目标无法完成或关键数据错误，影响大多数目标用户；绕过方式代价高或会引入新的业务风险。 | 支付金额错误、核心查询无结果、权限越权但范围受限。 | 进入发布风险，需要明确接受或修复。 |
| `Major` | 重要功能失败或结果明显错误，影响部分用户或特定条件；存在可接受的绕过方式。 | 某个筛选条件失效、次要页面报错、消息偶发丢失。 | 通常需要排期修复。 |
| `Minor` | 次要功能、展示或易用性问题，影响小，绕过容易，不阻断业务目标。 | 字段顺序不符、非关键提示文案错误、局部样式错位。 | 可随版本修复。 |
| `Trivial` | 纯文案、样式、提示等轻微问题，不影响任务完成。 | 标点、空格、图标不一致。 | 可延后。 |
| `unknown` | 当前证据不足以确认影响、范围或绕过方式中的至少一项，无法负责任地给出等级。 | 只有一条断言失败、没有业务影响说明或复现范围。 | 不得当作低风险；需要人工复核或补充证据。 |

等级按“已证实的影响”选最高适用项，不按失败断言数量、页面数量或测试点数量累加。频率属于影响范围的一个维度，不能单独抬高等级，也不能凭空猜测。

## 2. 四个判定维度

每条新记录必须写全 `severity_dimensions`。无法确认的维度写 `unknown`，并在 `severity_reason` 说明缺什么证据。

| 字段 | 允许值 | 含义 |
| --- | --- | --- |
| `user_business_impact` | `critical` `major` `minor` `none` `unknown` | 是否阻断业务目标、产生错误结果或损坏关键数据。 |
| `reach_frequency` | `all` `many` `some` `few` `unknown` | 受影响用户/场景范围。只有真实使用数据或明确需求范围时才可填具体值；没有证据写 `unknown`，不得编造频率。 |
| `recoverability` | `none` `expensive` `workaround` `easy` `unknown` | 是否存在绕过、重试、恢复或回滚方式及其代价。 |
| `data_security_compliance` | `confirmed` `suspected` `none` `unknown` | 是否涉及数据丢失/损坏、隐私、安全或合规风险。`suspected` 只表示有证据指向但未确认，不能写成已确认泄露。 |

### 判定顺序

1. 先看 `data_security_compliance`：若为 `confirmed`，至少 `Critical`；若为 `suspected`，不得低于 `Major`，并在理由中写明尚未确认的部分。
2. 再看 `user_business_impact`：`critical` → `Blocker`；`major` → 至少 `Critical`；`minor` → `Major` 或 `Minor`；`none` → `Trivial`。
3. 用 `recoverability` 调整：`none` 可上调一级；`easy` 可下调一级，但不得低于 `Minor`（除非 `user_business_impact=none`）。
4. `reach_frequency` 只用于同级内取舍或说明影响面，不单独升级。没有真实频率证据时保持 `unknown`，并在理由中写明“频率未证实”。
5. 如果 `user_business_impact` 和 `recoverability` 都无法确认，直接使用 `unknown`，不要用 `Major` 等中间值伪装确定性。
6. 证据只能证明“某个断言失败”时，不能直接判 `Blocker`/`Critical`；必须补充业务影响、影响范围或恢复方式。

## 3. 证据要求

- 每个等级都必须有 `evidence_refs`，并与实际失败断言、日志、截图或 trace 对应。
- `Blocker`/`Critical` 还应提供至少一条能说明业务影响、范围或不可恢复性的证据；只有单条断言失败时，最高只能判 `Major`，或保持 `unknown`。
- `severity_evidence` 可选；填写时必须是 `evidence_refs` 的子集，用于指出哪条证据支撑等级。
- `severity_reason` 必填：说明为什么是该等级，或说明 `unknown` 还缺哪些证据。理由不得复述缺陷标题，也不得包含未经验证的频率、用户量或安全结论。
- `confidence`（证据可信度）与 `severity`（影响程度）分开：证据可信度低时仍可记录暂定等级，但生命周期只能是 `needs_review`；不能因为等级高就把低可信度证据写成已确认缺陷。

## 4. unknown 的约束

- `unknown` 是正式取值，不是“没填”的同义词。必须写 `severity_reason`，并至少说明缺失的维度或证据。
- 新标准记录（`severity_standard_version: 1`）中，开放状态（非 `closed`/`rejected`）的 `unknown` 会触发质量门 `unknown_severity`（`review_required`）；不会被当作低风险，也不会自动升级为 `risk_present`。
- 历史记录没有 `severity_standard_version` 时按旧记录读取，不追溯改写、不自动补等级；页面显示“未评估/未记录”，而不是“低”。
- 不允许把 `unknown` 写成 `Minor` 来绕过复核；也不允许把没有证据的 `Blocker`/`Critical` 写进发布风险。

## 5. 优先级映射（建议，不自动推导）

`priority` 是排期决策，和 `severity` 分开记录。默认建议如下，项目可以覆盖，但覆盖时要在缺陷说明中写理由：

| severity | 建议 priority |
| --- | --- |
| `Blocker` | `P0` |
| `Critical` | `P0` 或 `P1` |
| `Major` | `P1` 或 `P2` |
| `Minor` | `P2` 或 `P3` |
| `Trivial` | `P3` |
| `unknown` | `unknown` |

不能因为 `severity=Major` 就自动写 `P1`；也不能用 `priority` 反推 `severity`。

## 6. 交付字段

新记录在 `defects/defect-records.json` 的 `records[]` 中包含：

```json
{
  "defect_id": "DEF-EXAMPLE",
  "title": "提交订单后未生成订单记录",
  "category": "product_defect",
  "severity": "Critical",
  "severity_standard_version": 1,
  "severity_reason": "核心下单流程无法完成，影响所有尝试下单的用户；刷新后仍无订单，未发现可用绕过方式。",
  "severity_dimensions": {
    "user_business_impact": "critical",
    "reach_frequency": "unknown",
    "recoverability": "none",
    "data_security_compliance": "unknown"
  },
  "severity_evidence": ["execution/screenshots/order-fail.png"],
  "evidence_refs": ["execution/screenshots/order-fail.png", "execution/logs/order.log"]
}
```

- `severity` 和 `priority` 的枚举与 `schemas/defect_record.schema.json` 一致。
- `severity_standard_version` 固定为 `1`。`normalize-defects` 写入新记录时若未提供会补为 `1`；已存在的旧记录缺少该字段时按旧记录读取，不追溯改写，也不触发新校验和 `unknown_severity` 门禁。
- `severity_dimensions` 的四个键必须写全；没有证据的维度写 `unknown`。
- `severity_evidence` 可选；填写时必须是 `evidence_refs` 的子集。
- 独立任务与生命周期使用同一字段；生命周期台账以首次登记观察为不可变基准，确认阶段如需改级，应记录理由并保留原观察，不得直接改写历史。

## 7. 质量门与报告

- 开放记录中只要存在新标准 `unknown`，报告质量门至少为 `review_required`，原因是 `unknown_severity`。
- `Blocker`/`Critical` 仍按 `config/quality-governance.json` 的 `risk_on_severity` 触发 `risk_present`。
- 报告和导出必须分别展示“已知等级分布”和“未评估数量”；不能把未评估合并进 `Minor`，也不能用总数掩盖未知。
- 旧记录缺少严重度时显示“未记录”，不得补写为 `unknown` 以外的等级，也不得据此得出“无高严重度缺陷”的结论。
