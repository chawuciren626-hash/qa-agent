---
name: test-asset-management
description: 管理可复用测试规则、测试数据策略、定位器、断言、接口契约和缺陷模式。
version: 1.0.0
---

# 测试资产管理 Skill

## 资产目录

使用 `config/test-assets.json` 作为唯一资产目录。每个资产必须具有稳定 ID、类型、适用范围、来源、版本、状态、标签和数据内容。

支持类型：`requirement_rule`、`test_data_profile`、`ui_locator_bundle`、`assertion_bundle`、`api_contract`、`defect_pattern`。

## 生命周期

1. 新发现资产先作为 `candidate` 写入当前运行目录的候选文件。
2. 通过页面观察、接口契约或人工评审后，补齐 `validation` 并标为 `verified`。
3. 只有经人工确认的 `verified` 候选资产，才可用 `register-test-asset.mjs --apply` 登记到全局目录。
4. 被替代或不再适用的资产标记为 `deprecated`，不得删除历史记录。

## 使用规则

- 按环境、模块、标签和资产类型查询，优先使用 `verified` 资产。
- 不把密码、验证码、Token、API Key 或真实账号写入目录；仅保存环境配置引用、生成策略和脱敏约束。
- 资产在运行中使用前，应记录其 ID 与版本到运行清单或产物元数据。
- 未验证资产只能辅助探索，不能作为自动化通过结论的唯一依据。
