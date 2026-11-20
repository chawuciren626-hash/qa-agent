# 测试 Agent 调研与 AITestHarness 自动化建设方案

日期：2026-11-20。工程对照基线：`main`（`92ff62d`）。本文是调研和建设建议，未实施的能力以验收结果为准。

## 厂商公开做法

重点比较模型在生成、执行和维护中的职责。公开产品、开源项目和团队案例只代表对应资料的范围，不能据此推断厂商内部统一采用该方案。

| 厂商与公开资料 | 形式与技术 | 对 AITestHarness 的参考 |
| --- | --- | --- |
| 微软：[Playwright Test Agents](https://playwright.dev/docs/test-agents) | Planner 探索并产出测试计划；Generator 将计划写成 Playwright 测试；Healer 复现失败、提出修改并重跑。脚本由 Playwright Test 执行。 | 以计划、脚本和运行证据为交付物。日常回归直接执行脚本，把排查和修复留给失败分支。 |
| Google：[Android Studio Journeys](https://developer.android.com/studio/gemini/journeys)、[Firebase App Testing Agent](https://firebase.google.com/docs/app-distribution/android/app-testing-agent) | 自然语言描述移动端步骤与预期，模型观察设备状态并执行。Firebase 按设备缓存成功动作并在后续运行重放；动作复用与断言是否仍调用模型应分别看待。 | 首次动态探索和后续重跑可以分开计量；如断言仍使用模型，应在结果中可见。 |
| 字节跳动公开生态：[UI-TARS](https://github.com/bytedance/UI-TARS)、[Midscene.js](https://midscenejs.com/) | UI-TARS 展示截图驱动的 GUI 操作；Midscene 提供自然语言测试接口，以及规划与定位结果的缓存机制。 | 截图可补充界面上下文；缓存降低定位成本，但业务结果仍需重新断言。 |
| 美团：[KuiTest](https://tech.meituan.com/2026/01/13/KuiTest-UI.html) 及[外卖 AlphaTest 案例](https://tech.meituan.com/2022/09/15/Automated-Testing-in-meituan.html) | KuiTest 面向移动端 UI 巡检，通过截图和组件信息理解交互；AlphaTest 案例侧重录制流程、校验网络和埋点，并在代码或打包流程中触发回归。 | 巡检覆盖未知状态，固定回归保护已知业务路径，两类任务应有不同的通过标准。 |
| 阿里云：[云效 AI 助手](https://help.aliyun.com/zh/yunxiao/getting-started/cloudeffect-ai-assistant-user-guide) | 从需求入口串联用例、测试和缺陷。公开材料未说明每一步是否由模型执行，或如何复用脚本。 | 参考需求到测试交付的产品入口；不据此选型执行架构。 |
| 华为云：[CodeArts TestPlan](https://support.huaweicloud.com/productdesc-testman/devcloud_pdtd_50001.html) | 接口测试通过请求编排、参数提取和检查点定义场景，再由执行机和流水线运行。 | API 回归优先把请求和断言交给现有执行器，模型用于整理契约、生成草稿和分析异常。 |
| 腾讯：[WeTest UDT](https://www.wetest.net/products/automation-testing)；AWS：[Device Farm](https://docs.aws.amazon.com/devicefarm/latest/developerguide/welcome.html) | 以设备环境、测试框架接入、调度和取证为主。 | 移动端可沿用计划和回执契约，按平台替换执行器。 |
| BrowserStack：[Playwright AI Agents](https://www.browserstack.com/docs/automate/playwright/browserstack-ai-agents) | 在既有测试流水线中处理定位失败和失败分析。 | 定位修复与业务断言分开，记录修复证据和重跑结果。 |

## 现有工程与缺口

| 环节 | 已有能力 | 需要补齐 |
| --- | --- | --- |
| 建档与探索 | [项目探索服务](../platform/packages/server/src/services/project-exploration-service.ts)把探索观察同步到项目知识层，[地图构建脚本](../scripts/merge-explore-maps.py)产生结构化地图。 | 给用户一个从探索记录生成测试计划草稿的入口，并保留地图版本、来源和待确认项。 |
| 设计与执行准备 | [`prepare_execution_plan`](../scripts/structured-actions.mjs)以 `design/test_cases.json` 为输入，选出本次执行的用例，生成[运行级执行计划](../scripts/create-execution-plan.mjs)，并尝试复用脚本。 | 明确项目级测试计划如何生成、审阅和下发给现有用例与执行准备流程。运行级执行计划只解决本次跑什么。 |
| Web 脚本和运行 | [脚本库](../scripts/web-script-library.mjs)已有验证后的归档与复用入口；[执行器](../scripts/execution-runner.mjs)负责受控运行。[浏览器生命周期路径](../skills/playwright-execution/SKILL.md)也能按 `browser-case-plan.json` 由 Agent 逐步调用工具。 | 将脚本准备和首次验证接到项目计划上，再验证新会话能固定引用已发布脚本。浏览器任务的计划与回执不能直接代替项目回归资产。 |

## 建议流程

**项目知识地图 + 测试目标 → 测试计划草稿 → 已确认用例 → 脚本准备和首次试跑 → 已验证脚本 → 宿主回归与新证据。**

1. **规划。** 建档后让用户选择从已观察到的主流程生成冒烟计划草稿；有明确需求时，再生成变更专项计划。输入支持口述、文档和需求链接；环境地址可在规划时缺省，有可用环境后才进入执行。计划至少包含范围、用例 ID、前置条件、数据引用、步骤、预期及来源、清理规则、待确认项。探索记录只能证明观察到的事实；没有来源的业务预期保留为待确认，不能据此生成通过结论。
2. **生成与发布。** 复用现有用例导出、执行选集、脚本准备和校验。若已有匹配的已验证脚本，直接复用；只为剩余用例生成候选脚本。候选 Playwright 脚本显式关联用例 ID、定位器和断言，经授权测试环境试跑后再归档。保留用例与脚本的版本关联；环境和凭据通过执行配置引用，避免把实际账号或令牌写入脚本。
3. **宿主执行。** 新会话选择已验证脚本，固定版本，使用已配置的本机宿主环境执行并产生新回执。记录用例结论、耗时、模型调用数和失败证据；动作成功与业务断言通过分别记录。授权范围内的测试数据清理只作用于本次创建的记录；提交结果未知时先核实状态，不能盲目重放。
4. **按失败类型处理。** 定位器变化可以提出候选修复，保留变更记录并重跑原断言；业务断言失败按失败报出；环境或身份验证未完成则阻塞或续接，保留未执行范围。先复用现有角色和工具，分工由产物和流程决定。

## 分批建设与验收

| 批次 | 交付 | 验收条件 |
| --- | --- | --- |
| 第一批：项目计划 | 探索记录生成可审阅的项目冒烟计划；能从已确认用例进入现有执行准备。 | 用一个业务流程展示从地图观察、需求依据到用例和断言的完整引用；缺少业务预期时明确待确认。 |
| 第二批：Web 脚本闭环 | 生成候选 Playwright 脚本，受控试跑，通过后进入项目脚本库；新会话从脚本库启动回归。 | 用「新增测试用户 → 列表验证 → 清理本次创建的数据」覆盖首次生成与第二次运行。第二次使用相同脚本版本、产生新运行证据，正常路径没有模型逐步操作。 |
| 第三批：失败与扩展 | 验证定位修复和真实业务失败分类，再扩到 API 和移动端执行器。 | 分别注入定位变化与业务预期不成立两种情况；修复前后保留原断言，业务失败如实报出。API 和移动端复用计划、用例和回执约定。 |

验收报告同时记录首次生成成本与日常回归成本：模型调用次数、执行耗时、实际执行与未执行用例数、证据完整率、失败类型。执行器无模型运行是固定回归正常路径的验收目标；首次探索、生成和异常处理单独统计。
