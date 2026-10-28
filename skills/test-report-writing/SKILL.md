---
name: test-report-writing
description: 根据真实测试结果和缺陷记录生成测试报告与风险建议。
metadata:
  version: '1.7.0'
---

# 测试报告生成 Skill

组织摘要、覆盖说明或上线建议时，按需读[报告结论与统计口径](references/conclusion-and-coverage.md)。该参考适用于两种模式，沿用现有统计事实源与HTML导出，不增加交付门槛。

## 证据解释（所有模式）

- 用户要求回归时，区分原始复现、邻近输入、合法路径和关联影响面；使用可选regression对照事实，原失败和未覆盖范围保留，不把“已修复”说明或单条通过当成缺陷关闭。材料不足照常部分交付，不要求用户技术映射或解锁。仅需历史对照时读取[独立回归交付](references/regression-delivery.md)，不增加普通报告的必填输入。

- evidence_mode区分real、simulated、simulation_affected和旧记录未标注。模拟HTTP错误或中断不能列为服务端实际故障，模拟场景断言通过不代表真实后端通过。模拟未命中/不确定时保留未验证；disabled只表示不再拦截新请求，不证明在途请求已结束或页面/业务状态恢复。报告按facts[].statistics.evidence_modes分开说明，不能混成真实产品通过率。

- 使用证据索引facts[].statistics区分结果记录、断言、关联用例、只读复查及框架重试。关联用例仅说明有对应断言，不证明整条用例通过或全覆盖；来源不全就写未记录，不按编号前缀猜测。复查通过不能覆盖原失败，复查不是重新执行产品动作。Playwright重试明细的retry=0是每个运行序列的首轮，不计额外重试；缺少历史不能写零重试。导入结果依旧标为用户提供，不冒充自主实测。工具读取回执、参数纠错和模型重试均不计为产品执行。导出自动附加统计口径，正文仅概述，不要求用户补技术台账。

- 动作、断言、DOM快照、截图按各自时间和request_id关联；同调用assertion以匹配时记录为准，截图可能更晚。standalone_observation不能倒推先前短暂提示是否可见，历史记录缺timing时核对回执时间，不编造时序。
- 矛盾证据保留原始统计与路径，区分产品缺陷、自动化采样问题和待核查项。没有支持证据不能宣称业务通过、明确根因或已确认产品缺陷。
- 输入框/已知敏感内容的遮罩不等于全页不可见；不得把脱敏默认归因成断言失败，不得建议关闭脱敏、暴露凭据或降低证书校验。使用已有结构化观察、时间戳及脱敏截图；若关键区域确实被遮挡，准确说明该区域的证据局限。
- 工具已支持同调用click/press+assertion，应建议把动态反馈检查与动作绑定；不要建议为补证据重复结果不明的业务提交。相关网络请求须核对操作时间和业务关联，session_history_not_causal不能直接当根因。

## 独立任务（task）

回归范围逐项沿用用户明确指定的类别：original=原始复现、valid_path=合法路径、impact=关联影响面、adjacent=邻近输入。adjacent不是所有复测的默认类别；用户说邻近输入未覆盖时，不得把已有检查归入adjacent。原始结果actual_result只承载实际观察，改善/回退、原因推测和结论放报告解释段，不拼进实际观察字段。无法确定分类可省略该配对并说明未分类，不为技术分类向用户索取解锁或补格式。

给总控的收尾也按用户交付表达：完成内容、实际产物链接及真正待决定事项。除非用户明确要求明细，不复述整张对照表、内部JSON、动作状态、哈希或“无质量指标/台账”等实现细节；这些边界写在报告中。总控无需把子Agent长回复照搬给用户。

用户明确要求初测/复测对照时，优先使用索引中已有映射；没有映射则直接在report/report-task.json增加可选regression_comparison:{version:1,comparisons:[{id,layer,baseline:{source_path,case_id},current:{source_path,case_id}}]}，来源和证据加入source_paths。只根据材料中明确对应关系选配，不能仅按相同编号配对；工具从允许的索引绑定哈希并检查可比条件。不得要求总控重派发或用户补映射文件，不写inputs。无可信对应关系时comparisons为空并说明未评估；普通报告不需要此字段。具体范围与格式见回归参考。

源结果转写必须保留已提供的expected、actual_result、evidence_mode、verification_scope、时序及用例关联等字段；最小契约字段不是白名单，不要裁剪为只有编号/状态/证据。当前轮与历史轮不可仅按相同编号合并。工具导出会按编号、状态和证据路径唯一匹配已索引来源，恢复字段并记录来源；歧义不猜测，不要求用户技术解锁。来源未提供实际说明时写未记录，不能用通过状态编造执行描述。导入、合成和模拟属性必须在结果清单和报告中可见；单条模拟通过不代表产品通过。

直接使用提供的有效结果，写report/test_report.md、report/reportable-results.json与report/issues.json。结果包含本run_id、cases和summary，字段与计数按派发契约；已执行结果引用实际证据，无结果就明确未执行。历史材料标为导入，不冒充本Agent执行。用export_report导出HTML（执行版 Excel 仅保留内部核查）；不调用build_report_metrics，不补生命周期台账。

仅使用派发输入与available_sources，不检查不存在的可选design/defects文件。issues.json是顶层数组，无问题写`[]`，不是`{"issues":[]}`或`{"bugs":[]}`；诊断指出哪个文件就修哪个文件，不改无关测试结果。先保存当前阶段四份草稿（Markdown、results、issues、task），再diagnose_task、export_report、validate_artifacts。动作放入请求JSON并保存成功后，使用catalog.invocation的execute入口，不用action名称作CLI子命令。

正文直接从标题开始，不写YAML元数据。未生成生命周期质量指标时只给出本次执行结论，不宣告质量门通过；没有历史台账时省略历史缺陷数或标为未评估，不默认0。当前未观察到缺陷不等于不存在历史问题。

按派发的独立契约填写当前阶段*-task.json。草稿用diagnose_task，交付用validate_artifacts，由父总控handoff。source_paths保留实际依据，不生成虚假前序产物；questions不放技术检查、解锁或重复批准要求。任务与确认策略由公共运行指令统一规定，本Skill不新增节点。

## 生命周期模式（lifecycle）

以下流程、输入、Schema及规则台账/批次要求仅适用于lifecycle。task复用专业方法和展示样式，不执行本分支的前序检查或生命周期专用动作。

### 通用交付模板

正文包括结论摘要、范围与环境、核心业务流程、问题与证据、测试数据及清理、未覆盖范围与回归建议、交付清单。清理未核验须明确标注，候选缺陷不得写成确认缺陷。export_report 新增 report/test_report.html（搜索及结果筛选）和 report/test_cases.xlsx（用例及问题清单），暂不生成 Word/PDF。执行版关联本次结果，保留未执行项，不覆盖设计版。对话回复仅列完成内容、产物链接和真正待决策事项。

### 统一产物交付契约

新版运行同时核对当前invocation_id和独立attempt归档完整性。归档被修改、未封存或证据/缺陷仍属于旧批次时，停止正式交付并报告阻塞；不通过编辑哈希或手改当前结果修复。报告应区分历史轮次与当前轮次，列出超时、中断及残留数据风险，参见`docs/execution-attempts.md`。

交付前运行`npm run artifacts:validate -- <run_id> report`，遵循`docs/artifact-contracts.md`。报告必须明确写出run_id和quality_gate.status原始值；统计、分类、通过率及质量门以当前结果与质量指标为准。结构校验检查 HTML 内容和执行结果，但不替代渲染、客户端打开和人工结论审查。最新blocked/running状态的阻塞报告不能复用历史成功统计或旧缺陷分类，应生成当前空结果说明与对应空分类/评估。不得将阻塞报告登记为执行成功。

### 适用场景

当测试执行完成后，需要汇总测试范围、执行结果、Bug 和风险时使用。

### 输入

- 当前 `run_id` 中真实存在的测试点、用例、执行结果和缺陷分析产物
- 当前 `run_id` 的证据评估、标准缺陷记录和质量指标

### 输出

- 当前 `run_id` 的 `report/test_report.md`
- 当前 `run_id` 的 `report/test_report.html`

### 工作步骤

1. 先通过project-action调用build_report_metrics（只需run_id）。跨运行趋势属于补充分析，不是本run交付的必需前置；确需生成时沿用已有统一命令入口，不混同本次结果。
2. 以 `report/quality-metrics.json` 作为执行统计、证据可信度、缺陷统计和质量门的唯一事实源；以 `output/quality/quality-trends.json` 作为跨运行趋势来源。
3. 汇总测试范围、失败和阻塞、缺陷、待确认项、未覆盖范围和残余风险。
4. 根据 `quality_gate.status` 给出谨慎结论：`blocked` 不得给出通过结论；`review_required` 必须写明待确认项；`risk_present` 必须列出高风险；`informational` 仍需说明测试范围边界。
5. 生成Markdown后，通过project-action调用export_report（只需run_id），使用本run的reportable-results和最新度量生成HTML，再validate_artifacts（stage=report）并进行渲染检查。不得直接调用Python导出脚本；入口自动归档旧文件，但结构校验不能代替版式检查。仅按recovery.retry_allowed修正技术错误，不用旧成功结果填补受阻或批次不匹配。详见docs/draft-artifact-recovery.md。
6. 不得为了生成报告临时安装 Python、npm、Office 或字体依赖；缺项时保留 Markdown 并报告环境未就绪。

### 质量标准

- 报告结论必须基于真实结果。
- 通过率、失败率、阻塞数要准确。
- 风险和建议要具体。

### 禁止事项

- 禁止凭空写执行结果。
- 禁止遗漏失败用例。
- 禁止在证据不足时给出绝对上线结论。

### 报告规则

- 缺陷当前状态使用最新 `quality-metrics.json` 的 governance 视图，同时保留原始执行事实和历史未解决问题。台账完整性错误必须阻断结论；fixed 只是待复测，不等于关闭。不能因本次全通过而消除历史风险。
- 生命周期变更使已完成报告进入 revision_requested；重新生成度量、Markdown、HTML，再验证报告契约和登记完成，不手改 manifest。导出器校验台账哈希不替代完整证据重放及渲染检查。旧报告保留为历史，不作为当前正式交付。
- 报告只统计当前运行中真实执行的用例；未执行的测试点单列为“未覆盖”。
- 读取当前运行的 bugs.json 和 bugs.md；若 Bug 为待确认，不能写为已确认缺陷。
- 报告必须给出本次 run_id、执行范围、通过/失败/阻塞统计、风险、待确认项和证据位置。
- 存在 `needs_review` 时，报告结论必须写为“产品缺陷结论待确认”，并列出关联用例；不得以“无产品缺陷”代替。
- 报告必须展示质量门状态、证据不足数量、待确认项和残余风险；HTML 与 Markdown 使用相同的质量门状态和核心统计。


## 当前用户交付约定

报告默认只生成并交付 HTML，暂不生成 Word/PDF。内部 Markdown、JSON、执行版 Excel 用于证据校验，不作为默认用户交付。标题使用真实功能/模块名称加“功能测试报告”或“接口测试报告”，不要用 run_id 或 test_xxx 当报告标题。内部固定路径供工具使用；总控 handoff 后生成带功能/模块前缀的交付副本，总控只向用户给出 typed_delivery.files 中的命名链接。
