---
name: test-selection
description: 按风险、优先级、变更范围、执行成本、数据影响和预算选择测试集。
metadata:
  version: '1.1.0'
  source: fugazi/test-automation-skills-agents
  revision: 65a72d5e74def3c23143bef8757e72cb68e91032
  adapted-from: playwright-regression-testing
---

# 智能测试选择 Skill

## 专业方法

回归策略复核时按需读取[回归选择与不稳定用例治理](references/regression-strategy.md)。当前选择器未消费的历史信号只作建议，不声称已自动排序。


使用 `config/test-selection-policy.json` 中的 Profile 选择测试集。支持 `smoke`、`core_regression`、`regression`、`full` 和 `targeted`；Profile 是通用规则，业务模块和标签从结构化用例元数据读取。

用例应包含 `execution_metadata`：模块、标签、风险等级、执行成本、数据影响、环境依赖、自动化成熟度和预估耗时。缺失时按保守默认值处理。

```powershell
npm run selection:cases -- --run-id=run-example --cases=output/runs/run-example/design/test_cases.json --profile=targeted --changed-modules=module-a
```

输出为 `selection/test-selection.json`，必须展示入选原因、排除原因、预估耗时和预算影响。将该结果作为 `execution:plan -- --selection=...` 的输入；不可跳过选择结果后自行扩大浏览器执行范围。
