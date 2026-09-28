---
name: test-report-writing
description: 根据真实测试结果和缺陷记录生成测试报告与风险建议。
version: 1.1.0
---

# 测试报告生成 Skill

## 适用场景

当测试执行完成后，需要汇总测试范围、执行结果、Bug 和风险时使用。

## 输入

- 当前 `run_id` 中真实存在的测试点、用例、执行结果和缺陷分析产物

## 输出

- 当前 `run_id` 的 `report/test_report.md`
- 当前 `run_id` 的 `report/test_report.docx`
- 当前 `run_id` 的 `report/test_report.pdf`

## 工作步骤

1. 汇总测试范围。
2. 统计用例执行情况。
3. 汇总失败和阻塞。
4. 汇总 Bug 和风险。
5. 给出谨慎的测试结论和建议。
6. 调用 `scripts/generate-report-documents.py` 生成 Word 与 PDF，并进行渲染检查。
7. 不得为了生成报告临时安装 Python、npm、Office 或字体依赖；缺项时保留 Markdown 并报告环境未就绪。

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
