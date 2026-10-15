---
name: api-testing
description: 依据接口契约设计和编写Playwright API测试，覆盖认证权限、错误响应、分页、Schema与幂等副作用；适用于接口专项或UI数据准备，不将API成功当作UI验收通过。
license: MIT; see LICENSE.txt
metadata:
  version: '1.0.0'
  source: fugazi/test-automation-skills-agents
  revision: 65a72d5e74def3c23143bef8757e72cb68e91032
  adapted-from: api-testing
---

# API 测试

复用工程已有@playwright/test的request能力，不引入Java、Supertest或额外依赖。当前Skill是专业设计与脚本能力，不新增独立HTTP执行工具。

## 工作方式

1. 读取本次接口文档、有效需求、角色权限和环境资料。方法、路径、状态码、Schema均需有来源；实现观察不能自动成为业务预期。
2. 按[接口场景检查](references/api-scenarios.md)选相关正向、负向和状态验证；只覆盖授权范围，不为了通用清单新增限流压测、安全攻击或破坏性操作。
3. 用例沿用本阶段主Skill的JSON/Excel格式。lifecycle保留design_contract与rule_id，execution_contract用api_response及真实data_isolation；task设计按独立任务契约输出，不补造前序台账。
4. 脚本使用已有Playwright request fixture，以case_id进入测试标题，证据通过testInfo.attach/outputPath进入当前批次。实现细节见[断言与执行适配](references/assertions-and-runtime.md)。
5. lifecycle模式仍经现有prepare→计划校验→有效执行授权→受控执行入口；prepare不能请求真实接口。失败交付真实结果，不能自动重试写请求或自行更改批准脚本。

## 独立任务边界

现有task的browser_task提供浏览器交互，没有通用HTTP请求动作。独立API任务可以设计用例、分析已有响应或准备明确标为未执行的脚本；不能伪造browser_task操作或偷偷调用curl/npx绕开入口。用户只要求API实测且当前模式没有支持入口时，明确说明实际能力缺口，不擅自改为全流程、不索取无关前置产物、不宣称已测。

## 判定底线

- 按契约分别处理JSON、文本、二进制、HEAD和204；不对空响应盲目json()。
- 幂等检查最终资源状态及副作用，不能仅比较两次响应体/状态码完全相同。
- 凭据来自本次授权环境，日志与证据脱敏。每条写用例独立数据，包含意外写入后的清理策略。
- API断言不能代替UI反馈、焦点或页面展示验收；mock通过不能描述为真实后端通过。
