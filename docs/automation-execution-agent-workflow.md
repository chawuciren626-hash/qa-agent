# 自动化执行 Agent 工作流

`automation_execution_agent` 只负责观察页面、生成或维护自动化脚本、创建执行计划并在获得授权后运行。它不是默认触发的流水线步骤。

## 前置条件

1. 当前 `run_id` 已有已确认的测试用例阶段。
2. 总控已生成 `selection/test-selection.json` 与 `execution/execution-plan.json`。
3. 用户已确认目标环境、用例范围、可能的数据影响和执行授权。
4. `config/test-environments.json` 中存在对应环境，且环境预检通过。
5. 本地 Playwright 和浏览器已可用。缺项时写入 `blocked`，不下载安装。

## 数据流

```text
design/test_cases.json
  -> selection/test-selection.json
  -> execution/execution-plan.json
  -> environment/preflight.json
  -> 本地 Playwright
  -> execution/playwright/
  -> execution/test_results.json
  -> quality/evidence-assessment.json
```

失败用例应保存截图、trace、日志或其他可访问证据。执行完成后由总控派发 `defect_analysis_agent`；执行 Agent 不得把失败自行写成产品缺陷。

## 命令

```powershell
npm run selection:cases -- --run-id=run-example --cases=output/runs/run-example/design/test_cases.json --profile=smoke
npm run execution:plan -- --run-id=run-example --cases=output/runs/run-example/design/test_cases.json --selection=output/runs/run-example/selection/test-selection.json
npm run execution:plan:validate -- --run-id=run-example
npm run test:ui -- --run-id=run-example
```

具体执行合同、数据隔离和证据规则参见 [自动化执行框架](automation-execution-framework.md)。
