---
name: test-case-writing
description: 根据测试点生成符合项目 JSON Schema 的结构化测试用例。
version: 1.1.0
---

# 测试用例编写 Skill

## 统一产物交付契约

交付前运行`npm run artifacts:validate -- <run_id> test_cases`，详见`docs/artifact-contracts.md`。每条用例必须符合Schema，包含`design_contract`及真实存在于本run测试点JSON中的`related_test_point`。JSON支持数组或cases/test_cases封装，Excel使用现有导出器生成，不能独立修改表格导致与JSON不一致。待确认规则可作为草稿保留，但不得进入执行计划。

## 适用场景

当需要把测试点转换成可执行测试用例时使用。

## 输入

- 当前任务相关的测试点、需求分析和用户资料
- `schemas/test_case.schema.json`
- 可选：测试环境、测试账号、接口文档

## 输出

- 当前 `run_id` 的 `design/test_cases.json`
- 当前 `run_id` 的 `design/test_cases.xlsx`

## 工作步骤

1. 读取测试点。
2. 为每个高优先级测试点设计至少一条用例。
3. 编写前置条件、测试数据、步骤和预期结果。
4. 标记优先级和测试类型。
5. 判断是否适合自动化。
6. 补充 `execution_metadata`：模块、标签、风险等级、执行成本、数据影响、环境依赖、自动化成熟度和预估耗时。没有可靠依据时使用保守值或标记待确认。
7. 为可自动化用例补充 `execution_contract`：数据隔离、准备、断言方式和清理要求。
8. 调用 `scripts/generate-test-cases-xlsx.mjs` 导出 Excel 评审与执行版本。
9. 不得为了导出 Excel 临时安装 npm、Python 或 Office 依赖；缺少本地工具时保留 JSON 并报告环境未就绪。
10. 每条用例补充 `design_contract`：`basis`记录rule_id、来源文件、具体规则及confirmed/pending/conflicted，必须与需求台账一致，rule_id包含在关联测试点rule_ids中；`assumptions`显式列出假设，已确认假设必须引用台账rule_id和真实user_confirmation来源；`data_checks`声明所有适用的长度与金额计算。结构见 `docs/design-quality-gate.md`和`docs/requirement-provenance.md`，不得只写“已校验”。每个测试点至少有对应用例，不以实现观察替代业务预期。
11. 交付前运行 `npm run design:validate -- --run-id=<run_id> --draft`。草稿可保留明确标记的未决规则，但校验失败的数据需修正；报告路径为 `quality/design-validation.json`。进入执行计划前去掉 `--draft` 再验证；未决规则不能因 `automation_feasible=true` 而绕过限制。

## 质量标准

- 用例步骤可执行。
- 预期结果可验证。
- 字段符合 `schemas/test_case.schema.json`。
- 用例可以追溯到测试点。

## 交付前自检

- 路由、请求方法和页面可操作元素应来自当前环境资料或只读观察，不猜测接口，不用实现行为替换业务预期。
- 边界数据必须计算核对实际长度或数值；描述为40字符的数据必须确实是40字符。缺失字段、空字符串和null应作为独立数据变体，不在步骤中含糊写“或”。
- UI与API步骤需可实际执行：数字框不能假定可输入任意文本，页面不存在的行不能假定有可点击按钮。使用API时记录方法、路径、请求体与回查方式。
- 隔离测试必须设置能够揭露串扰的对照数据，并回查目标与对照；不得让对照原本就是重置状态而掩盖误清理。
- 新生成且未经过实际回归的用例标为candidate，不标stable；预估时长不冒充实测耗时。
- 测试数据使用运行级唯一标识，明确finally清理，包括预期拒绝但可能因缺陷成功写入的用例。
- 逐项核对测试点覆盖，并读取导出的Excel校对行数和关键字段。JSON可解析和Schema通过不代表语义或执行可行性合格。
- 覆盖必须匹配检查层级：页面展示、状态提示、交互反馈不能仅用API响应替代。关联到同一测试点编号不代表其全部验收目标已覆盖；必要时分为UI和API用例，明确各自边界。

## 禁止事项

- 禁止使用“检查是否正常”等模糊预期。
- 禁止把多个无关目标塞进一条用例。
- 禁止输出不可解析的 JSON。
- 禁止为了通过校验伪造确认记录、将pending直接改为confirmed、漏填适用的数据检查或把建议写成已确认需求。来源存在不代表语义正确，总控仍须复核。
