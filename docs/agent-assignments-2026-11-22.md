# 四 Agent 并行建设任务分配（2026-11-22）

## 全局背景

AITestHarness 是基于 PenguinHarness 的软件测试智能体平台。当前已完成重构方案（`docs/AITestHarness测试任务与认知资产重构方案-2026-11-21.md`）中约 60% 的可安全落地项（33 个提交在本地 main）。剩余工作按依赖关系分为六个流，分配给四个 Agent 并行执行。

**核心架构上下文**（所有 Agent 必读）：
- 平台基于 PenguinHarness 宿主 + 本平台 server/web/desktop 三包（pnpm workspace 在 `platform/`）
- 引擎脚本在 `scripts/`（Node.mjs）+ `aitestharness-tools/`（Python）
- 智能体定义在 `penguin/agents.json` + `penguin/agents/<id>/AGENTS.md`
- Skill 定义在 `skills/<name>/SKILL.md`
- 数据库用 SQLite（schema 在 `platform/packages/server/src/db/schema.ts`，迁移在 `db/migrations/steps/`）
- 确认门禁三层：内容指纹 diff → 确定性抽样 → 风险分级强制
- IR 契约规范在 `docs/AITestHarness-IR契约规范-v1.md`，校验器在 `aitestharness-ir/irval/`

**当前已部署版本**：`2c5895f` 等价内容（通过用户验收）。后续提交待合并部署。

---

## 分支策略

每个 Agent 从 `main` 最新提交创建自己的功能分支：

```
git checkout -b feat/stream-X-<描述> main
```

- 分支命名：`feat/stream-a-webui`、`feat/stream-b-ir-prompts`、`feat/stream-c-engine-validation`、`feat/stream-d-execution`、`feat/stream-e-backend`、`feat/stream-f-exploration`
- **不要直接在 main 上提交**
- 完成后提交到自己的分支，写清楚 commit message
- ZCode 负责验收合并到 main

---

## Agent 1：WorkBuddy → 流 A（Web UI 视图补全）

### 你负责什么

纯前端改造——8 个 UI 组件/视图，全部在 `platform/packages/web/src/features/qa/` 目录下。不碰 server 端代码、不碰 schema、不碰 penguin/ 目录。

### 改什么

| # | 组件 | 文件 | 说明 |
|---|---|---|---|
| A1 | 产物按修订轮次分组 | `task-detail.tsx` | runs 列表按修订 attempt 加分组标题（"第 1 轮"/"修订 v2"），替代平铺展示 |
| A2 | 项目缺陷台账视图 | `project-view.tsx` 或新组件 | 项目维度缺陷列表（缺陷id/标题/严重度/生命周期状态/关联用例/操作按钮），数据从各 run 的 defects 聚合 |
| A3 | 指标面板 | `project-view.tsx` 或新组件 | 展示用例总数/已执行/通过率/缺陷严重度分布/高严重度计数，数据从已有 run 数据计算 |
| A4 | 系统地图内嵌视图 | `project-knowledge-page.tsx` | 资料页"系统地图"子菜单点击后内嵌展示探索产出（页面清单/路由/接口清单/覆盖率），数据从环境端点拉取 |
| A5 | 历史档案内嵌视图 | `project-knowledge-page.tsx` | 资料页"历史档案"子菜单点击后内嵌展示历次 run 产物列表（run_id/报告/用例/缺陷，只读） |
| A6 | 复测范围选择 UI | `platform-tasks-page.tsx` 或抽屉 | 复测轮次创建时展示三层范围选择（缺陷关联用例列表/regression-impact 选集/冒烟子集），用户勾选后提交 |
| A7 | 执行授权逐通道列明 | `task-detail.tsx` 执行确认区 | 授权界面按通道（端×类型×环境）列明目标环境与数据影响 |
| A8 | 报告按端分节 | 报告渲染组件 | 报告页按涉及端分节展示（各端结论/未测范围/风险） |

### 怎么改

- 现有组件风格保持一致（className 前缀 `qtd-` / `qp-` / `qpm-`）
- 所有新组件写 TypeScript，不用 any
- 数据获取用 `apiFetch`（`../../api/client`）
- 新端点如果后端没有，先在组件中用 placeholder 空态展示（后端由 Agent 3 并行补）
- 不引入新依赖

### 验收

- `npx tsc --noEmit -p tsconfig.json` 通过
- `vitest run test/platform-tasks-page.test.ts test/required-mark.test.ts` 通过
- 每个组件写一个基本渲染测试

---

## Agent 2：qoder → 流 B（IR 契约 + 提示词 + Skill）

### 你负责什么

schema 扩展 + 阶段智能体提示词更新 + 新建两个 skill。全部在 `schemas/`、`penguin/agents/`、`skills/`、`config/` 目录下。不碰 web 前端、不碰 server 路由。

### 改什么

| # | 文件 | 说明 |
|---|---|---|
| B1 | `schemas/test_point.schema.json` + `schemas/test_case.schema.json` | 加 `end` 字段（string，枚举：web/web_admin/app/miniprogram/desktop/api 或空串=未指定） |
| B2 | `aitestharness-ir/irval/` 测试用例 | 补充 end 字段的合法值/缺省/多端用例 |
| B3 | `penguin/agents/requirement_analysis_agent/AGENTS.md` | 加：产物带端标签；每个测试点/规则必须挂锚点引用（页面/接口/代码三选一）；挂不上的标"暂不可测" |
| B4 | `penguin/agents/test_point_agent/AGENTS.md` | 同上：测试点带端标签和锚点引用 |
| B5 | `penguin/agents/test_case_agent/AGENTS.md` | 用例步骤只引用 verified 锚点与资产 ID；禁止自造选择器 |
| B6 | `penguin/agents/automation_execution_agent/AGENTS.md` | 只引用 verified 锚点与断言资产；缺资产 → blocked 并列缺失清单 |
| B7 | `penguin/agents/api_automation_agent/AGENTS.md` | 同上原则 |
| B8 | `skills/requirement-analysis/SKILL.md` frontmatter | tools 从 `["requirement.testability","requirement.acceptance","irval.check"]` 语义改为"阶段收口校验清单"（在注释中说明） |
| B9 | `skills/anchor-verification/SKILL.md` | 新建：验证测试点锚点引用在系统地图中真实存在 |
| B10 | `skills/change-analysis/SKILL.md` | 新建：从 diff 提取变更情报（变更模块/风险点/测试建议/候选契约更新） |
| B11 | `config/orchestration-workflow.json` | 如需调整（如 api_execution 并入 execution 通道）则同步 stage-registry |

### 怎么改

- AGENTS.md 的修改保持现有格式和纪律（不删既有规则，只新增/修改指定条目）
- schema 修改用 JSON 编辑，保持缩进和排序一致
- 新 skill 的 SKILL.md 格式参照 `skills/test-selection/SKILL.md`
- 所有修改跑 `node scripts/check-skills.mjs` 验证
- 所有 schema 修改跑 `cd aitestharness-ir && python -m pytest tests -q` 验证（irval）

### 验收

- `node scripts/check-skills.mjs` 通过
- `node scripts/check-tool-contract.mjs` 通过
- `cd aitestharness-ir && python -m pytest tests -q` 通过

---

## Agent 3：trae → 流 D（执行引擎改造）

### 你负责什么

执行引擎核心改造——6 个条目，全部在 `scripts/` 目录下的执行相关脚本。这是最大的单流，需要理解现有执行流程。

### 先理解现有执行流程

```
用例确认 → execution-plan.mjs（生成执行计划）
→ approve（执行授权门禁）
→ prepare_execution_plan（生成脚本，mode=prepare）
→ validate_execution_prepare（脚本校验）
→ 执行（browser-task.mjs 或 local-browser-executor.mjs）
→ 结果落盘 execution/attempts/<invocation_id>/
→ 质量指标 build-quality-metrics.mjs
```

### 改什么

| # | 脚本 | 说明 |
|---|---|---|
| D1 | `scripts/execution-plan.mjs` + 新文件 | 脚本资产化：首跑通过→脚本登记 candidate 资产（调 test-asset-catalog.mjs 的 registerExplorationCandidates 同模式）；绑定 用例版本+锚点版本+环境版本；复跑直接用 verified 脚本零生成；失效增量再生 |
| D2 | `scripts/local-browser-executor.mjs` | 托管浏览器：Playwright 启动配置改为版本受控（browsers.json 锁版本）、上下文隔离（每个 worker 独立 context）、headless 批量/headed 登录卡片 |
| D3 | `scripts/execution-runner.mjs` 或新文件 | 分片并行调度：按模块×数据画像分片，片内按池容量并行（读 config/pool-capacity.json），resource_keys 跨片串行，批次检查点可恢复 |
| D4 | `scripts/execution-plan.mjs` | 优先级分层：用例 schema 加 priority 字段，冒烟子集快速反馈，全量回归进批量窗口 |
| D5 | `scripts/execution-runner.mjs` | 环境级互斥：跨端共用环境按环境锁串行（环境是共享资源，锁挂环境不挂任务） |
| D6 | 新文件 `scripts/grounding-driver.mjs` | grounding 三后端 driver 抽象：结构层（DOM/UIA 控件树+≥2指纹锚点，零模型）→ 语义层（Midscene 混合，命中降级为结构锚点）→ 视觉层（computer-use 兜底），命中必须反查结构锚点 |

### 怎么改

- 先读 `scripts/execution-runner.mjs` 和 `scripts/local-browser-executor.mjs` 理解现有执行流程
- 每个改动独立提交（D1-D6 各一个 commit）
- 不改变现有执行的输入输出格式（execution/attempts/ 结构不变）
- 分片并行的池容量读 `config/pool-capacity.json`（B5-3 已实现加载逻辑）
- grounding 后端按 v2.3 方案 §5.2 的 driver 抽象实现

### 验收

- `node --check` 每个修改的脚本
- 现有执行相关契约测试通过（`test/acceptance/execution-attempts.test.mjs` 等）
- D3 分片并行写一个基本测试验证并行度

---

## Agent 4：ZCode（我）→ 流 C + 流 E + 流 F + 合并验收

### 我自己做什么

| 流 | 条目 | 说明 |
|---|---|---|
| C1 | 引擎收口批量校验 | approve 时自动跑 stage_finalize 逻辑 |
| C2 | 违规清单定向重派 | 校验不通过→自动带违规清单 revise_stage 一次 |
| C3 | 修订同会话续接 | revise_stage 改 input_subagent 续接 |
| C4 | 修订简报装配器 | 重启路径装配 |
| C5 | attempt 登记单位 | qa_runs 或新表记录 attempt |
| E1-E8 | 后端服务补全 | origin 登记/写守卫/引用追踪/上游映射/diff/复测挂回/例行对账/环境互斥 |
| F1-F3 | 探索派发通道 | origin: environment 作业 |
| 合并 | 验收合并全部 Agent 分支 | |

---

## 每个 Agent 完成后的交付要求

1. **提交到自己的分支**（不在 main 上直接提交）
2. **写一份变更文档**放在 `docs/` 下（命名 `stream-X-report-2026-11-22.md`），包含：
   - 修改了哪些文件（路径 + 行号范围）
   - 每个文件改了什么（新增/修改/删除）
   - 新增了哪些 API 端点或函数
   - 依赖了哪些已有机制
   - 测试结果（哪些测试通过/新增了哪些测试）
   - 已知限制或待完善项
3. **通知 ZCode 验收合并**

## ZCode 合并流程

1. 审阅每个 Agent 的变更文档
2. 检查代码质量（typecheck + 契约测试）
3. 检查文件冲突（不同流不应碰同一文件）
4. 合并到 main
5. 跑全量 `npm test`
6. 按手册部署
7. 用户逐章验收

## 冲突预防

| 文件 | 归属 | 说明 |
|---|---|---|
| `task-detail.tsx` | Agent 1 (A1/A7) | ZCode 不再改此文件 |
| `project-view.tsx` | Agent 1 (A2/A3) + ZCode 已改（B5-4） | Agent 1 基于 ZCode 最新提交改 |
| `project-knowledge-page.tsx` | Agent 1 (A4/A5) + ZCode 已改（B3） | 同上 |
| `platform-tasks-page.tsx` | Agent 1 (A6) + ZCode 已改（B8-4/B5-2） | 同上 |
| `structured-actions.mjs` | Agent 3 (C1-C5) | ZCode 已有 stage_finalize 基础 |
| `approve-design-stage.mjs` | Agent 3 (C1) | ZCode 已有 failed 工具回执拒绝 |
| `schemas/test_point.schema.json` | Agent 2 (B1) | 独占 |
| `schemas/test_case.schema.json` | Agent 2 (B1) | 独占 |
| `penguin/agents/*/AGENTS.md` | Agent 2 (B3-B7) | 独占 |
| `scripts/execution-*.mjs` | Agent 3/4 (D1-D5) | 独占 |
| `server/src/services/` | Agent 4 (E1-E8) | 独占（不同服务文件） |

**规则：每个 Agent 只改分配给自己的文件。如果需要改动其他流的文件，在变更文档中标注"需要流 X 配合"，由 ZCode 统一协调。**
