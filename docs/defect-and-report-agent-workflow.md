# 缺陷分析与测试报告 Agent 工作流

自动化执行完成后，总控按以下顺序调度：

output/test_results.json 和 output/playwright/
  -> defect_analysis_agent
  -> output/bugs.json、output/bugs.md
  -> test_report_agent
  -> output/test_report.md

缺陷分析 Agent 只处理真实失败和证据。测试报告 Agent 只汇总已执行的结果，并将未执行内容列为风险或未覆盖项。
