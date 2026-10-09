---
name: requirement-analysis
description: 分析需求中的功能、业务规则、风险和待澄清问题。
version: 1.0.0
---

# 需求分析 Skill

交付前经统一命令入口运行`validate-artifacts.mjs <run_id> analysis`，遵循`docs/artifact-contracts.md`与`docs/requirement-provenance.md`。检查结构化规则台账、原文引用和来源快照，仍不替代需求范围、歧义和业务语义的人工审查。

## 适用场景

当需要从需求文档、用户故事、接口文档或代码变更中识别功能范围、业务规则、风险点和待确认问题时使用。

## 输入

- 用户提供的文字、文档、链接或已有测试资产
- 可选：接口文档、原型说明、代码变更 Diff、历史 Bug

## 输出

- 需求摘要
- 模块列表
- 功能点列表
- 业务规则
- 异常流程
- 风险点
- 待确认问题
- 当前 `run_id` 的 `analysis/requirement_analysis.md`
- 同目录`requirement-ledger.json`，以及run内`inputs/`下的原始材料快照；结构和完整示例见`docs/requirement-provenance.md`。

## 工作步骤

1. 阅读输入文档。
2. 按模块拆分功能。
3. 提取主流程、异常流程和约束条件。
4. 标记高风险点。
5. 输出待确认问题。
6. 为每条规则分配稳定ID，区分需求、实现观察与假设，登记范围、状态、原文引用及未决/排除原因。摘要必须按规则ID说明，不得只在JSON标待确认而在正文宣称已确认。
7. 原始用户表述只规定“返回错误”时，不擅自升级为特定HTTP码或错误文本；实现参数的位置、当前行为、故障注入均单列观察。按原文覆盖UI反馈、边界及异常要求，不能只看接口代码遗漏用户需求。
8. 只编写结构化台账，不独立编写或追加正式Markdown。模块用module、分类用category；背景/环境约束也登记为有来源的规则，待确认问题用pending的assumption记录并说明缺口，额外建议明确out_of_scope。保留原有kind/status权限约束，category不能改变规则效力。不默认最大值、不把校验trim推导为保存规范化。
9. 执行`node scripts/project-command.mjs run node generate-analysis-markdown.mjs -- <run_id>`从台账生成正式正文，再运行产物检查。所有假设、未决、风险和排除必须先入台账，不能只写在正文或最终口头结论。字段白名单、修订和来源边界见`docs/analysis-single-source.md`。
10. 生成器拒绝覆盖不同的已有正文。修订先走正式退回/恢复及专业派发，将旧正文和台账留存到本run审计目录后再生成，不删历史、不手改状态、不靠重生成绕过审批。

## 质量标准

- 结论必须可追溯到输入来源。
- 不明确的信息必须标记为“待确认”。
- 不允许凭空补充需求。

## 禁止事项

- 禁止把猜测写成事实。
- 禁止忽略非功能需求。
- 禁止删除待确认问题。
