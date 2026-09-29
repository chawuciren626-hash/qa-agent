# 智能测试选择与执行效率

## 用例元数据

结构化用例可通过 `execution_metadata` 提供：模块、标签、风险、执行成本、数据影响、环境依赖、自动化成熟度及预估耗时。这些字段服务于选择与调度，不等同于业务功能字段。

## 选择 Profile

策略定义在 `config/test-selection-policy.json`：

- `smoke`：高优先级或高风险核心检查。
- `core_regression`：P0/P1 核心回归。
- `regression`：常规回归。
- `full`：全量测试，不做预算裁剪。
- `targeted`：依据变更模块或标签选择影响范围。

执行示例：

```powershell
npm run selection:cases -- --run-id=run-example --cases=output/runs/run-example/design/test_cases.json --profile=smoke
npm run execution:plan -- --run-id=run-example --cases=output/runs/run-example/design/test_cases.json --selection=output/runs/run-example/selection/test-selection.json
```

选择输出保留每条用例的入选或排除原因、预估时长、评分和预算结果。执行计划只允许使用该输出列出的用例。

## 效率与安全

数据影响为 `shared` 的用例默认串行；`read_only` 与 `isolated` 用例才可使用环境允许的并发数。专项长耗时测试应以成本和预算标记管理，而不是针对某个页面或某条用例写死排除逻辑。
