# 三 Agent 测试设计工作流

```text
test_agent（总控）
  -> requirement_analysis_agent
     输出 output/requirement_analysis.md
  -> test_point_agent
     读取需求分析，输出 output/test_points.md
  -> test_case_agent
     读取测试点和 Schema，输出 output/test_cases.json
```

总控 Agent 负责派发、等待与检查交接产物。三个专业 Agent 分别只负责一个阶段，可以独立复跑。

在 PenguinHarness 选择“软件测试智能体”，工作区选择 `E:\Codex\测试智能体`，输入：

```text
读取 inputs/requirements.md，依次调度需求分析智能体、测试点设计智能体和测试用例智能体。每个阶段完成后检查交接文件，最后校验 output/test_cases.json 可解析。不要执行自动化测试。
```
