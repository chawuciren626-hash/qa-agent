---
name: test-report-writing
description: 根据真实测试结果和缺陷记录生成测试报告与风险建议。
version: 1.2.0
---

# 测试报告生成 Skill

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
5. 生成 Markdown 后，调用 `python scripts/generate-report-documents.py <report.md> <test_results.json> <bugs.json> <report.docx> <report.pdf> <quality-metrics.json>` 生成 Word 与 PDF，再进行渲染检查。
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

- 报告只统计当前运行中真实执行的用例；未执行的测试点单列为“未覆盖”。
- 读取当前运行的 bugs.json 和 bugs.md；若 Bug 为待确认，不能写为已确认缺陷。
- 报告必须给出本次 run_id、执行范围、通过/失败/阻塞统计、风险、待确认项和证据位置。
- 存在 `needs_review` 时，报告结论必须写为“产品缺陷结论待确认”，并列出关联用例；不得以“无产品缺陷”代替。
- 报告必须展示质量门状态、证据不足数量、待确认项和残余风险；Word/PDF 与 Markdown 使用相同的质量门状态和核心统计。
