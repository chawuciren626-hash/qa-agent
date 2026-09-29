# 测试资产管理中心

## 目标

测试资产是可复用、可验证、可追溯的测试知识，而不是某次任务临时生成的脚本或真实凭据。目录支持跨项目的需求规则、测试数据策略、UI 定位器、断言规则、接口契约和缺陷模式。

## 目录与类型

主目录为 `config/test-assets.json`，结构由 `schemas/test_asset.schema.json` 定义。

- `requirement_rule`：可验证业务规则或约束。
- `test_data_profile`：数据分类、生成策略、隔离与清理策略。
- `ui_locator_bundle`：经过验证的页面定位器。
- `assertion_bundle`：可复用断言规则。
- `api_contract`：接口请求、响应与契约引用。
- `defect_pattern`：可复用问题模式和回归建议。

每个资产必须有 `candidate`、`verified` 或 `deprecated` 状态。只有 `verified` 资产可以进入正式自动化执行。

## 常用命令

```powershell
npm run assets:validate
npm run assets:find -- --kind=ui_locator_bundle --environment=example --status=verified
node scripts/record-run-assets.mjs --run-id=run-example --assets=example-login-ui-v1
node scripts/register-test-asset.mjs --candidate=output/runs/run-example/assets/candidate.json
```

最后一条命令默认只预览。只有评审确认后才追加 `--apply` 写入资产目录。

## 治理规则

- 不保存真实账号、密码、验证码、Token 或 API Key；这些仅能存在于已忽略的环境配置中。
- 新资产先写入当前运行的候选文件，注明来源、适用环境与验证证据。
- 运行引用资产时必须登记 ID 和版本，确保历史结果可复现和可解释。
- 资产版本升级后保留旧版本；不再适用时标记 `deprecated`，不删除历史资产。
