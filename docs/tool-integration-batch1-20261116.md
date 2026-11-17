# 第 1 批：统一工具执行通道（实施记录）

日期：2026-11-16。工作分支：`codex/stage-tool-integration`（隔离 main 工作树）。

## 阶段、场景与输入边界

可机读映射在 `scripts/stage-tool-scenarios.mjs`，覆盖中央登记的 33 个工具 ID。派发提示词从这份映射按阶段生成，列明触发场景、真实输入、预期结果和接线状态；不能仅凭后台登记或 action 闸门宣称工具已经运行。一个工具可能有多种触发场景，例如 `regression.select` 分别用于首次执行准备、回归和发版；`defect.evidence` 仅在真实执行失败时触发。

| 阶段/场景 | 触发与工具 | 输入与失败处理 | 当前接线判定 |
| --- | --- | --- | --- |
| 需求：口述 | 口述原文归档后解析、条款化：`requirement.parse`、`knowledge.incremental` | 必须有 `inputs/` 快照和定位；无原文位置不能正式入库 | 来源适配待做 |
| 需求：文档/链接 | 上传文件或链接快照归档后同上 | 链接内容需保存快照；访问失败则要求补充来源 | 来源适配待做 |
| 需求：条款已抽取 | `requirement.testability`、`requirement.acceptance`，随后 `requirement.completeness`、`irval.check` | Python 工具需 `expected`、`preconditions`、`acceptance` 等 IR；现有 `requirement-ledger.json` 只有条款、状态和引用，不可臆造缺失字段。error 阻止交接 | Node 台账与引用诊断已运行；Python IR 适配待做 |
| 测试点 | 需求确认后 `testpoint.matrix`；导出前 `testpoint.coverage`、`irval.check` | 当前需求台账及测试点 JSON 自动对账；v3 IR 校验仍需完整 IR | Node 覆盖检查自动运行；Python v3 IR 待适配 |
| 用例 | 编制和导出前 `expected.provenance`、`plan.gates`、`irval.check` | 原文依据、计划 IR、用例 IR；来源不明或五闸未通过则阻止交接 | Node 溯源已有实现；Python 计划 IR 待接 |
| Web 探索/执行 | 有授权和页面时 `dom.snapshot`、`login.captcha_chain`；回归时 `regression.select`、`regression.impact` | 浏览器真实 DOM、截图、批准用例和版本差异；无法登录或验证码需停在人工处理 | Browser Driver 与 IR 适配待核对 |
| 接口执行 | 接口场景获批后 `exec.api_engine`、`exec.pools`、`execution.stub`、`regression.select` | 真实环境、凭据引用、用例和预算；失败产生真实回执 | 现有 Node 引擎待同构核对 |
| 缺陷 | 仅失败时 `defect.evidence`、`defect.tools`、`defects.cluster` | 当前封存失败结果和缺陷记录用于展示聚类；Python 取证工具仍需 exec IR | Node 聚类自动运行；Python exec IR 待适配 |
| 报告 | 冻结执行结果后 `report.reviewer`、`coverage.split`、`m1.consistency`；回归/发版才调用 `release.probe` | 封存结果用于覆盖拆分和 M1 诊断，单次执行的一致率为未知；Python reviewer 仍需 exec IR | Node 两项自动运行；Python facts 待接 |
| 横切 | 建档/派发/确认时 `onboard.bootstrap`、`plan.phases`、`agent.contract`、`confirm.gate`、`data.lifecycle`；资产变更时 `assets.library`、`expectation.audit`；排错时 `trace.view`、`golden.run` | manifest、确认记录、资产版本或固定样本；缺确认拦执行 | 现有 Node 流程待逐项记录真实执行证据；建档属后续批次 |

目标调用方约定：来源解析器负责归档和提取，专业 Agent 只补充解释与缺口；阶段导出/验证动作由控制器组装已归档输入并调用规则工具；Web/App Driver 和接口引擎负责真实执行；执行失败处理器负责即时取证；报告导出器只读取冻结结果。当前尚未完成所有自动触发，不能将此目标约定当作已上线行为。Agent 不应选择何时触发硬校验，也不能把自行拼写的结果当工具回执。正常无失败时缺陷取证不触发，非回归/发版时回归影响和发版探针不触发；这些属于场景条件，不应造成“缺少工具调用”的假警报。

本批先修复了 `expected.provenance` 的阶段名错误：实际阶段是 `test_cases`，原闸门检查 `case`，导致 `validate_artifacts` 漏拦，`diagnose_test_cases` 和 `export_test_cases` 的 `when` 也不会成立。现在停用该工具时，诊断、导出、验证、完成、交接和批准用例阶段都会被闸门拒绝，不能从交接侧绕过。这里的闸门仍是**依赖纪律**，不计作 Python 工具执行。

下一步的落点是给每种 IR 建立从已归档、经确认的 run 产物读取的确定性适配器，并在阶段导出/验证入口自动触发相应工具，保存输入文件哈希和回执，失败阻止后续阶段。适配前不可把 10 个可调用工具称为阶段闭环；真实项目的登录—新建测试用户—核对—删除测试用户验收需等用户提供环境。

已补通一条旧产物的确定性链：`validate_artifacts(test_cases)` 在阶段产物契约中自动执行 Node `expected.provenance`，记录检查结果、用例 JSON 哈希、引用的已归档原文哈希和实现文件哈希。失败使阶段验证受阻；成功时动作回执包含 `tool_checks`，后台实际执行次数才增加。`complete`/`handoff` 再检验同一契约，并将检查结果封入阶段完成证据。这里的检查只证明引用位置和状态自洽，不能证明引用语义正确；旧用例没有记录依据时会报告 `not_recorded` 数量，仍遵守现有兼容策略。此实现是现有 Node 工具，不能标记为 Python `irval.check` 或 `plan.gates` 已执行。

需求分析的有效台账会自动运行 Node `requirement.completeness`，阶段回执保留输入哈希、实现哈希、可判定性、分母与缺口警告；没有适用需求时标为 `not_applicable`，停用时标为 `skipped`，两者均不计入实际执行次数。它是完备性提示和报告分母依据，不把发现的结构性缺口直接等同于用户需求错误。报告生成时若后台停用该工具，旧结果和现场重算都不参与本轮结论。

报告阶段的有效设计用例和封存执行结果会自动运行 Node `coverage.split`，把已执行与仅分配的数量和输入文件哈希写入阶段契约；停用时标为 `skipped`。报告展示优先基于当前输入计算；当前输入存在但已失效时，不再退回读取旧的完备性或覆盖度 JSON。以上三个 Node 检查都保留了具体实现身份，不借它们冒充相应 Python IR 工具已接入。

完成事件中的 Node 检查在下游派发时也作为上游来源列出，定位为 `manifest.json` 的完成事件和检查索引；读之前会重新比对完成契约内的文件哈希。任何上游产物被改动，该条来源不再向下游提供。

`validate_artifacts` 和真正完成的 `handoff`/`complete` 都会记录本次成功执行的 Node 检查；重复读取已完成交接不新增调用次数，失败检查留在动作回执但不计作成功。

测试点阶段在提交和交接时调用 `scripts/test-point-diagnosis.mjs` 对当前台账与测试点双向核查，缺失规则 ID 写入 `testpoint.coverage` Node 回执并阻止流转；后台停用该硬校验时相应验证与完成动作被拒绝。执行准备动作运行既有 `select-test-cases.mjs` 后记录 `regression.select` 的输入、策略和选集哈希，不能把“闸门放行”计为选集已生成。

后台工具详情现可按最近 run 和阶段查看检查状态、动作、输入/输出哈希和安全摘要；检查失败、跳过及不适用也留在检查流水中，但成功调用计数只来自成功执行。回执路径可以进一步定位控制器的原始动作记录。该流水是可观察性记录，不代替 run 内阶段完成证据。

实际 `browser_task.snapshot` 成功且浏览器证据回执绑定本次命令时，控制器记录 `dom.snapshot` 调用；同一 request_id 的重复读取不新增调用。缺陷阶段仅有真实失败结果时用 `defect-cluster.mjs` 生成展示分组，保留原缺陷单不变。报告阶段以封存结果运行 `consistency-report.mjs`，单次执行或无失败时保持 `unknown` / `not_applicable`，不得把 M1 诊断当成已达标。所有这些回执都注明 Node 实现，不冒充 Python v3 IR 工具。

独立 task 的测试用例产物契约现也调用同一份 Node `expected.provenance` 实现；来源只限该 task 明确列出的 `source_paths`，并检查可选断言的确认状态，失败会阻断该 task 验证。需求完备性和报告覆盖度的自动检查仍只对具备相应完整台账及封存执行结果的 lifecycle 产物运行；不能把 lifecycle 的结果推断为所有独立任务也已覆盖。

运行时另有前提：阶段 Python 工具要求 Python 3.11+。本机 PATH 上的 Python 是 3.9.7，验证使用 Codex 自带的新版 Python，正式部署不能依赖该缓存路径；需要随应用提供兼容运行时或在安装配置中显式指定，才能在独立实例上验收。
阶段调用入口已增加解释器版本探测：配置成 3.9 时会明确拒绝，不能把运行时错误当作工具业务结论。

## 已接通的最小纵向链

`project-action.run_stage_tool` 校验当前 run、阶段和派发归属后，只允许调用白名单中的确定性实现。输入可用 `source_path` 从 run 内已保存的 JSON 文件读取，回执记录来源路径与文件哈希；已有 `payload` 入口保留给完整且可核对的输入。两者只能选一个。输入按工具 ID 校验 JSON 字段；Python 入口不接受动态模块名或任意脚本。一次执行生成 `audit/stage-tools/<id>.json`，记录工具 ID、阶段、后台契约版本、实现文件与哈希、输入哈希、结果或错误码。后台启停在调用前生效；后台“调用次数”只统计成功执行且有回执的调用，不再把通过流程闸门当成工具实际运行。失败执行保留工具回执但不进入成功次数。工具详情页可查看最近成功执行的 run、阶段、回执路径和实现哈希。

专业 Agent 的派发契约列出该阶段可调用的工具和输入形状。已完成的上游阶段工具回执会在下游派发时列出，供下游按来源读取；未完成或损坏的回执不进入来源列表。工具结果由执行器写入，Agent 不得自行改写。

| 阶段 | 本批可真实调用的工具 |
|---|---|
| 需求分析 | `requirement.testability`、`requirement.acceptance`、`irval.check` |
| 测试点 | `testpoint.coverage`、`irval.check` |
| 测试用例 | `plan.gates`、`irval.check` |
| Web/接口执行 | `plan.gates`、`regression.impact`、`regression.select`、`irval.check` |
| 缺陷 | `defect.evidence`、`defect.tools`、`irval.check` |
| 报告 | `report.reviewer`、`regression.impact`、`regression.select`、`irval.check` |

这里的“可调用”仅表示实现、阶段权限和回执已接通。旧工程阶段产物与 v3 IR 字段不完全一致；无适配输入时不得把旧 JSON 直接提交给新校验器，也不得宣称该阶段已通过工具校验。

## 第 1 批收口判定与后续依赖

本批的验收口径是：在**当前工程实际产物契约**下，需求、测试点、用例、Web 执行、接口执行、缺陷和报告各阶段至少有一个按场景自动触发的确定性工具；执行、跳过、部分结果及失败可从 run 和后台追溯；硬校验失败阻止相应交接。已完成的实际调用见上文和下述续建记录。这个判定只覆盖统一执行通道与现有产物，不等于中央登记的 33 个工具都已在任意项目执行，也不等于 v3 IR 契约已迁移。

后续项目按下面的输入依赖推进；缺少对应场景或可信输入时保持 `pending`/`not_applicable`，不得将其计成成功调用：

2026-11-17 续建：`read_source` 读取 `inputs/*.md|*.markdown|*.txt` 时会同时返回所选行中的章节与带原文行号的条款，供需求 Agent 在编写台账前使用。正式产物检查也会对已登记并校验引用的纯文本快照调用 Node `requirement.parse`，记录每份来源的哈希、章节数、条款数、引用数和实现哈希；停用或不支持的格式分别记为 `skipped`、`not_applicable`。它只识别原文结构，不生成或批准需求规则。其余文件格式、链接抓取与 `knowledge.incremental` 尚未接入，不能将这条来源检查称为完整来源适配。

归档 DOCX 的 `extract_word` 成功后也记录 `requirement.parse` 回执，绑定原文件、定位元数据和提取文本的哈希；原件保持不变。该实现是工程已有的受控 Python 提取器，保留段落/表格定位并明确提示图片、页码和修订等限制；提取后的 `.docx.txt` 可继续按纯文本读取和引用。

接口 `api_task collect` 现核对 Node API 引擎保存的设计、结果汇总、请求数量和每份请求证据哈希后，记录 `exec.api_engine` 的真实执行回执。只有封存且至少发出一次请求才计成功调用；部分结果和零请求分别标为 `partial`、`not_applicable`。此回执证明实际接口执行，不冒充 Python `exec/api_engine.py`，也不代表五闸、回归影响或资源池已运行。

`export_report` 成功生成时记录 Node `report.reviewer` 回执，将封存结果、问题记录和生成的事实正文哈希绑定；复用既有封存导出不重复计数。这里审阅工具实际完成的是事实正文装配，不包含 Python v3 exec IR 的 `extract_facts` 或模型洞察。

1. v3 IR 工具包与当前阶段 JSON 不是同一契约；`requirement.testability`、`plan.gates`、`report.reviewer` 等只有完整 IR 时才能调用。迁移旧产物为 v3 IR 是独立的契约升级工作，不能用空字段和模型臆造值伪适配。本批把这些标为 `ir_adapter_pending`，不宣称自动执行。
2. `requirement.parse` / `knowledge.incremental` 的文档与链接来源适配、`testpoint.matrix` 的产品维度种子、`defect.evidence` 的真实 exec IR、回归影响的变更来源和 `release.probe` 的构建输入仍需相应场景的数据及接口。无触发条件时为不适用，不是遗漏执行。
3. 后台已展示最近阶段检查摘要；原始完整结果仍在 run 的动作或工具回执里，后台暂不直接展开包含潜在敏感数据的完整原始回执。
4. 真实业务登录—新建测试用户—核对—删除测试用户验收需要用户后续提供环境；合成测试不能替代该验收。

## 已完成验证

十个白名单工具均执行了真实 Python 实现的合成输入验证；`run_stage_tool` 的分析阶段端到端动作验证、阶段权限护栏及既有结构化动作回归通过。合成验证不代表真实项目执行。
