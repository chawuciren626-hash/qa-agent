---
name: test-design-methods
description: 根据需求选择等价类、边界值、决策表和状态迁移方法，评审覆盖与可验证预期；用于需求审查、测试点和用例设计，不执行测试或替换交付契约。
license: MIT; see LICENSE.txt
metadata:
  version: '1.1.0'
  source: fugazi/test-automation-skills-agents
  revision: 65a72d5e74def3c23143bef8757e72cb68e91032
  adapted-from: qa-manual-istqb
---

# 测试设计方法

本Skill提供专业方法，产物仍按当前阶段主Skill的格式交付；不新增阶段、必填Schema字段或用户确认节点。

按实际问题选择方法，不要求每项需求套用全部方法：

| 需求形态 | 方法 | 应得到的检查目标 |
|---|---|---|
| 输入范围、格式 | 等价类＋边界值 | 有效/无效分区、边界与单位、空值差异 |
| 多条件组合 | 决策表 | 可行组合及动作，不能把AND改成OR |
| 状态/历史影响结果 | 状态迁移 | 合法迁移、禁止迁移及失败后状态保持 |
| 用户完整流程 | 场景＋异常分支 | 关键检查点和失败补偿，不仅检查最后跳转 |
| 材料不完整或新界面 | 有时间和范围边界的探索 | 观察、疑问、风险；不把观察升级为业务预期 |

设计时读[方法与示例](references/design-techniques.md)；评审需求或已有用例时读[语义与覆盖检查](references/review-checklist.md)。只加载相关参考。

涉及表单、列表、弹窗、业务权限或功能开关时，按需读[控件与业务状态场景](references/component-and-permission-scenarios.md)；被测对象本身包含对话、意图路由或知识问答时，读[AI功能场景](references/ai-functional-scenarios.md)。这些资料只帮助选择本次范围内的检查点，不为普通页面增加移动端、AI、性能或安全专项。

## 输出与边界

- lifecycle沿用rule_id → test_point → case_id；依据来自本次有效需求。task使用派发材料及独立任务契约，不为应用方法补造台账。
- 方法表属于设计辅助，必要时放当前运行的design/附加说明中，不代替正式JSON/Excel/XMind。不得自造Schema字段来强制记录方法。
- 未决业务规则标为未决；可测试的确定范围继续。不要为凑覆盖扩大到未授权功能。
- 边界数据按实际单位计算；金额用最小单位。待执行样例不称为实测结果。
