---
name: test-report-writing
description: 根据真实测试结果和缺陷记录生成测试报告与风险建议。
metadata:
  version: '1.3.0'
---

# 测试报告生成 Skill

## 证据解释（所有模式）

- 动作、断言、DOM快照、截图按各自时间和request_id关联；同调用assertion以匹配时记录为准，截图可能更晚。standalone_observation不能倒推先前短暂提示是否可见，历史记录缺timing时核对回执时间，不编造时序。
- 矛盾证据保留原始统计与路径，区分产品缺陷、自动化采样问题和待核查项。没有支持证据不能宣称业务通过、明确根因或已确认产品缺陷。
- 输入框/已知敏感内容的遮罩不等于全页不可见；不得把脱敏默认归因成断言失败，不得建议关闭脱敏、暴露凭据或降低证书校验。使用已有结构化观察、时间戳及脱敏截图；若关键区域确实被遮挡，准确说明该区域的证据局限。
- 工具已支持同调用click/press+assertion，应建议把动态反馈检查与动作绑定；不要建议为补证据重复结果不明的业务提交。相关网络请求须核对操作时间和业务关联，session_history_not_causal不能直接当根因。

## 独立任务（task）

直接使用提供的有效结果，写report/test_report.md、report/reportable-results.json与report/issues.json。结果包含本run_id、cases和summary，字段与计数按派发契约；已执行结果引用实际证据，无结果就明确未执行。历史材料标为导入，不冒充本Agent执行。用export_report导出HTML、Excel、Word/PDF；不调用build_report_metrics，不补生命周期台账。

仅使用派发输入与available_sources，不检查不存在的可选design/defects文件。issues.json是顶层数组，无问题写`[]`，不是`{"issues":[]}`或`{"bugs":[]}`；诊断指出哪个文件就修哪个文件，不改无关测试结果。先保存当前阶段四份草稿（Markdown、results、issues、task），再diagnose_task、export_report、validate_artifacts。动作放入请求JSON并保存成功后，使用catalog.invocation的execute入口，不用action名称作CLI子命令。

正文直接从标题开始，不写YAML元数据。未生成生命周期质量指标时只给出本次执行结论，不宣告质量门通过；没有历史台账时省略历史缺陷数或标为未评估，不默认0。当前未观察到缺陷不等于不存在历史问题。

按派发的独立契约填写当前阶段*-task.json。草稿用diagnose_task，交付用validate_artifacts，由父总控handoff。source_paths保留实际依据，不生成虚假前序产物；questions不放技术检查、解锁或重复批准要求。任务与确认策略由公共运行指令统一规定，本Skill不新增节点。

## 生命周期模式（lifecycle）

以下流程、输入、Schema及规则台账/批次要求仅适用于lifecycle。task复用专业方法和展示样式，不执行本分支的前序检查或生命周期专用动作。

### 通用交付模板

正文包括结论摘要、范围与环境、核心业务流程、问题与证据、测试数据及清理、未覆盖范围与回归建议、交付清单。清理未核验须明确标注，候选缺陷不得写成确认缺陷。export_report 新增 report/test_report.html（搜索及结果筛选）和 report/test_cases.xlsx（用例及问题清单），保留Word/PDF。执行版关联本次结果，保留未执行项，不覆盖设计版。对话回复仅列完成内容、产物链接和真正待决策事项。

### 统一产物交付契约

新版运行同时核对当前invocation_id和独立attempt归档完整性。归档被修改、未封存或证据/缺陷仍属于旧批次时，停止正式交付并报告阻塞；不通过编辑哈希或手改当前结果修复。报告应区分历史轮次与当前轮次，列出超时、中断及残留数据风险，参见`docs/execution-attempts.md`。

交付前运行`npm run artifacts:validate -- <run_id> report`，遵循`docs/artifact-contracts.md`。报告必须明确写出run_id和quality_gate.status原始值；统计、分类、通过率及质量门以当前结果与质量指标为准。结构校验检查Word包和PDF标识，但不替代渲染、客户端打开和人工结论审查。最新blocked/running状态的阻塞报告不能复用历史成功统计或旧缺陷分类，应生成当前空结果说明与对应空分类/评估。不得将阻塞报告登记为执行成功。

### 适用场景

当测试执行完成后，需要汇总测试范围、执行结果、Bug 和风险时使用。

### 输入

- 当前 `run_id` 中真实存在的测试点、用例、执行结果和缺陷分析产物
- 当前 `run_id` 的证据评估、标准缺陷记录和质量指标

### 输出

- 当前 `run_id` 的 `report/test_report.md`
- 当前 `run_id` 的 `report/test_report.docx`
- 当前 `run_id` 的 `report/test_report.pdf`

### 工作步骤

1. 先通过project-action调用build_report_metrics（只需run_id）。跨运行趋势属于补充分析，不是本run交付的必需前置；确需生成时沿用已有统一命令入口，不混同本次结果。
2. 以 `report/quality-metrics.json` 作为执行统计、证据可信度、缺陷统计和质量门的唯一事实源；以 `output/quality/quality-trends.json` 作为跨运行趋势来源。
3. 汇总测试范围、失败和阻塞、缺陷、待确认项、未覆盖范围和残余风险。
4. 根据 `quality_gate.status` 给出谨慎结论：`blocked` 不得给出通过结论；`review_required` 必须写明待确认项；`risk_present` 必须列出高风险；`informational` 仍需说明测试范围边界。
5. 生成Markdown后，通过project-action调用export_report（只需run_id），使用本run的reportable-results和最新度量生成Word/PDF，再validate_artifacts（stage=report）并进行渲染检查。不得直接调用Python导出脚本；入口自动归档旧文件，但结构校验不能代替版式检查。仅按recovery.retry_allowed修正技术错误，不用旧成功结果填补受阻或批次不匹配。详见docs/draft-artifact-recovery.md。
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
- 生命周期变更使已完成报告进入 revision_requested；重新生成度量、Markdown、Word/PDF，再验证报告契约和登记完成，不手改 manifest。导出器校验台账哈希不替代完整证据重放及渲染检查。旧报告保留为历史，不作为当前正式交付。
- 报告只统计当前运行中真实执行的用例；未执行的测试点单列为“未覆盖”。
- 读取当前运行的 bugs.json 和 bugs.md；若 Bug 为待确认，不能写为已确认缺陷。
- 报告必须给出本次 run_id、执行范围、通过/失败/阻塞统计、风险、待确认项和证据位置。
- 存在 `needs_review` 时，报告结论必须写为“产品缺陷结论待确认”，并列出关联用例；不得以“无产品缺陷”代替。
- 报告必须展示质量门状态、证据不足数量、待确认项和残余风险；Word/PDF 与 Markdown 使用相同的质量门状态和核心统计。
