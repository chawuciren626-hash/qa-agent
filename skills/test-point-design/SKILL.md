---
name: test-point-design
description: 基于需求分析设计正常、异常和边界场景的测试点。
metadata:
  version: '1.1.0'
---

# 测试点设计 Skill

## 分批保存

大批量测试点使用公共运行规则中的draft_records：inspect获取当前sha256；按id分批upsert，每批1至20条完整测试点。仅修改问题ID，其他内容保持不变；冲突先读取待改条目合并，不全量重写。复用inputs中的设计可seed初始化缺失草稿，仍按当前需求检查覆盖。批次成功只代表保存，全部完成后再按对应task/lifecycle契约诊断、导出和校验；不对每批增加人工确认。

## 独立任务（task）

直接从当前材料生成design/test_points.json，条目包含id、module、feature、description；rule_ids可选，不编造台账。用export_test_points导出XMind，不调用diagnose_test_points或要求analysis前置。

按派发的独立契约填写当前阶段*-task.json。草稿用diagnose_task，交付用validate_artifacts，由父总控handoff。source_paths保留实际依据，不生成虚假前序产物；questions不放技术检查、解锁或重复批准要求。任务与确认策略由公共运行指令统一规定，本Skill不新增节点。

## 生命周期模式（lifecycle）

以下流程、输入、Schema及规则台账/批次要求仅适用于lifecycle。task复用专业方法和展示样式，不执行本分支的前序检查或生命周期专用动作。

### 专业方法

复杂条件或状态流程按需读取已安装的test-design-methods Skill，用决策表或状态迁移检查遗漏；方法不替代当前追溯与导出契约。


### 草稿批量诊断与覆盖分类

写好JSON后先通过project-action调用diagnose_test_points（只需run_id），要求result.status=passed，不把外层completed当通过。集中处理全部errors及coverage.missing后才执行下述导出和正式校验；诊断不要求XMind存在、不生成文件、不批准、不重置预算。

必覆盖指范围内未驳回的行为需求及已确认假设。台账明确category=context/environment的规则只作背景/环境前提，不机械生成业务测试点，不放入预期rule_ids；来源仍保留在分析中。没有category的旧需求仍须覆盖。性能、安全、兼容性、运行环境的验收约束属于functional/constraint，不能用背景分类豁免。混合或矛盾分类交回需求角色，不自行改基线以通过校验。观察、范围外及驳回规则不可作为预期；未确认假设不计必测覆盖、不因诊断通过而自动获准执行。详见docs/test-point-diagnosis.md。

### 适用场景

当需要基于需求分析结果生成测试覆盖地图时使用。

### 输入

- 用户提供的需求文字、文档、链接或页面资料
- 当前任务相关的需求分析结果与已知风险

### 输出

- 可选的 `design/test_points.md` 阅读版；不作为交接前置条件，不为补阅读版重新派发。
- 当前 `run_id` 的 `design/test_points.json`，作为脑图和关联用例的结构化事实源。
- 当前 `run_id` 的 `design/test_points.xmind`

### 工作步骤

1. 按模块列出功能点。
2. 为每个功能点设计主流程测试点。
3. 补充异常流程、边界值、权限、安全、性能和兼容性测试点。
4. 为每个测试点标记风险等级。
5. 标记来源和待确认项。
6. 先输出符合 `schemas/test_point.schema.json` 的 JSON，再通过project-action调用export_test_points（只需run_id）导出脑图，随后validate_artifacts（stage=test_points）。入口自动归档本次输入和旧导出文件；失败仅在recovery.retry_allowed=true时修正未确认草稿再调用，不直接运行底层导出脚本。Markdown展示与JSON保持一致，业务歧义交总控确认，不为让导出通过而更改预期。详见docs/draft-artifact-recovery.md。

JSON支持数组或含`run_id`、`title`、`points`数组的对象。每项包含唯一`id`、`module`、`feature`、`description`、`risk`、`coverage_type`、`source`及非空唯一`rule_ids`。`source`必须是本run内真实来源文件路径（例如`analysis/requirement_analysis.md`），不要只写R1或外部URL；rule_ids引用`analysis/requirement-ledger.json`的范围内行为需求或假设。按上面的分类规则检查覆盖，语义审查和台账格式见`docs/requirement-provenance.md`。

在 PenguinHarness 派发中，交付前通过 project-action 的 `validate_artifacts`（stage=test_points）校验，不运行临时 `node -e` 或工作区内的直接脚本。校验将脑图的模块、场景、描述与JSON逐项比较；失败应修复源数据并重新导出，不能删掉校验或伪造回执。完整契约见`docs/artifact-contracts.md`。

正式表格使用“编号、模块、场景（或功能）、描述、风险等级、覆盖类型、来源”等明确表头，每个测试点占一行。场景用于归组，描述写具体检查目标；同一模块、同一场景下的测试点会合并为同一脑图分支。

以本次已确认范围为边界。仅从实现观察或待确认问题推导的扩展，放到“扩展建议／待确认”文字列表，不写入正式 TP 表格或脑图，未经确认不计入必测覆盖。来源编号必须核对本次分析文档，不沿用旧项目编号。数据隔离不等于身份认证或权限控制；不要把实现阈值、故障注入行为当作已批准业务预期。

### XMind 结构规则

- 中心主题使用被测功能或产品名称，例如“登录功能”。
- 第一层是业务模块，例如“登录”“系统管理”“权限管理”，而不是测试分类或字段名。
- 第二层是业务场景，例如“登录成功”“登录失败与校验”。
- 第三层及以后是具体的测试点，例如“手机号为空提示”“验证码为空提示”。
- 不将“模块、描述、风险、覆盖类型”等元数据拆成脑图节点；这些信息保留在 Markdown 或结构化数据中。
- 脑图叶子节点不展示 `TP-...` 等测试点编号；编号保留在 Markdown、JSON 和 Excel 产物中用于追溯。

### 质量标准

- 高风险需求必须有测试点覆盖。
- 测试点描述要明确可理解。
- 每个测试点都应包含模块、功能、描述、风险和来源。

### 禁止事项

- 禁止只覆盖主流程。
- 禁止没有来源依据的测试点。
- 禁止把测试步骤写成测试点。
