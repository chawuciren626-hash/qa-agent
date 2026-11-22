# 并行建设计划（2026-11-22）——基于方案 §2-§11 自查审计

## 已完成（不要重做）

以下 33 个提交已覆盖的内容**不需要再做**：
- 导航扁平化（七项菜单/拆门禁/宿主库测试资产入口）
- 双入口（测试助手落 default_agent + 测试任务合并列表 + 整页表单）
- 登记前移（planned 预登记 + startRun 兑现 + observeRun 对账）
- 端维度（环境 end_type + 任务 ends_json + 六类枚举 + 创建页端多选）
- 附件上传（qa_task_attachments 表 + 端点 + UI + 分析注入）
- 弹窗仅显式关闭（9 处）
- 队长/助手/env_explorer_agent 提示词（AGENTS.md 文件层）
- stage_finalize 合并调用（analysis+test_points+test_cases 三阶段）
- approve 门禁拒绝 failed 工具回执
- /qa/assets 只读投影端点 + 资料页测试资产页签 + 宿主库入口
- 探索→资产候选自动派生（幂等）
- 运行通道分组/徽章/planned 本地化
- 池容量可配置（config/pool-capacity.json）
- 缺陷生命周期服务端桥接 + UI 确认/修复按钮 + 复测路由 + 复测入口
- change_source 全链路（列/创建/编辑/简报/提示词/UI/.diff/.patch）
- 项目视图任务列表与测试任务列表对齐（双源拉取）
- fresh 库 U2/U3 补齐（21 表 + 22 索引）
- 18 表建表文本对齐（ensureColumn ALTER 写回问题）
- env_explorer_agent 自动补建（agents 列表请求时检查缺失并走 createAgent 正规链路）
- required-mark 改 RequiredMark 组件
- web 设计规则 deslop 1/2/3/6/12/13 清零
- 部署事故修复（IF NOT EXISTS）+ 交接文档 + 债务清单

---

## 六条并行流

### 流 A：Web UI 视图补全（纯前端，可独立跑）

**涉及文件**：`features/qa/task-detail.tsx`、`project-view.tsx`、`project-knowledge-page.tsx`、新建组件
**不碰**：server routes、scripts、penguin/
**前置**：无（所有后端 API 已有或与流 E 并行补）

| # | 条目 | 方案节 | 说明 |
|---|---|---|---|
| A1 | 产物按修订轮次分组展示 | §3.1 | runs 列表按修订 attempt 加分组标题 |
| A2 | 项目缺陷台账视图 | §10 | 项目维度缺陷列表（状态/严重度/关联用例/操作按钮），数据从已有端点拼装 |
| A3 | 指标面板 | §10 | 用例可信度/缺陷严重度/锚定率聚合展示（后端指标已有脚本） |
| A4 | 系统地图内嵌视图 | §6 | 资料页内嵌展示探索产出（页面清单/接口清单/覆盖率），数据从 /qa/assets + 环境端点拼装 |
| A5 | 历史档案内嵌视图 | §6 | 资料页内嵌展示历次 run 产物（只读列表，关联 run_id） |
| A6 | 复测范围选择 UI | §10 | 三层选择（缺陷关联用例/regression-impact 选集/冒烟），后端路由 B8-3 已有 |
| A7 | 执行授权逐通道列明 | §3.3 | 授权界面按通道列目标环境与数据影响 |
| A8 | 报告按端分节 | §3.3 | 报告模板按涉及端分节渲染 |

### 流 B：IR 契约 + 阶段提示词 + Skill（schemas/ + penguin/agents/ + skills/）

**涉及文件**：`schemas/`、`penguin/agents/阶段agent/AGENTS.md`、`skills/`
**不碰**：web、server routes
**前置**：无

| # | 条目 | 方案节 | 说明 |
|---|---|---|---|
| B1 | IR end 字段 | §3.3 | test_point.schema.json + test_case.schema.json 加 `end` 字段（string，枚举六类或空） |
| B2 | irval 用例补充 | §14-8 | irval 测试用例覆盖 end 字段（合法值/缺省/多端） |
| B3 | 阶段 agents 提示词更新 | §11 | requirement_analysis_agent：锚点引用/暂不可测标记；test_point_agent：端标签+锚点引用；test_case_agent：verified 资产引用+禁自造选择器 |
| B4 | 执行 agents 提示词更新 | §11 | automation_execution_agent/api_automation_agent：只引用 verified 锚点，缺资产 blocked 列清单 |
| B5 | skill frontmatter tools 语义 | §11 | tools 从"强制执行清单"变为"阶段收口校验清单" |
| B6 | anchor-verification skill | §11 | 新建：验证测试点锚点引用在系统地图中真实存在 |
| B7 | change-analysis skill | §11 | 新建：从 diff 提取变更情报（变更模块/风险/测试建议） |
| B8 | workflow 绑定更新 | §11 | orchestration-workflow.json 如需调整则同步 stage-registry |

### 流 C：引擎校验收口 + 修订续接（scripts/）

**涉及文件**：`scripts/structured-actions.mjs`、`scripts/approve-design-stage.mjs`、`scripts/recovery-policy.mjs`
**不碰**：web、schemas、execution-runner
**前置**：理解当前 dispatched/complete/revise 流程

| # | 条目 | 方案节 | 说明 |
|---|---|---|---|
| C1 | 引擎收口批量校验 | §4 | approve 或 complete 时自动跑 stage_finalize 逻辑（不占 LLM 回合），结果写确认快照 |
| C2 | 违规清单定向重派 | §4 | 校验不通过 → 自动带违规清单 revise_stage 一次 |
| C3 | 修订同会话续接 | §3.1 | revise_stage 改为调 resolve_child_handle + input_subagent 注入原阶段会话（不走新 dispatch） |
| C4 | 修订简报装配器 | §3.1 | 重启路径：装配台账+最新版+未决+反馈历史 |
| C5 | attempt 登记单位 | §3.1 | qa_runs 或新表记录 attempt（run_id+stage+attempt+session），修订版本递增 |

### 流 D：执行引擎改造（scripts/execution-*，最大单流）

**涉及文件**：`scripts/execution-runner.mjs`、`local-browser-executor.mjs`、`execution-plan.mjs`、`prepare-execution-plan` 相关
**不碰**：server routes、schemas
**前置**：流 C 的 attempt 登记完成后

| # | 条目 | 方案节 | 说明 |
|---|---|---|---|
| D1 | 脚本资产化 lifecycle | §5.1 | 首跑通过→脚本登记 candidate→verified；复跑零生成；失效增量再生 |
| D2 | 托管浏览器 | §5.3 | Playwright 托管配置（版本锁定/上下文隔离/trace 证据），headless 批量/headed 登录卡片 |
| D3 | 分片并行调度 | §5.3 | 模块×数据画像分片，片内按池容量并行，resource_keys 跨片串行 |
| D4 | 优先级分层 | §5.3 | 用例 schema 加优先级，冒烟子集/全量回归分窗 |
| D5 | 环境级互斥 | §5.3 | 跨端共用环境按环境锁串行 |
| D6 | grounding 三后端 | §5.2 | driver 抽象：结构层（零模型锚点）→ 语义层（Midscene 混合）→ 视觉层（computer-use），命中反查结构锚点 |

### 流 E：后端服务补全（server routes/services）

**涉及文件**：`server/src/http/routes/`、`server/src/services/`
**不碰**：web tsx/css、schemas、execution scripts
**前置**：无（可独立跑）

| # | 条目 | 方案节 | 说明 |
|---|---|---|---|
| E1 | origin: assistant 登记 | §3.2 | 助手指派的单阶段任务写入 origin 字段 + 列表过滤 |
| E2 | 写权限运行时守卫 | §3.2 | default_agent 会话的写路径白名单 |
| E3 | 被引用记录追踪 | §6 | 资产被哪些 run 引用的记录（资产消费时写入） |
| E4 | 上游映射配置 | §3.3 | 管理端配置：产品线→项目映射 + 端标签归一化 |
| E5 | diff 拉取与装配 | §9 | change_source → diff 文件 → 阶段简报注入 |
| E6 | 复测证据自动挂回 | §10 | 执行完成后自动调 manage-defect-lifecycle retest |
| E7 | 例行对账调度 | §10 | reconcile-defect-ledgers 定时执行 |
| E8 | 环境级互斥 | §5.3 | 跨端共用环境按环境锁串行 |

### 流 F：探索派发通道（server + workspace-ui）

**涉及文件**：`server/src/http/routes/`、`penguin/ui/workspace-ui.mjs`、`scripts/explore-*`
**不碰**：schemas、execution scripts
**前置**：流 E 的 origin 机制完成后

| # | 条目 | 方案节 | 说明 |
|---|---|---|---|
| F1 | 探索派发通道 | §7 | 项目环境页「探索建档」→ 创建 origin: environment 作业 → 派发 env_explorer_agent 会话 |
| F2 | 端 × 环境探索 | §7 | 探索按端分区，产出带端标签的锚点候选 |
| F3 | 断点续爬 | §7 | 长爬取检查点，中断后从上次位置继续 |

### 流 G：MCP 收口封装（设计先行）

**涉及文件**：`scripts/central-mcp.mjs`、`server/src/http/routes/mcp-catalog.ts`
**前置**：设计文档定稿后实施

| # | 条目 | 方案节 | 说明 |
|---|---|---|---|
| G1 | MCP 收口封装 | §8 | stage_finalize 的无会话形态封装；引擎工具出口扩容 |

---

## 并行分配建议

| Agent | 负责流 | 理由 |
| --- | --- | --- |
| **Agent 1** | 流 A（Web UI） | 纯前端，零后端依赖，文件独立 |
| **Agent 2** | 流 B（IR + 提示词） | schema + 提示词文件独立，不碰代码逻辑 |
| **Agent 3** | 流 C（引擎校验） + 流 E（后端服务） | 都是 server 端改动，但文件集不重叠（C 碰 scripts/，E 碰 server/src/） |
| **Agent 4** | 流 D（执行引擎） | 最大的单流，需要专属注意力 |
| **Agent 5** | 流 F（探索派发） + 流 G（MCP） | 等流 E 的 origin 机制完成后接手 |

**依赖约束**：
- 流 A 独立，可立即开始
- 流 B 独立，可立即开始
- 流 C 独立，可立即开始（但 C3/C4 需要 C1 先完成）
- 流 D 的 D1 依赖流 C 的 C5（attempt 登记）
- 流 F 依赖流 E 的 E1（origin 机制）
- 流 G 需要先出设计文档

**建议启动顺序**：Agent 1 + Agent 2 立即并行 → Agent 3 跟上 → Agent 4 等流 C 完成 → Agent 5 最后。

---

## 验收方式

每个流完成后：
1. 该流涉及的契约测试全绿
2. 双端 typecheck 通过
3. 提交到本地 main
4. 下一流开始

全部流完成后：统一跑全量 `npm test` + 按手册部署 + 用户逐章验收。
