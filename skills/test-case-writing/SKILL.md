---
name: test-case-writing
version: 2026.11.22.1
description: 把测试点写成可执行、可判定的结构化测试用例，每个预期都有原文依据，产出 JSON 与 Excel。
task: case_step_fill
stage: test_cases
tools: ["plan.gates", "irval.check"]
sections:
  criteria: ["产物格式（强制）", "预期依据", "测试数据表达", "自检清单", "不要做"]
  knowledge: ["设计方法", "锚点与资产引用", "功能轨与接口轨分流"]
  steps: ["输入", "输出", "任务形态（按派发单选，不按自己习惯）", "工作步骤"]
---

# 测试用例编写 Skill

路径基准：`docs/`、`schemas/`、`config/` 按工程动作目录返回的 `runtime_context.engine_root` 解析。正式产物在本次 run 的 `design/` 下。

## 输入

| 来源 | 用途 | 必需 |
|---|---|---|
| `design/test_points.json` | 测试点，用例的来源与追溯锚 | 全流程必需 |
| `analysis/requirement-ledger.json` | 规则状态，决定 `basis.status` 与能否进执行 | 全流程必需 |
| `analysis/requirement_analysis.md`、`analysis/api_contract.json` | 预期原文与接口契约 | 全流程必需 |
| 派发单 | run、范围、条数上限、功能/接口轨 | 是 |
| 单点任务的派发材料 | 无测试点时的直接来源 | 单点任务 |

## 输出

| 文件 | 性质 | 说明 |
|---|---|---|
| `design/test_cases.json` | 必交，事实源 | Excel 从它导出 |
| `design/test_cases.xlsx` | 必交 | 用工程导出器生成，不手改表格 |
| `design/test_cases.md` | 可选 | 阅读版，内容与 JSON 一致 |
| `design/test_cases-task.json` | 单点任务必交 | 全流程不交 |

## 任务形态（按派发单选，不按自己习惯）

| | 全流程（lifecycle） | 单点任务（task） |
|---|---|---|
| 依据 | 测试点 + 台账 + 分析正文 | 派发材料 |
| `related_test_point` | 必填，必须是本次测试点 JSON 里的 ID | 无测试点来源时省略 |
| `design_contract.basis` | 必填，`rule_id` 来自台账且包含在关联测试点的 `rule_ids` 里 | 引用派发材料，不编 `rule_id` |
| 预期依据 | `basis` + 逐句来源 | `expected_basis` 逐句来源 |
| 执行合同 | 必需 | 可省略 |

生命周期模式下的完整用例格式（必填字段、`execution_metadata`、`design_contract` 三子结构）
按需查 [references/lifecycle.md](references/lifecycle.md)，不要提前整篇照搬。

## 产物格式（强制）

### 顶层结构

数组，或 `{ "run_id": "...", "cases": [...] }`；数组键只认 `cases` 或 `test_cases`，不同时存在两个。

### 单条字段

| 字段 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `case_id` | 是 | 唯一，`TC-001` 起 | 不复用 |
| `title` | 是 | 一句话：场景 + 关键条件 | 不写编号 |
| `priority` | 是 | `P0` / `P1` / `P2` / `P3` | 只这四个 |
| `type` | 是 | 功能 / 接口 / 兼容性 / 权限 / 数据 | 自由文本，同一批里用词保持一致 |
| `preconditions` | 是 | 字符串数组 | 能复现的前置状态；不写"已确认"这类无来源条件 |
| `steps` | 是 | 字符串数组 | 一条一动作，可照着做 |
| `expected` | 是 | 字符串 | 主预期，可观察、可判定 |
| `automation_feasible` | 是 | true / false | 判断能否自动化，不承诺已跑通 |
| `related_test_point` | 是 | 测试点 ID | 必须真实存在 |
| `design_contract` | 是 | 对象，见下 | 结构不完整会被拒 |
| `test_data` | 否 | 对象 | 数据只在这里存一份 |
| `module` | 否 | 模块名 | 与测试点 module 一致 |
| `end` | 否 | `web` / `web_admin` / `app` / `miniprogram` / `desktop` / `api` / `""` | 与关联测试点一致 |
| `execution_layer` | 否 | `ui` / `api` | 不写 both |
| `expectations` | 否 | 数组 `{text, kind, source:{type,ref,quote}}` | 多子句预期时逐句给来源 |
| `expected_basis` | 否 | 数组 `{expected, kind, source_path, quote}` | 单点任务用它替代 basis |

### `design_contract`

| 子字段 | 必填 | 结构 |
|---|---|---|
| `basis` | 是，至少 1 条 | `{rule_id, source, rule, status}`；`status` 只取 `confirmed` / `pending` / `conflicted` |
| `assumptions` | 是，可为空数组 | `{statement, status, confirmation_ref?}`；`status` 取 `pending` / `confirmed` / `rejected`，`confirmed` 必须带 `confirmation_ref` |
| `data_checks` | 是，可为空数组 | 长度：`{kind:"length", key, unit, expected}`，`unit` 取 `code_points` / `utf16` / `utf8_bytes` / `graphemes`；金额：`{kind:"minor_unit_sum", currency, total_key, terms}` |

`assumptions` 只放影响业务预期或授权的真实假设。定位控件、清空输入、核对文案、检查可达性属于执行准备，写进 `steps` / `preconditions`，不要塞成 pending 假设。

### 执行相关约定字段（引擎按需读取，不进 Schema 强校验）

- `execution_contract`：`data_isolation`（如 `read_only`）、`setup`、`assertion_mode`、`cleanup_required`。
- `execution_metadata`：`modules`、`tags`、`risk_level`、`execution_cost`、`data_impact`、`environment_dependencies`、`automation_maturity`、`estimated_duration_ms`。没有可靠依据用保守值。

### Excel

用工程导出器从 JSON 生成，配置在 `config/test-delivery-template.json`：双工作表，第 5 行表头、第 6 行数据、冻结 D6，步骤与测试数据合并展示。设计版统一标「未执行」，实际结果与证据由报告阶段按 `case_id` 关联，不改设计版。表格内容与 JSON 不一致即校验失败——改 JSON 重导，不手改单元格。

## 预期依据

这是本阶段最容易被放水的地方，按顺序检查：

1. **逐句拆**。`expected` 里每个可判断的子句都要有来源；多子句用 `expectations` 逐句挂 `{text,kind,source:{type,ref,quote}}`。
2. **引用逐字**。`quote` 抄原文，不改写、不概括；`ref` 用本 run 内真实文件路径。
3. **引用存在 ≠ 语义成立**。原文只要求提示时，不能追加"停留当前页""不保存数据""返回 200""写入数据库"；页面实际行为不等于界面明确约束，更不代表服务端行为。
4. **没有来源的结论不进 `expected`**。可放 `observations:[{statement,kind,reason}]`，`kind` 取 `engineering_assumption` 或 `needs_confirmation`，不作为通过/失败标准。
5. **真正影响测试目标的歧义才提问**，写进任务结果文件的 `questions`；自己的推测不要去问用户，也不要为消除歧义把 `pending` 改成 `confirmed`。

## 测试数据表达

1. 样本只在 `test_data` 存一份；`steps` 用字段引用（如"在标题框输入 test_data.title"），字段名用 ASCII 标识符。
2. 空串、`null`、缺失字段、纯空白是四种不同输入：要空就明确写"清空并核对为空"，不能只写"保持为空"。
3. `false` 和 `0` 不等于"未提供"。
4. 刷新、跳转、重置后不沿用已失效的输入状态。
5. 精确边界写进 `data_checks`：上限 50 就用 51，诊断返回实际长度后再核对；不符就改样本，不把 51 改成 86 凑通过。
6. `unit` 只是测量口径，不是产品规则。原文只说"字/字符"时优先用普通 ASCII 字母，让各口径计数一致；不自行宣称"产品已确认按码点计数"。

## 设计方法

按需选用，不要求每条用例套全部方法：

| 场景 | 方法 | 用例要点 |
|---|---|---|
| 输入范围、格式 | 等价类 + 边界值 | 有效/无效各一条，边界取紧邻值 |
| 多条件组合 | 决策表 | 每个可行组合一条，不能把 AND 改成 OR |
| 状态流转 | 状态迁移 | 合法迁移、禁止迁移、失败后状态 |
| 完整流程 | 场景法 | 关键检查点，不只看最后跳转 |
| 表单、列表、弹窗、开关 | 控件场景 | 必填、格式、长度、禁用态、默认值、空数据态 |
| 业务权限 | 角色矩阵 | 无权限不可见、不可操作、不可越权调用 |

## 锚点与资产引用

- 页面锚点、元素定位、测试数据与断言资产只引用 verified 条目；`asset_refs` 记录资产 ID 与版本。
- 禁自造选择器：CSS/XPath/坐标、凭经验猜的框架类名都算自造。
- 缺 verified 锚点时在用例里注明缺口并上报队长安排探索，不用猜测的定位补齐，也不为可执行降低预期。
- 没有访问过产品时只写测试设计，不声称已观察实现。

## 功能轨与接口轨分流

- 派发指明只做功能或只做接口时，只写那一条链路的用例。
- 逐条标 `execution_layer`：功能 `ui`、接口 `api`，不写 `both`，不把同一条复制两套。
- 接口用例保留 `case_id` 与来源，用 `api_scenario` 表达可执行步骤与断言，文件包装 `api_plan` 表达 scope、并发与写授权引用；参数、预期、状态码都要有来源，不臆造。
- 标题与交接标明「功能」或「接口」；另一轨由关联子流程处理，不跨 run 拼接资料。

## 工作步骤

1. 读派发单，确定 run、范围、条数上限、轨别、任务形态。
2. 读测试点与台账，建映射；先保高风险测试点各至少一条用例。
3. 逐条写：前置、数据、步骤、预期、优先级、类型、可自动化。
4. 保存草稿：
   - 一次能写完直接写完整 JSON。
   - 条目多按批保存：先查草稿指纹拿 `sha256` 与条目数，再按批 upsert，每批 1–20 条完整用例，`request_id` 每批固定唯一，`base_sha256` 用上次返回值（首批 `missing`）。
   - 修订只提交问题 ID，冲突先查回条目再合并，禁止整份重写。
5. 自检诊断（只传 `run_id`）：看 `result.status`，不看外层 `completed`；一次改完 `errors` 与数据/语义提示。
6. 导出 Excel（只传 `run_id`），不手改表格。
7. 阶段校验 `stage=test_cases`：Excel 与 JSON 逐项一致，失败改 JSON 重导。
8. 交接：测试点覆盖数、未覆盖项、未决预期、自动化判断。

## 自检清单

1. 每条 `related_test_point` 真实存在，每个测试点至少一条用例
2. `design_contract` 三个子字段齐全，`basis` 的 `rule_id` 在台账里存在
3. 每个预期子句有逐字引用，没有自行追加的结论
4. `test_data` 里的每个字段在步骤或前置条件里被真实使用
5. 边界与金额的精确值在 `data_checks` 里，且与样本一致
6. 未确认、未验证的部分在 `assumptions` / `observations` 里标出

## 不要做

- 不执行测试、不判缺陷、不出报告。
- 不把步骤复述成预期，不写"系统正常""功能可用"这类无法判定的预期。
- 不为凑条数删掉必要的异常或边界用例，也不一对多关联、复制用例。
- 不改测试点或台账来消掉诊断报错。
- 不跑 curl、浏览器、自编请求去"确认一下"，也不跑临时脚本数长度。
- 不手改导出的 Excel，不安装依赖只为导出表格。
