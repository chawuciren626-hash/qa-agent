# 通用自动化执行框架

## 执行合同

每个自动化用例可在 `execution_contract` 中声明：

- `data_isolation`：`read_only`、`isolated` 或 `shared`。
- `setup`：执行前必须满足的通用准备条件。
- `assertion_mode`：动态反馈、页面状态、导航、接口响应或存储状态。
- `cleanup_required`：是否必须恢复测试数据。

未声明时采用保守默认值：`shared` 数据隔离、页面状态断言、要求清理。这会使执行器默认串行，防止未验证的数据共享造成污染。

## 执行流程

```powershell
npm run execution:plan -- --run-id=run-example --cases=output/runs/run-example/design/test_cases.json
npm run execution:plan:validate -- --run-id=run-example
npm run test:ui -- --run-id=run-example
```

执行计划是浏览器执行的唯一输入。执行器会依次检查：计划存在且有效、执行开关、环境配置、已安装的本地 Playwright、环境预检；任一项失败时写入 `blocked` 结果，绝不下载或安装依赖。

## 证据与结果

每次执行只保留 `execution/playwright/` 证据根目录。成功用例不保留视频；失败用例保留截图、Trace 和原始 Playwright 结果。归一化结果中的每条用例关联其执行合同和引用资产，以支持后续缺陷分析和报告。

## 测试脚本约定

可复用辅助函数位于 `tests/framework/execution-contract.ts`。生成脚本时：

- 每条测试标题必须包含稳定的 `case_id`。
- 使用 `runWithLifecycle` 明确准备、执行、断言和清理。
- 动态提示使用 `expectUpdatedTextAfterAction`，确保断言的是本次操作产生的反馈。
- 不得将实际账号、密码、验证码或 Token 写进测试脚本。
