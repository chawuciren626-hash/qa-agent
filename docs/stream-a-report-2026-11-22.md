# 流 A 实施报告（WorkBuddy，2026-11-22）

分支：`feat/stream-a-webui`（基于 main `9af26c6`，独立 worktree `E:\AItestHarness-stream-a`）
范围：纯前端，全部在 `platform/packages/web/`（`src/features/qa/` + `test/`），未触碰 server/schema/penguin/scripts。

## 提交清单（A1-A8 全部完成）

| 提交 | 条目 | 内容 |
|---|---|---|
| `1364b33` | A1 | 运行列表按修订轮次分组 |
| `3793412` | A2+A3 | 缺陷台账列增强 + 项目指标面板 |
| `6369acd` | A7+A8 | 执行授权逐通道列明 + 报告按端分节 |
| `d34c01f` | A4+A5 | 资料页系统地图/历史档案内嵌视图 |
| `1dbca4c` | A6 | 复测范围三层选择抽屉 |

## 逐条变更明细

### A1 产物按修订轮次分组
- `src/features/qa/task-detail.tsx`（约 L20-38、L178-187）：新增导出 `attemptGroups(runs)` 与 `RunAttemptGroup` 类型——attempt=1 → "第 1 轮"，≥2 → "修订 vN"，同轮合并为一组；`RunIndex` 增加可选 `attempt`/`attemptLabel` 字段；运行选择条改 `optgroup` 分组渲染；attempt 未登记时兜底平铺并显示提示（role=note）。
- `src/features/qa/task-detail.css`（L6 附近）：新增 `.qtd-runbar-hint` 样式。
- 依赖：后端 C5（attempt 登记单位，Agent 4）落地后 overview run 记录带 attempt 字段即自动生效，前端无需再改。

### A2 项目缺陷台账视图
- `src/features/qa/project-view.tsx`（缺陷清单 tab，约 L228）：表格列调整为 缺陷编号/缺陷标题/严重度/生命周期状态/关联用例/所属任务/操作；生命周期用 `defectStatusLabel`（quality-traceability-model）；来源阶段信息移入缺陷详情弹窗（新增"来源阶段"字段），状态字段统一改用 `defectStatusLabel`。
- 数据源：沿用现有 `qa/overview` 聚合的 `run.defects`（detail.lifecycle_status / related_cases），无新端点。

### A3 指标面板
- 新文件 `src/features/qa/metrics-panel.tsx` + `metrics-panel.css`：导出 `projectMetrics(tasks)` 与 `QaMetricsPanel`——用例总数/已执行记录/通过率（按已执行记录）/严重度分布/高严重度计数（Blocker+Critical，unknown/未记录不计入且单独展示）；全部由已校验 run 记录聚合，与缺陷清单同口径（跨运行重复如实求和）。
- 挂载点：`project-view.tsx` 的 `qp-stats` 与 `qp-tabs` 之间（`{data && <QaMetricsPanel tasks={tasks}/>}`）。

### A7 执行授权逐通道列明
- 新文件 `src/features/qa/execution-channels.tsx`：导出 `executionChannels(stageId, executionPlatform, environments)`（纯函数）与 `ExecutionChannelAuthorization` 组件——执行阶段确认区按通道（端×类型×环境）列明默认环境（来自 `listEnvironments`）与数据影响；多环境时提示"以运行计划为准"；无环境给警告；环境读取失败显示警告而非编造。
- `task-detail.tsx`（约 L195）：执行阶段且有 pendingConfirmationId 且 owner 时渲染在确认按钮上方。
- 依赖机制：`project-management/api.listEnvironments`、`EnvironmentView`。

### A8 报告按端分节
- 新文件 `src/features/qa/ends-report.tsx`：导出 `reportEndSections(markdown)`（纯函数，按 h2/h3 标题关键词归组 Web/接口/App/小程序/桌面，未识别归"总体"，保持文档顺序）与 `EndsReportSection` 组件——有端信息时渲染分端导航 + 分组；无端信息退化为普通渲染。
- `task-detail.tsx`（约 L202）：report 阶段的 markdown 渲染由 `StageMarkdown` 换为 `EndsReportSection`。
- 依赖机制：`stage-markdown.splitStageMarkdown/normalizeStageMarkdown`、`stage-localization.localizeGeneratedMarkdown`。

### A4 系统地图内嵌视图
- 新文件 `src/features/qa/system-map-view.tsx`：导出 `SystemMapView`——环境选择（多环境）、页面建档计数/已登记/登记覆盖率/接口计数、探索知识四层（模块/链路/墙点/接口）清单与接口模块 chips；`lastRound === 0`、无环境、页面/路由明细端点缺失均如实空态说明。
- 数据端点：`project-management/api.listEnvironments` + `getEnvironmentKnowledge`（均已存在，无新端点）。

### A5 历史档案内嵌视图
- 新文件 `src/features/qa/run-archive-view.tsx`：导出 `RunArchiveView`——只读表格展示历次 run（运行 ID/所属任务/状态/用例数/缺陷数/产物下载链接），产物链接走 `/api/sessions/:id/files/content`（与项目视图报告下载同模式）。
- 数据端点：`/api/projects/:id/agents/qa/overview`（已有）。

### A6 复测范围选择 UI
- 新文件 `src/features/qa/retest-scope-drawer.tsx`：导出 `retestCandidates(tasks)`（纯函数：缺陷 related_cases 去重 + P0 冒烟子集）与 `RetestScopeDrawer`（portal 抽屉）——三层范围勾选（缺陷关联用例/回归影响选集/冒烟子集）、实时计数、提交 `POST /api/projects/:id/agents/qa/platform-tasks/:taskId/retest`；回归影响层因端点未提供如实占位；retest 端点未上线时提交失败消息如实展示（404 → "Not Found"），不假装成功。
- `platform-tasks/platform-tasks-page.tsx`（约 L19、L88、L340 附近、L420 附近）：新增 `retestTarget` 状态；`result_returned` 状态任务行新增"发起复测"按钮；渲染抽屉。
- `platform-tasks/platform-tasks.css`：追加 `.qrs-*` 抽屉样式。

### 共用
- `src/features/qa/project-knowledge-page.tsx`：`Tab` 增加 `system_map`/`run_archive`；`TABS` 增两项；新增 `EMBEDDED_TAB_IDS`（嵌入任务面板外壳不显示新页签）；两个内嵌标题/说明映射补齐；取数 effect 对新页签跳过共享取数；渲染分支接入两个视图；导入 `knowledge-views.css`。
- 新文件 `src/features/qa/knowledge-views.css`：A4/A5 最小样式。

## 新增导出函数/组件汇总

`attemptGroups`（task-detail.tsx）、`projectMetrics`/`QaMetricsPanel`（metrics-panel.tsx）、`executionChannels`/`ExecutionChannelAuthorization`（execution-channels.tsx）、`reportEndSections`/`EndsReportSection`（ends-report.tsx）、`SystemMapView`（system-map-view.tsx）、`RunArchiveView`（run-archive-view.tsx）、`retestCandidates`/`RetestScopeDrawer`（retest-scope-drawer.tsx）。

## 测试结果

新增测试文件与用例：
- `test/qa-task-detail.test.ts`：+3（A1 分组纯函数/分组渲染/兜底提示）
- `test/metrics-panel.test.ts`：+2（A3 聚合纯函数/面板渲染）
- `test/qa-project-severity.test.ts`：+1（A2 台账生命周期/关联用例列）
- `test/execution-channels.test.ts`：+4（A7 通道映射纯函数×2/挂载渲染/兜底）
- `test/knowledge-views.test.ts`：+5（A4 地图渲染/空态×2、A5 档案渲染/空态、页签接入）
- `test/retest-scope-drawer.test.ts`：+3（A6 候选聚合/勾选提交/未上线诚实失败）

验证命令与结果（worktree 内）：
- `npx tsc --noEmit -p tsconfig.json`：**通过**
- `npx vitest run`（qa-task-detail / metrics-panel / qa-project-severity / qa-project-pagination / execution-channels / knowledge-views / retest-scope-drawer / platform-tasks-page / required-mark / project-knowledge-page / project-knowledge-clauses / quality-traceability* 等）：**全部通过**（最近一次 49/49）

## 存量问题修复（顺带，均在流 A 所属测试文件内）

1. `qa-task-detail.test.ts` 默认阶段数断言 7→6：main 上即为失败（api_execution 已并入"测试执行"展示），`1364b33` 修正并注明。
2. `qa-project-severity.test.ts` / `qa-project-pagination.test.ts` 在 main 上全挂（B5-4 双源拉取后 project-view 会调 `listTasks`，测试缺该 mock 导致视图渲染不出任务），`3793412` 补齐 mock 后 13/13 通过。**未改动任何 src 行为**。

## 已知限制 / 待完善项

1. **A1 依赖 C5**：overview run 记录目前无 attempt 字段（Agent 4 流 C5 登记后生效）；当前 UI 兜底平铺+提示。
2. **A7 目标环境为默认环境**：运行计划尚未暴露实际执行环境，多环境时明确提示"以运行计划为准"；待流 E 环境互斥/计划字段落地后可精确到通道×环境。
3. **A4 页面/路由逐条明细**：现有环境端点只有计数与四层知识条目，逐条清单接口缺失（如实说明）；待后端补明细端点。
4. **A6 retest 端点未上线**：提交路径 `platform-tasks/:id/retest` 为流 E6 预留，当前提交会失败并如实展示；回归影响选集（regression-impact）同样占位。
5. **main 已前进到 `ba978a1`**（ZCode 已合并流 B/流 D）：本分支基于 `9af26c6`，但流 B/D 只改 schemas/scripts/skills/agents，与本流 web 文件零重叠，合并无冲突预期。
6. worktree 验证环境注：server 等包 dist 从主工作区复制用于类型解析（tsup 全量构建在本机沙箱内存上限下 OOM），不影响交付内容。
