# Agent 提示词与 Skill 优化任务书

- 日期：2026-11-19
- 委托方：项目负责人（用户）
- 执行者：本地 Agent（本文档接收方）
- 性质：**梳理评审任务**——产出核查表、评审意见与修改稿提案；**不直接实施代码/提示词变更**（见 §6 约束）

---

## 1. 背景与语境（先读懂再动手）

1. **盘点底稿已有、优化从未实施**：`docs/agent-skill-prompt-inventory-2026-11-13.md` 已完成 11 个 Agent + 15 个 Skill 的职责/绑定/提示词要求盘点；但 `penguin/agents/`、`penguin/agents.json`、`skills/` 自全量入库提交后**零改动**，优化从未落地，且差距盘点（`docs/gap-inventory-20261116.md`）此前漏登此项（已有本地补登提交）。
2. **技术方向已变更（2026-11-18 定稿）**：执行层改为 computer-use 引擎 + MCP 协议，见 `docs/AITestHarness执行引擎与MCP架构方案-v1.md`。skill 体系定位变为「知识包瘦身」（方案 M6 批次）。**因此执行类提示词/skill 的重写必须等引擎与 MCP 工具面定型（M1-M3 完成后），现在做必然返工。**
3. **但意图层与知识层与引擎无关**，可以且应该现在梳理——意图层 agent 正被条款化→测试点→用例链路（建设中）消费，提示词质量直接决定链路产出质量。

## 2. 对象全景（与盘点底稿对应）

**11 个 Agent**（`penguin/agents.json` + `penguin/agents/<id>/AGENTS.md`，公共提示词 `penguin/command-runtime.md`）：

| 类 | Agent | 处置 |
|---|---|---|
| 入口 | `default_agent` | 微调（角色边界表述） |
| 总控 | `test_agent` | 评审（当前不绑定任何 active skill，确认是否有意为之） |
| 意图层 | `requirement_analysis_agent` / `test_point_agent` / `test_case_agent` | **本轮重点：评审 + 出修改稿** |
| 执行类 | `automation_execution_agent` / `android_test_agent` / `miniprogram_test_agent` / `api_automation_agent` | **只登记问题，不重写**（等引擎定型，M6） |
| 结果类 | `defect_analysis_agent` / `test_report_agent` | 评审（依赖知识包，不依赖引擎） |

**15 个 Skill**（`skills/<name>/SKILL.md`）：

| 分类 | Skill | 本轮动作 |
|---|---|---|
| 知识包（拟保留） | test-design-methods、requirement-analysis、test-point-design、test-case-writing、api-testing、api-contract-analysis、bug-reporting、qa-investigation、test-report-writing | 内容质量评审 + 与绑定 agent 提示词的重复/冲突核查 |
| 执行编排（等重写） | playwright-execution、android-execution、miniprogram-execution、api-test-execution | 只登记「依赖旧底座的具体表述」（工具名/动作集/证据路径），清单化，不改写 |
| 未绑定（裁决） | test-asset-management、test-selection | 给出「保留/启用/归档」建议与理由（初判：前者可留作资产登记规范；后者与回归选集相关，建议 M4 剧本固化后再启用） |

## 3. 任务清单（按优先级）

### T1 工具引用一致性核查（最高优先，与引擎无关）

逐个核对 11 个 `AGENTS.md` + `command-runtime.md` 中引用的**运行时事实**与代码现状是否一致：

- 工具/动作名：如 `api_task` 的 `inspect_contract/prepare/start/status/collect/cancel/resume`、`run_subagent`、`validate_artifacts(stage=...)`——在 central-tools 注册表（33 个工具）与服务端代码中逐一确认是否存在、签名是否一致；
- 凭据引用：`qa-secret://` 协议是否真实实现、指向何处；
- 产物路径与校验：提示词声称的产物目录、`stage` 取值全集是否与服务端校验逻辑一致；
- 输出：**核对表**（引用原文位置 → 实际实现位置 → 状态：一致 / 漂移 / 缺失 / 提示词虚构），每条漂移附一句影响说明。

### T2 意图层 3 个 Agent 提示词评审 + 修改稿

- 评审维度：① 与公共提示词（command-runtime.md）的重复与冲突；② 与绑定 skill 内容的分工是否清晰（提示词管行为约束、skill 管方法论）；③ 产出契约（需求基线/测试点/用例的结构要求）与 IR 契约规范（`docs/AITestHarness-IR契约规范-v1.md`）是否对齐；④ 语气与硬约束（不伪造、留证据、unknown 是正式结论）是否一致。
- 产出：每个 agent 一份**修改稿全文**（新文件中给出，不改源文件）+ 修改点说明清单。

### T3 知识包 9 个 Skill 内容评审

- 逐个检查：内容是否过时（引用的工具/流程与 T1 核对结果一致吗）、与 agent 提示词是否重复、版本号是否需要升级；
- 产出：每 skill 一段评审意见（问题清单 + 建议动作），不改源文件。

### T4 执行类 4 Skill + 4 Agent：旧底座依赖登记

- 只做登记：列出每个文件中所有「绑定 Playwright/ADB/微信开发者工具/HTTP worker 具体动作集」的表述位置，形成《M6 重写输入清单》——将来引擎定型后，重写者拿这份清单即可逐点替换；
- 产出：登记表，不写新提示词。

### T5 未绑定 2 Skill 裁决建议 + `test_agent` 空 skill 绑定确认

- `test-asset-management` / `test-selection`：保留、启用时机、绑定对象建议；
- `test_agent` 不绑定任何 active skill（有 11 个 retired）：确认这是迁移残留还是有意设计，给出建议。

## 4. 产出物（合并为一份报告）

新建 **`docs/prompt-skill-review-20261119.md`**，结构：

```
1. T1 工具引用一致性核对表（含状态统计：N 一致 / N 漂移 / N 缺失）
2. T2 意图层 3 agent 修改稿（全文）+ 修改点说明
3. T3 知识包 9 skill 评审意见
4. T4 执行类旧底座依赖登记表（M6 重写输入清单）
5. T5 裁决建议
6. 结论与实施建议（哪些可直接采纳、哪些需确认）
```

## 5. 关键文件路径索引

| 内容 | 路径 |
|---|---|
| Agent 注册 | `penguin/agents.json` |
| 公共提示词 | `penguin/command-runtime.md` |
| 各 Agent 提示词 | `penguin/agents/<agent_id>/AGENTS.md` |
| Skill 定义 | `skills/<skill_name>/SKILL.md` |
| 盘点底稿 | `docs/agent-skill-prompt-inventory-2026-11-13.md` |
| IR 契约规范 | `docs/AITestHarness-IR契约规范-v1.md` |
| 引擎与 MCP 方案 | `docs/AITestHarness执行引擎与MCP架构方案-v1.md` |
| 差距清单 | `docs/gap-inventory-20261116.md` |
| 工具注册表 | central-tools 相关（服务端 `platform/packages/server` 内 33 工具注册代码） |

## 6. 约束（红线）

1. **只产出评审报告与修改稿提案，不改任何源文件**（`penguin/`、`skills/`、`platform/` 一律不动）——实施与否由项目负责人确认后另行安排；
2. 执行类提示词/skill **不重写**（等 MCP 方案 M1-M3 定型后按 M6 做）；
3. 开工前先 `git pull` 对齐远端 main（远端近期有 Codex 提交，注意工作区干净）；
4. 引用原文一律带文件路径 + 行号，便于复核；
5. 所有结论区分「事实（代码可证）」与「判断（需人工确认）」，不得虚构工具名、路径或提交号。

## 7. 验收标准

- [ ] T1 核对表覆盖全部 11 agent + 公共提示词，每条引用有状态结论；
- [ ] T2 三份修改稿可直接 diff 应用，修改点逐条有理由；
- [ ] T4 登记表覆盖 4 个执行类 skill 的全部旧底座表述；
- [ ] 报告内所有路径/行号抽查可复核；
- [ ] 未修改任何 §6 约束内的源文件（`git status` 干净，仅新增报告文件）。
