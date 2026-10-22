---
name: api-contract-analysis
description: 解析当前任务的 OpenAPI/Swagger 或文字接口契约，形成有来源的接口清单及业务规则，供接口测试点和用例设计使用。
---

# 接口契约分析

当前工具 api_task.inspect_contract 读取已归档 JSON/YAML，支持 Swagger 2.0/OpenAPI 3.0。可传 operations 数组按 method+path 选择接口，返回 source_sha256、参数、请求体、响应、security 和限制。不会请求业务接口或跟随外部 $ref。完整用法见共享 skills/api-test-execution/references/protocol.md。

将解析结果与原文规则写入 analysis/api_contract.json，并沿用现有需求台账与分析文档；保留来源和未支持项。Word 使用已有 extract_word。文字只能形成有来源的设计，不能猜测路径扫描服务。3.1、循环和外部引用明确列为限制，不伪称完整 Schema 校验。文档中示例响应不是已确认业务预期，实测响应也不能回写预期。

按用户选择的 operation 分批设计正向、负向、边界、认证和依赖场景。仅缺少影响结果的真实业务信息时询问；解析、设计不需要逐节点技术审批。
