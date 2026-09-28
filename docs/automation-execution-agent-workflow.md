# 自动化执行 Agent 工作流

test_agent 在测试用例完成后调度 automation_execution_agent：

output/test_cases.json
  -> tests/generated/*.spec.ts
  -> npm run test:ui
  -> output/playwright/（原始报告和证据）
  -> output/test_results.json

执行开关位于 config/test-env.json 的 execution.enabled。默认是 false，因此命令会生成 blocked 结果，不会访问网站。

填写专用非生产测试环境 URL 和账号、确认页面定位器后，将开关改为 true。然后由总控调度自动化执行 Agent 执行已确认的 P0/P1 用例。
