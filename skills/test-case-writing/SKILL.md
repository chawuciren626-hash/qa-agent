---
name: test-case-writing
description: 根据测试点生成符合项目 JSON Schema 的结构化测试用例。
version: 1.0.0
---

# 测试用例编写 Skill

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

## 质量标准

- 用例步骤可执行。
- 预期结果可验证。
- 字段符合 `schemas/test_case.schema.json`。
- 用例可以追溯到测试点。

## 禁止事项

- 禁止使用“检查是否正常”等模糊预期。
- 禁止把多个无关目标塞进一条用例。
- 禁止输出不可解析的 JSON。
