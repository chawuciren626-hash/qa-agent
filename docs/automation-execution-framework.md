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

执行计划是浏览器执行的唯一输入。准备脚本和计划后必须经过执行审批，上面的test:ui命令不是免审批入口。执行器依次检查：独占锁、计划与设计、批准快照、执行开关、环境配置、已安装的本地Playwright、环境预检；任一项失败时保存本批次blocked记录，绝不下载或安装依赖。计划含整批及预检超时，不自动重试业务操作。

## 证据与结果

新执行使用`execution/attempts/<invocation_id>/playwright/`独立证据根目录，不覆盖上轮原始结果。成功用例不保留视频；失败保留截图、Trace和原始结果。归一化结果关联执行合同、引用资产与批次；兼容路径execution/test_results.json不是历史数据库，必须结合execution-state判断是否可用。详见[执行批次与恢复](execution-attempts.md)。旧execution/playwright保留只读。

## 测试脚本约定

可复用辅助函数位于 `tests/framework/execution-contract.ts`。生成脚本时：

- 每条测试标题必须包含稳定的 `case_id`。
- 使用 `runWithLifecycle` 明确准备、执行、断言和清理。
- 动态提示使用 `expectUpdatedTextAfterAction`，确保断言的是本次操作产生的反馈。
- 不得将实际账号、密码、验证码或 Token 写进测试脚本。
