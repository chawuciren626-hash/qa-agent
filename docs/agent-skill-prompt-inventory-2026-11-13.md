# AITestHarness Agent / Skill / 提示词清单

- 生成日期：2026-11-13
- 数据口径：源码当前定义，而非安装版运行缓存
- Agent 总数：11 个；其中 `agents.json` 登记 10 个专业编排角色，`default_agent` 是 fallback 默认入口
- Skill 总数：15 个；当前绑定到 Agent 的 Skill 13 个，另有 `test-asset-management`、`test-selection` 未绑定
- 主要来源：
  - `penguin/agents.json`
  - `penguin/command-runtime.md`
  - `penguin/agents/<agent_id>/AGENTS.md`
  - `skills/<skill_name>/SKILL.md`

## 1. Agent 总览

| # | Agent ID | 提示词中的名称 | 核心职责 | 当前绑定 Skill | 提示词文件 |
|---|---|---|---|---|---|
| 1 | `default_agent` | `general_agent` / 默认角色测试任务入口 | 通用问答和默认入口；不承担专业测试编排，遇到测试需求时引导切换到 `test_agent` | 无 | `penguin/agents/default_agent/AGENTS.md` |
| 2 | `test_agent` | 软件测试总控智能体 | 理解用户目标、归档资料、按功能/接口分流、派发专业 Agent、核验真实结果、组织交付 | 无；有 11 个 retired skills | `penguin/agents/test_agent/AGENTS.md` |
| 3 | `requirement_analysis_agent` | 需求分析智能体 | 将文字、文档、页面信息和已有资产分析为可测试需求基线 | `requirement-analysis`, `test-design-methods`, `api-contract-analysis` | `penguin/agents/requirement_analysis_agent/AGENTS.md` |
| 4 | `test_point_agent` | 测试点智能体 | 基于需求基线、用户材料和风险设计可追溯测试点 | `test-point-design`, `test-design-methods`, `api-testing` | `penguin/agents/test_point_agent/AGENTS.md` |
| 5 | `test_case_agent` | 测试用例智能体 | 基于当前材料设计、诊断并交付结构化测试用例 | `test-case-writing`, `test-design-methods`, `api-testing` | `penguin/agents/test_case_agent/AGENTS.md` |
| 6 | `automation_execution_agent` | 自动化执行智能体 | 执行真实 Web 浏览器和 Playwright 测试，保存可核验证据 | `playwright-execution`, `api-testing` | `penguin/agents/automation_execution_agent/AGENTS.md` |
| 7 | `android_test_agent` | App 测试智能体 | 在已派发范围内执行 Android App 测试 | `android-execution` | `penguin/agents/android_test_agent/AGENTS.md` |
| 8 | `miniprogram_test_agent` | 小程序测试智能体 | 在已派发范围内执行微信小程序测试 | `miniprogram-execution` | `penguin/agents/miniprogram_test_agent/AGENTS.md` |
| 9 | `defect_analysis_agent` | 缺陷分析智能体 | 基于真实失败证据生成缺陷草稿和待复核结论 | `bug-reporting`, `qa-investigation` | `penguin/agents/defect_analysis_agent/AGENTS.md` |
| 10 | `test_report_agent` | 测试报告智能体 | 汇总当前运行的设计、执行和缺陷证据，生成测试报告 | `test-report-writing` | `penguin/agents/test_report_agent/AGENTS.md` |
| 11 | `api_automation_agent` | 接口自动化测试工程师 | 执行已派发的接口自动化场景，不启动浏览器 | `api-test-execution`, `api-testing` | `penguin/agents/api_automation_agent/AGENTS.md` |

## 2. 公共提示词与继承关系

`penguin/agents.json` 的 `shared_instructions` 指向 `penguin/command-runtime.md`。该文件是所有角色的公共运行提示词，与各角色 `AGENTS.md` 一起构成最终提示词上下文。

公共提示词的核心约束：

1. 当前能力范围只覆盖功能测试和接口测试；性能测试、压力测试、安全测试、漏洞扫描和渗透测试不建设、不派发、不生成结论。
2. 用户可见说明、进度、待确认问题和最终答复统一使用中文；代码标识、路径、字段名和原始引用保持原样。
3. 交付必须区分已完成、部分完成、未执行、待确认、产品缺陷和实现/环境问题；不能把结构校验通过当成业务验收通过。
4. 执行类动作必须保留真实证据；动作完成不等于断言通过，结果未知时不能更换 ID 重放业务写入。
5. 大批量设计优先分批保存；修订保留历史产物，不通过删除台账、覆盖旧结果或伪造确认来消除风险。
6. 需求、测试点、用例、缺陷和报告要保留来源追溯；实现观察不能倒推为业务预期。
7. 缺陷状态推进需要真实治理依据；关闭缺陷必须绑定修复后的独立合格复测。
8. 用户回复保持简短、只给真实可点击产物和必要风险，不展示内部派发编号、哈希、工具日志或推理过程。

## 3. 各 Agent 职责与提示词要求

### 3.1 `default_agent` / `general_agent`

- 提示词：`penguin/agents/default_agent/AGENTS.md`
- 定位：默认通用助手，不是软件测试总控。
- 核心职责：
  - 处理一般问答和与测试工程无关的用户工作。
  - 用户提出需求分析、测试点、用例、产品测试、缺陷分析或报告需求时，说明应进入 `test_agent` 会话继续。
- Skill：无。
- 提示词核心要求：
  - 不冒充 `test_agent`，不直接通过 `run_subagent` 调用测试总控或专业角色。
  - 不生成假的派发、测试结果或交付文件。
  - 角色切换由宿主界面完成，不绕过会话身份绑定。
  - 已有测试会话回到对应总控会话继续；不跨会话读取凭据或复用执行授权。
  - 不删除其他 Skill、记忆或用户自定义指令。

### 3.2 `test_agent` / 软件测试总控智能体

- 提示词：`penguin/agents/test_agent/AGENTS.md`
- 定位：测试全流程总控，负责编排和交付，不代替专业角色写产物。
- 核心职责：
  - 理解用户目标、归档材料、识别功能与接口链路。
  - 使用 `plan_test_tracks` 建立任务链路，按 `run_id` 和派发模板调度专业 Agent。
  - 核验真实子任务结果，组织阶段 handoff 和最终交付。
  - 区分功能测试和接口测试；接口任务派发 `api_automation_agent`，不派浏览器代替接口请求。
- Skill：当前无 active skill。
- Retired skills：
  - `requirement-analysis`
  - `test-point-design`
  - `test-case-writing`
  - `playwright-execution`
  - `bug-reporting`
  - `test-report-writing`
  - `test-asset-management`
  - `test-selection`
  - `test-design-methods`
  - `qa-investigation`
  - `api-testing`
- 提示词核心要求：
  - 只要任一用户要求阶段未完成，第一句必须说明“部分完成”和未完成项。
  - 会话 idle、文件存在或执行阶段 completed 不等于业务测试通过。
  - 功能与接口混合材料按类型建立独立链路，不复制一份产物冒充另一类结果。
  - 执行一旦派发，设计冻结；修订必须进入明确的新任务版本，不能自动覆盖或重放。
  - 功能测试提供页面 URL 且用户要求全流程时，优先浏览器执行模式；纯接口使用 `api_execution`。
  - 不为派发而先读专业 Skill 全文，也不替专业 Agent 写草稿。
  - 最终交付使用 `typed_delivery.user_message` 和真实命名文件链接，不暴露内部原始路径。
  - 不伪造子 Agent、执行、断言、缺陷、来源或批准；未授权不向外部缺陷平台提交。

### 3.3 `requirement_analysis_agent` / 需求分析智能体

- 提示词：`penguin/agents/requirement_analysis_agent/AGENTS.md`
- 定位：把当前任务输入分析为可测试需求基线，维护规则、风险、假设和待确认项。
- 当前绑定 Skill：

| Skill | 用途 |
|---|---|
| `requirement-analysis` | 分析功能、业务规则、风险和待澄清问题。 |
| `test-design-methods` | lifecycle 中按需做语义与覆盖检查，发现会改变预期的歧义。 |
| `api-contract-analysis` | 解析 OpenAPI/Swagger 或文字接口契约，形成接口清单与业务规则。 |

- 提示词核心要求：
  - 输入来自当前文字、附件、页面信息和已有资产，不把固定路径当作唯一来源。
  - 只把会改变业务预期、范围或执行授权的真实歧义记为 pending；执行准备事项不冒充业务待确认。
  - 独立任务直接产出 `analysis/requirement_analysis.md`，不补造 lifecycle 台账。
  - lifecycle 需维护需求台账，先诊断，再生成、校验和摘要。
  - 事实、合理推断和待确认信息必须区分；所有规则、风险、假设和排除保留来源引用。
  - 用户需求是业务预期依据；代码、页面现状、历史测试只能作为实现观察或背景，不能倒推为正确规则。
  - 接口资料分析输出 `analysis/api_contract.json`，本阶段不发业务请求。

### 3.4 `test_point_agent` / 测试点智能体

- 提示词：`penguin/agents/test_point_agent/AGENTS.md`
- 定位：从需求基线、用户材料和已知风险设计可追溯测试覆盖地图。
- 当前绑定 Skill：

| Skill | 用途 |
|---|---|
| `test-point-design` | 设计正常、异常和边界场景测试点。 |
| `test-design-methods` | 复杂条件或状态流程按需使用决策表、状态迁移等检查遗漏。 |
| `api-testing` | 辅助接口专项测试点的方法与契约理解。 |

- 提示词核心要求：
  - 独立任务从当前材料生成 `design/test_points.json`，导出 XMind，不虚构需求台账。
  - lifecycle 中每个测试点必须通过 `rule_ids` 追溯范围内需求或假设。
  - 覆盖主流程、异常、边界及任务相关的兼容性或业务权限风险。
  - 未确认规则只能生成明确标注的草稿，不能改成 confirmed。
  - 用户限制用例条数时，测试点总数不能超过该上限；超限应合并同规则变体，不让用例角色删减规避。
  - 不把执行步骤写成测试点，不代替用例编写或执行。
  - 接口测试点保留 `operation_id`、来源和 `execution_layer=api`；设计阶段不发请求。

### 3.5 `test_case_agent` / 测试用例智能体

- 提示词：`penguin/agents/test_case_agent/AGENTS.md`
- 定位：基于当前派发材料设计、诊断并交付测试用例。
- 当前绑定 Skill：

| Skill | 用途 |
|---|---|
| `test-case-writing` | 生成符合项目 JSON Schema 的结构化测试用例。 |
| `test-design-methods` | 按需使用控件、业务权限、AI 功能和测试设计方法参考。 |
| `api-testing` | 编写和结构化接口用例时提供契约、认证、错误响应和副作用设计边界。 |

- 提示词核心要求：
  - 每个正式预期子句必须有当前来源依据；不能根据响应或猜测补造预期。
  - 独立任务生成 `design/test_cases.json`，必要时导出 Excel。
  - 测试数据写入 `test_data`，步骤引用实际字段；不为数数运行临时脚本。
  - 用户限制用例总数时，每个用例只关联一个测试点；上游测试点超限应返回修订测试点，不通过复制或删减规避。
  - 执行已派发后不覆盖设计文件；修订保留旧版本并由总控安排新任务。
  - 不通过 curl、浏览器或自编 HTTP 请求探索产品。
  - 接口用例标记 `execution_layer=api`，使用 `api_scenario` 和 `api_plan`；只有设计任务时不发业务请求。
  - 功能与接口分流后，同一用例不标 `both`，也不复制成两套。

### 3.6 `automation_execution_agent` / 自动化执行智能体

- 提示词：`penguin/agents/automation_execution_agent/AGENTS.md`
- 定位：在授权和环境具备时观察真实 Web 页面，准备或执行 Playwright 测试并归档证据。
- 当前绑定 Skill：

| Skill | 用途 |
|---|---|
| `playwright-execution` | 按独立浏览器任务或 lifecycle 模式准备、执行 Playwright 测试并归档证据。 |
| `api-testing` | 补充接口脚本设计能力；不给 `browser_task` 编造 HTTP 动作。 |

- 提示词核心要求：
  - 先读取受控生成的 `execution/browser-case-plan.json`，按清单执行已确认用例。
  - 每条用例核对步骤、预期和实际断言；无断言的操作不算通过。
  - 探索新增断言要关联原设计 `case_ref`；无法关联的记为补充用例，不能替代设计清单。
  - 同一 run 只启动一次浏览器任务；操作使用稳定 `request_id`，不确定写结果不换 ID 重放。
  - 结论只限 `checked_condition`；未断言字段不得写成通过。
  - 未覆盖步骤写入 `untested`，结果为 `partial` 时如实交接。
  - 登录、验证码和 MFA 使用人工暂停机制；不伪造用户确认。
  - 不安装依赖、不下载浏览器；使用项目已有 Playwright 依赖和本机 Chrome channel。
  - 新增、修改、删除类用例必须准备并清理独立测试数据。
  - 浏览器执行只能通过受控入口调用，不执行计划外脚本或自行扩大范围。
  - 命令收口失败、业务失败、阻塞和部分结果分别处理；不自动重试业务操作，不把受阻写成通过。

### 3.7 `android_test_agent` / App 测试智能体

- 提示词：`penguin/agents/android_test_agent/AGENTS.md`
- 定位：执行已派发 Android App 测试。
- 当前绑定 Skill：

| Skill | 用途 |
|---|---|
| `android-execution` | 通过 ADB 后端执行应用启动、控件操作、UI 断言、截图和失败取证。 |

- 提示词核心要求：
  - 只使用 `android-execution` 和受控 `android_task` 动作。
  - 先读取总控归档的用户请求、被测包、设备和动作范围；缺目标信息时报阻塞，不从历史运行猜测。
  - 先 doctor、start、snapshot，再执行授权动作和真实断言。
  - 无断言的点击不算用例通过。
  - 断连或写结果未知时停止，不更换 ID 重放。
  - 截图、UI 和日志可能含敏感内容，交付时说明。
  - 只写当前 run 允许的产物；原始回执和证据由受控动作生成，不能手写。
  - 不修改 manifest、不派发其他 Agent、不宣称业务 App 验收通过。

### 3.8 `miniprogram_test_agent` / 小程序测试智能体

- 提示词：`penguin/agents/miniprogram_test_agent/AGENTS.md`
- 定位：执行已派发微信小程序测试。
- 当前绑定 Skill：

| Skill | 用途 |
|---|---|
| `miniprogram-execution` | 通过微信开发者工具自动化后端执行小程序启动、页面操作、断言、截图和取证。 |

- 提示词核心要求：
  - 只使用 `miniprogram-execution` 和受控 `miniprogram_task` 动作。
  - 先读取总控归档的用户请求、工程目录、AppID 和动作范围；缺目标工程或开发者工具时报阻塞。
  - 先 doctor、start、snapshot，再执行授权动作和真实断言。
  - 无断言的操作不算用例通过。
  - 断连或写结果未知时停止，不更换 ID 重放。
  - 开发者工具验证结果不等于真机验收。
  - 只写当前 run 允许的产物；原始回执和证据由受控动作生成，不能手写。
  - 不修改 manifest、不派发其他 Agent、不宣称真机业务验收通过。

### 3.9 `defect_analysis_agent` / 缺陷分析智能体

- 提示词：`penguin/agents/defect_analysis_agent/AGENTS.md`
- 定位：基于当前运行中的真实失败、日志、截图、trace 和关联用例生成本地缺陷草稿。
- 当前绑定 Skill：

| Skill | 用途 |
|---|---|
| `bug-reporting` | 分类测试失败并生成可追溯 Bug 草稿。 |
| `qa-investigation` | 多步骤失败按需做证据化根因调查，不直接修复或关闭缺陷。 |

- 提示词核心要求：
  - 严重程度按标准判定，记录 `severity`、`severity_standard_version`、`severity_reason` 和四个维度依据。
  - 无法确认的维度写 `unknown`；`unknown` 是正式结论，不是低风险。
  - 证据不足标 `needs_review`，不把推测写成产品缺陷。
  - `script_issue` 只在能明确归因脚本、测试数据或选择器时使用；无法排除产品问题一律 `needs_review`。
  - 独立任务生成 `defects/defect-records.json` 和 `bugs.md`。
  - lifecycle 使用 `assess_evidence`、`normalize_defects` 和 `validate_artifacts`，不直接调用底层脚本。
  - 不得仅凭模型文字设置 confirmed、fixed 或 closed。
  - fixed 只是修复声明；关闭必须绑定修复后的独立合格复测。
  - 不向 Jira、禅道等外部平台提交。
  - API 与 UI 结果来源不同，按 layer、source_case_id 和 scenario_id 区分，不因编号相同互相覆盖。

### 3.10 `test_report_agent` / 测试报告智能体

- 提示词：`penguin/agents/test_report_agent/AGENTS.md`
- 定位：汇总当前运行真实存在的设计、执行和缺陷产物，形成审阅可用测试结论。
- 当前绑定 Skill：

| Skill | 用途 |
|---|---|
| `test-report-writing` | 根据真实测试结果和缺陷记录生成报告与风险建议。 |

- 提示词核心要求：
  - 只以 `checked_condition` 和实际证据为限；expected 中未断言的字段不能写成通过。
  - 未执行不算通过，partial、未测范围、零断言和待确认问题必须在结论开头体现。
  - 错误提示检查通过不代表创建成功。
  - HTTP 503、超时或断言失败本身不足以判定产品缺陷；证据不足保持 `needs_review`。
  - 独立任务生成 `report/test_report.md`、`reportable-results.json` 和 `issues.json`，再导出 HTML。
  - lifecycle 以 `quality-metrics` 作为执行统计、证据可信度、缺陷统计和质量门唯一事实源。
  - `needs_review` 或 `review_required` 必须写“产品缺陷结论待确认”；blocked 不得给出通过结论。
  - 只使用本机已有 HTML 生成环境，不安装依赖或在线下载组件。
  - 当前用户默认交付 HTML；Word/PDF 暂不生成，内部 Markdown/JSON/执行版 Excel 不作为默认交付。
  - 报告标题使用真实功能/模块名加“功能测试报告”或“接口测试报告”，不用 run_id 或内部占位名。

### 3.11 `api_automation_agent` / 接口自动化测试工程师

- 提示词：`penguin/agents/api_automation_agent/AGENTS.md`
- 定位：只执行当前派发的 `api_execution`，不负责接口设计和浏览器测试。
- 当前绑定 Skill：

| Skill | 用途 |
|---|---|
| `api-test-execution` | 使用独立 HTTP worker 执行声明式接口场景并保存逐请求证据。 |
| `api-testing` | 提供接口契约、认证、错误响应、Schema 和副作用测试边界。 |

- 提示词核心要求：
  - 消费当前任务已有接口用例；需要设计时交回总控协调分析、测试点和用例角色。
  - 不根据响应补造预期，不覆盖设计。
  - 使用结构化 `api_task` 动作：`inspect_contract`、`prepare`、`start`、`status`、`collect`、`cancel`、`resume`。
  - 不启动浏览器、不执行任意脚本、不安装依赖。
  - `start` 返回不是测试完成；继续用 `status` 和 `collect` 收口。
  - 原 `request_id` 已发出后不能更换 ID 重试；写请求结果未知保持未知。
  - 凭据使用 `qa-secret://` 引用，不搜索其他会话，不落明文。
  - 缺认证或业务预期时说明缺项；`waiting_human` 不交付为完成。
  - 用户提供安全引用后在原任务 `resume(credentials)`，不重派或重新 start。
  - `execution/api` 下结果和证据由工具生成，禁止手写修改。
  - 完成后执行 `validate_artifacts(stage=api_execution)`，返回真实状态、产物路径、未测范围和人工事项。

## 4. Skill 清单与绑定关系

| Skill | 版本 | 描述 | 当前绑定 Agent |
|---|---|---|---|
| `android-execution` | 2026.11.02.1 | 通过 ADB 执行 Android 应用操作、断言、截图和失败取证。 | `android_test_agent` |
| `api-contract-analysis` | 2026.11.02.1 | 解析 OpenAPI/Swagger 或文字接口契约，形成接口清单和业务规则。 | `requirement_analysis_agent` |
| `api-test-execution` | 2026.11.02.1 | 使用独立 HTTP worker 执行接口场景，保存断言证据并处理取消/部分结果。 | `api_automation_agent` |
| `api-testing` | 2026.11.02.1 | 依据接口契约设计接口测试，覆盖认证、错误响应、分页、Schema 和副作用。 | `test_point_agent`, `test_case_agent`, `automation_execution_agent`, `api_automation_agent` |
| `bug-reporting` | 2026.11.02.2 | 基于失败结果、日志和截图分类问题，生成可追溯 Bug 草稿。 | `defect_analysis_agent` |
| `miniprogram-execution` | 2026.11.02.1 | 通过微信开发者工具自动化后端执行小程序操作、断言、截图和取证。 | `miniprogram_test_agent` |
| `playwright-execution` | 2026.11.02.2 | 按任务或 lifecycle 模式准备、执行 Playwright 测试并归档证据。 | `automation_execution_agent` |
| `qa-investigation` | 2026.11.02.1 | 对具体失败做证据化根因调查，区分产品、脚本、环境、数据原因和未确认项。 | `defect_analysis_agent` |
| `requirement-analysis` | 2026.11.02.2 | 分析功能、业务规则、风险和待澄清问题。 | `requirement_analysis_agent` |
| `test-case-writing` | 2026.11.02.1 | 根据测试点生成结构化测试用例。 | `test_case_agent` |
| `test-design-methods` | 2026.11.02.1 | 提供等价类、边界值、决策表和状态迁移等设计方法及覆盖评审。 | `requirement_analysis_agent`, `test_point_agent`, `test_case_agent` |
| `test-point-design` | 2026.11.02.1 | 基于需求分析设计正常、异常和边界场景测试点。 | `test_point_agent` |
| `test-report-writing` | 2026.11.02.2 | 根据真实结果和缺陷记录生成测试报告与风险建议。 | `test_report_agent` |
| `test-asset-management` | 2026.11.02.1 | 管理可复用测试规则、数据策略、定位器、断言、接口契约和缺陷模式。 | 未绑定 |
| `test-selection` | 2026.11.02.1 | 按风险、优先级、变更范围、执行成本、数据影响和预算选择测试集。 | 未绑定 |

## 5. 统计与边界说明

1. `default_agent` 在 `agents.json` 中是 `fallback_entry`，不在 `agents` 数组内；统计 11 个 Agent 时必须计入。
2. `test_agent` 当前不绑定任何 active skill；它的 retired skills 只是历史迁移记录，不是当前运行时加载能力。
3. `api_automation_agent` 与 `automation_execution_agent` 分离：前者只做接口执行，后者负责 Web/Playwright 浏览器执行。
4. Skill 目录中的 `test-asset-management` 和 `test-selection` 已存在定义，但当前没有绑定到任何 Agent。
5. 本清单只描述源码定义和提示词约束，不代表安装版已同步的运行状态；运行验收仍需以安装版实际资源和会话行为为准。
