---
name: api-testing
description: 依据接口契约设计和编写Playwright API测试，覆盖认证权限、错误响应、分页、Schema与幂等副作用；适用于接口专项或UI数据准备，不将API成功当作UI验收通过。
license: MIT; see LICENSE.txt
metadata:
  version: '1.1.0'
  source: fugazi/test-automation-skills-agents
  revision: 65a72d5e74def3c23143bef8757e72cb68e91032
  adapted-from: api-testing
---

# API 测试

复用工程已有Playwright，不引入Java、Supertest或额外依赖。生命周期脚本沿用request能力；独立任务可在已启动的浏览器会话内使用受控api_check核验同源GET/HEAD，不是通用写接口客户端。

## 工作方式

1. 读取本次接口文档、有效需求、角色权限和环境资料。方法、路径、状态码、Schema均需有来源；实现观察不能自动成为业务预期。
2. 按[接口场景检查](references/api-scenarios.md)选相关正向、负向和状态验证；只覆盖授权范围，不为了通用清单新增限流压测、安全攻击或破坏性操作。
3. 用例沿用本阶段主Skill的JSON/Excel格式。lifecycle保留design_contract与rule_id，execution_contract用api_response及真实data_isolation；task设计按独立任务契约输出，不补造前序台账。
4. 脚本使用已有Playwright request fixture，以case_id进入测试标题，证据通过testInfo.attach/outputPath进入当前批次。实现细节见[断言与执行适配](references/assertions-and-runtime.md)。
5. lifecycle模式仍经现有prepare→计划校验→有效执行授权→受控执行入口；prepare不能请求真实接口。失败交付真实结果，不能自动重试写请求或自行更改批准脚本。

## 独立任务边界

已启动browser_task后，可按catalog.field_rules.api_controls调用type=api_check。只核验用户当前范围内明确允许读取、已提供或已观察的同源GET/HEAD端点；使用当前浏览器会话认证，不索取环境JSON，不猜路径、不提供任意请求头、查询串、请求体或重定向选项。字段/状态预期必须有当前资料；状态成功不替代业务码或数据库验证。GET也可能有副作用，已知会删除/发送/改变业务状态的GET不能作为只读测试调用。结果未知不自动重试，保持request_id读取回执。

仅当前用户明确要求异常模拟时，可给click/press附一次性fault和UI断言，精确匹配一个同源GET，abort或模拟500/502/503/504，不注入写请求、不改请求体、不自动探测其他端点。URL探索或“测试一下”本身不扩展为故障注入授权；必要风险问题才问用户，不新增技术审批文件。工具自动撤销注入，未命中或未确认注入则未验证；禁止重放业务动作追求命中。模拟影响与真实故障分开记录，撤销不代表页面/业务恢复；重新导航后再进行需要真实环境的UI验证。

独立跨域、带查询参数、任意鉴权头、写接口和纯服务端无浏览器入口仍不支持；说明具体缺口，可设计或分析材料，不偷偷调用curl/npx，不擅自改为全流程，不宣称已测。不能用准备脚本冒充实测。

## 判定底线

- 按契约分别处理JSON、文本、二进制、HEAD和204；不对空响应盲目json()。
- 幂等检查最终资源状态及副作用，不能仅比较两次响应体/状态码完全相同。
- 凭据来自本次授权环境，日志与证据脱敏。每条写用例独立数据，包含意外写入后的清理策略。
- API断言不能代替UI反馈、焦点或页面展示验收；mock通过不能描述为真实后端通过。
