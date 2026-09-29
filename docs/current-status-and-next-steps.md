# 当前状态与下一步

更新时间：2026-09-21

## 已确认状态

- PenguinHarness 已安装在 `D:\Program Files\PenguinHarness`。
- 桌面程序入口：`D:\Program Files\PenguinHarness\PenguinHarness.exe`。
- CLI 已加入 PATH。
- CLI 路径：`D:\Program Files\PenguinHarness\resources\app\bin\penguin.cmd`。
- 当前版本：`v0.2.13`。
- 当前项目目录：`E:\Codex\测试智能体`。
- 项目骨架已创建。

## 当前模型情况

`penguin config model list` 显示：

- 默认模型已设置为 `tokendance / step-3.7-flash`。
- `tokendance / step-3.7-flash` 已配置 API Key。

设置默认模型命令：

```powershell
penguin config model default --provider tokendance --model-id step-3.7-flash
```

当前已执行成功。

## 已创建的项目结构

```text
README.md
config/
  project.json
  test-env.json
docs/
  README.md
  agent-development-learning-guide.md
  one-month-qa-agent-plan.md
  orchestrator-prompt.md
  current-status-and-next-steps.md
inputs/
  requirements.md
schemas/
  test_point.schema.json
  test_case.schema.json
  bug.schema.json
skills/
  requirement-analysis/SKILL.md
  test-point-design/SKILL.md
  test-case-writing/SKILL.md
  playwright-execution/SKILL.md
  bug-reporting/SKILL.md
  test-report-writing/SKILL.md
tests/
  generated/
output/
scripts/
```

## 下一步执行顺序

### 第一步：先跑通测试点生成（已完成）

目标：验证 PenguinHarness 能读取当前项目并生成文件。

推荐命令：

```powershell
penguin run --workspace "E:\Codex\测试智能体" --provider tokendance --model-id step-3.7-flash --thinking medium --message "请读取 docs/orchestrator-prompt.md、skills/requirement-analysis/SKILL.md、skills/test-point-design/SKILL.md 和 inputs/requirements.md。本次只完成测试点梳理，输出 output/test_points.md。不要执行自动化测试。"
```

验收：

- `output/test_points.md` 被创建。
- 内容覆盖登录主流程、异常流程、边界、安全、性能。
- 不确定事项被标记为“待确认”。

执行结果：

- 已成功生成 `output/test_points.md`。
- PenguinHarness 已确认能读取当前工作区文件并写入产物。
- 未执行自动化测试。

### 第二步：生成结构化测试用例（已完成）

目标：把测试点转成 JSON 用例。

推荐命令：

```powershell
penguin run --workspace "E:\Codex\测试智能体" --provider tokendance --model-id step-3.7-flash --thinking medium --message "请读取 output/test_points.md、skills/test-case-writing/SKILL.md 和 schemas/test_case.schema.json，生成结构化测试用例到 output/test_cases.json。要求 JSON 可解析，字段符合 schema。"
```

验收：

- `output/test_cases.json` 被创建。
- 至少包含 P0/P1/P2 用例。
- 每条用例包含步骤、预期结果、优先级、自动化可行性。

执行结果：

- 已成功生成 `output/test_cases.json`。
- 共生成 16 条结构化测试用例。
- 优先级分布：P0 8 条、P1 6 条、P2 2 条。
- JSON 使用 UTF-8 读取时可正常解析。
- 未执行自动化测试。

Windows PowerShell 5.1 默认读取中文文件可能出现乱码。检查 JSON 时建议显式指定 UTF-8：

```powershell
$cases = Get-Content output\test_cases.json -Raw -Encoding UTF8 | ConvertFrom-Json
$cases.Count
```

### 第三步：接入 Playwright（下一步）

目标：具备自动执行 UI 测试的能力。

推荐先执行：

运行前先执行环境预检。常规测试运行不得自动安装依赖或下载浏览器；缺少组件时应标记“环境未就绪”，由用户单独决定是否安装或升级环境。

### 第四步：执行测试并生成结果

目标：执行 `tests/generated/*.spec.ts`，生成 `output/test_results.json`。

### 第五步：生成 Bug 和报告

目标：

- 基于失败测试生成 `output/bugs.md`。
- 基于测试结果生成 `output/test_report.md`。

## 当前建议

现在最适合做的是继续执行“第二步：生成结构化测试用例”，将 `output/test_points.md` 转成 `output/test_cases.json`。
