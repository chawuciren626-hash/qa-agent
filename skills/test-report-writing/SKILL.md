---
name: test-report-writing
description: 根据真实测试结果和缺陷记录生成测试报告与风险建议。
version: 1.3.0
---

# 测试报告生成 Skill

## 统一产物交付契约

新版运行同时核对当前invocation_id和独立attempt归档完整性。归档被修改、未封存或证据/缺陷仍属于旧批次时，停止正式交付并报告阻塞；不通过编辑哈希或手改当前结果修复。报告应区分历史轮次与当前轮次，列出超时、中断及残留数据风险，参见`docs/execution-attempts.md`。

交付前运行`npm run artifacts:validate -- <run_id> report`，遵循`docs/artifact-contracts.md`。报告必须明确写出run_id和quality_gate.status原始值；统计、分类、通过率及质量门以当前结果与质量指标为准。结构校验检查Word包和PDF标识，但不替代渲染、客户端打开和人工结论审查。最新blocked/running状态的阻塞报告不能复用历史成功统计或旧缺陷分类，应生成当前空结果说明与对应空分类/评估。不得将阻塞报告登记为执行成功。

## 适用场景

当测试执行完成后，需要汇总测试范围、执行结果、Bug 和风险时使用。

## 输入

- 当前 `run_id` 中真实存在的测试点、用例、执行结果和缺陷分析产物
- 当前 `run_id` 的证据评估、标准缺陷记录和质量指标

## 输出

- 当前 `run_id` 的 `report/test_report.md`
- 当前 `run_id` 的 `report/test_report.docx`
- 当前 `run_id` 的 `report/test_report.pdf`

## 工作步骤

1. 先运行 `node scripts/build-quality-metrics.mjs --run-id=<run_id>`，再运行 `node scripts/build-quality-trends.mjs`。
2. 以 `report/quality-metrics.json` 作为执行统计、证据可信度、缺陷统计和质量门的唯一事实源；以 `output/quality/quality-trends.json` 作为跨运行趋势来源。
3. 汇总测试范围、失败和阻塞、缺陷、待确认项、未覆盖范围和残余风险。
4. 根据 `quality_gate.status` 给出谨慎结论：`blocked` 不得给出通过结论；`review_required` 必须写明待确认项；`risk_present` 必须列出高风险；`informational` 仍需说明测试范围边界。
5. 生成 Markdown 后，调用 `python scripts/generate-report-documents.py <report.md> <report/reportable-results.json> <bugs.json> <report.docx> <report.pdf> <quality-metrics.json>` 生成 Word 与 PDF，再进行渲染检查。reportable-results由本次build-quality-metrics生成；不得用历史test_results替代本次阻塞结果。报告必须读取execution-state判断最近启动状态，遇到running、blocked或批次不匹配不得沿用旧成功统计。
6. 不得为了生成报告临时安装 Python、npm、Office 或字体依赖；缺项时保留 Markdown 并报告环境未就绪。

## 质量标准

- 报告结论必须基于真实结果。
- 通过率、失败率、阻塞数要准确。
- 风险和建议要具体。

## 禁止事项

- 禁止凭空写执行结果。
- 禁止遗漏失败用例。
- 禁止在证据不足时给出绝对上线结论。

## 报告规则

- 缺陷当前状态使用最新 `quality-metrics.json` 的 governance 视图，同时保留原始执行事实和历史未解决问题。台账完整性错误必须阻断结论；fixed 只是待复测，不等于关闭。不能因本次全通过而消除历史风险。
- 生命周期变更使已完成报告进入 revision_requested；重新生成度量、Markdown、Word/PDF，再验证报告契约和登记完成，不手改 manifest。导出器校验台账哈希不替代完整证据重放及渲染检查。旧报告保留为历史，不作为当前正式交付。
- 报告只统计当前运行中真实执行的用例；未执行的测试点单列为“未覆盖”。
- 读取当前运行的 bugs.json 和 bugs.md；若 Bug 为待确认，不能写为已确认缺陷。
- 报告必须给出本次 run_id、执行范围、通过/失败/阻塞统计、风险、待确认项和证据位置。
- 存在 `needs_review` 时，报告结论必须写为“产品缺陷结论待确认”，并列出关联用例；不得以“无产品缺陷”代替。
- 报告必须展示质量门状态、证据不足数量、待确认项和残余风险；Word/PDF 与 Markdown 使用相同的质量门状态和核心统计。
