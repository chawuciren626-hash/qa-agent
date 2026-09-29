# 测试设计阶段协作

测试设计由三个职责独立的专业 Agent 完成，并由 `test_agent` 总控协调。它们不能互相依赖聊天记忆，必须读取当前 `run_id` 下已经归档的交接产物。

```text
requirement_analysis_agent
  -> analysis/requirement_analysis.md
  -> test_point_agent
     -> design/test_points.md + design/test_points.xmind
  -> test_case_agent
     -> design/test_cases.json + design/test_cases.xlsx
```

每个阶段完成后由总控登记事件并等待人工确认。用户要求只做测试点或只做用例时，总控应按运行计划只启用所需阶段及其依赖，而不是自动进入执行阶段。

测试点和用例的结构、XMind/Excel 导出要求由相应 Skill 与 Schema 定义；总控只负责追溯、确认和调度。
