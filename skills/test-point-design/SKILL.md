---
name: test-point-design
description: 基于需求分析设计正常、异常和边界场景的测试点。
version: 1.1.0
---

# 测试点设计 Skill

## 适用场景

当需要基于需求分析结果生成测试覆盖地图时使用。

## 输入

- 用户提供的需求文字、文档、链接或页面资料
- 当前任务相关的需求分析结果与已知风险

## 输出

- 当前 `run_id` 的 `design/test_points.md`
- 当前 `run_id` 的 `design/test_points.json`，作为脑图和关联用例的结构化事实源。
- 当前 `run_id` 的 `design/test_points.xmind`

## 工作步骤

1. 按模块列出功能点。
2. 为每个功能点设计主流程测试点。
3. 补充异常流程、边界值、权限、安全、性能和兼容性测试点。
4. 为每个测试点标记风险等级。
5. 标记来源和待确认项。
6. 先输出符合 `schemas/test_point.schema.json` 的 JSON，再使用 `scripts/generate-test-points-xmind.mjs <test_points.json> <test_points.xmind>` 导出脑图。Markdown展示与JSON保持一致。旧Markdown导出仍可读，但新流程优先从JSON导出。

JSON支持数组或含`run_id`、`title`、`points`数组的对象。每项包含唯一`id`、`module`、`feature`、`description`、`risk`、`coverage_type`、`source`及非空唯一`rule_ids`。`source`必须是本run内真实来源文件路径（例如`analysis/requirement_analysis.md`），不要只写R1或外部URL；rule_ids引用`analysis/requirement-ledger.json`的范围内需求或假设。范围内未驳回需求不得漏覆盖，语义审查和台账格式见`docs/requirement-provenance.md`。

交付前运行`npm run artifacts:validate -- <run_id> test_points`。校验将脑图的模块、场景、描述与JSON逐项比较；失败应修复源数据并重新导出，不能删掉校验或伪造回执。完整契约见`docs/artifact-contracts.md`。

正式表格使用“编号、模块、场景（或功能）、描述、风险等级、覆盖类型、来源”等明确表头，每个测试点占一行。场景用于归组，描述写具体检查目标；同一模块、同一场景下的测试点会合并为同一脑图分支。

以本次已确认范围为边界。仅从实现观察或待确认问题推导的扩展，放到“扩展建议／待确认”文字列表，不写入正式 TP 表格或脑图，未经确认不计入必测覆盖。来源编号必须核对本次分析文档，不沿用旧项目编号。数据隔离不等于身份认证或权限控制；不要把实现阈值、故障注入行为当作已批准业务预期。

## XMind 结构规则

- 中心主题使用被测功能或产品名称，例如“登录功能”。
- 第一层是业务模块，例如“登录”“系统管理”“权限管理”，而不是测试分类或字段名。
- 第二层是业务场景，例如“登录成功”“登录失败与校验”。
- 第三层及以后是具体的测试点，例如“手机号为空提示”“验证码为空提示”。
- 不将“模块、描述、风险、覆盖类型”等元数据拆成脑图节点；这些信息保留在 Markdown 或结构化数据中。
- 脑图叶子节点不展示 `TP-...` 等测试点编号；编号保留在 Markdown、JSON 和 Excel 产物中用于追溯。

## 质量标准

- 高风险需求必须有测试点覆盖。
- 测试点描述要明确可理解。
- 每个测试点都应包含模块、功能、描述、风险和来源。

## 禁止事项

- 禁止只覆盖主流程。
- 禁止没有来源依据的测试点。
- 禁止把测试步骤写成测试点。
