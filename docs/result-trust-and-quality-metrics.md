# 结果可信度与质量度量

本能力用于让测试智能体的结论可核验、可追溯、可比较，而非让模型根据少量失败文本直接判断产品质量。

## 数据流

`execution/test_results.json` 是执行结果的标准输入。失败项携带错误信息、失败分类和证据引用；随后形成以下不可替代的中间事实：

1. `quality/evidence-assessment.json`：验证失败项是否有可访问的证据，并计算低、中、强证据可信度。
2. `defects/defect-records.json`：将缺陷草稿规范为带指纹、生命周期和证据引用的记录。
3. `output/quality/defect-index.json`：按 scope_id 和指纹聚合重复候选，默认 scope 为 run_id；不自动跨业务合并。
4. `report/quality-metrics.json`：汇总设计、选择、执行、可信度、缺陷与质量门。
5. `output/quality/quality-trends.json`：按运行时间保留通过率、失败数、缺陷数和质量门的趋势点。

## 使用原则

- 治理状态以 `defects/lifecycle.json` 重放结果为准，不能直接把原始观察改为已关闭。修复声明必须经过独立、同设计和环境依据的复测验证；历史未解决问题继续影响质量门。详见[质量治理闭环](quality-governance-lifecycle.md)。
- 台账或依据变化会使旧报告不再有效；重新生成度量和报告并通过阶段契约后再发布。趋势排除台账或执行状态过期的指标，输出跳过原因，不能用旧通过率替代当前状态。
- 证据引用必须真实存在。没有错误信息或足够证据的失败不能提升为确认的产品结论。
- `needs_review` 表示还不能排除产品、脚本、环境或数据因素，报告必须显式保留此状态。
- 指纹用于发现相同问题在同次或不同次运行中的重复出现；它不自动合并或关闭任何外部缺陷。
- 质量门是发布决策的输入，不替代人工发布审批。指标只覆盖本次已选择且已执行的测试范围。
- 所有脚本只读取和整理既有结果，不下载依赖、不启动浏览器、不修改被测系统。

## 命令

```powershell
npm run quality:evidence -- --run-id=<run_id>
npm run quality:defects -- --run-id=<run_id>
npm run quality:defect-index
npm run quality:metrics -- --run-id=<run_id>
npm run quality:trends
```

每次使用应由总控智能体根据当前运行计划进行调度。普通用户不需要手工维护这些 JSON 文件。
