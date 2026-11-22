# 四 Agent 并行建设总报告（2026-11-22）

## 一、总览

| Agent | 流 | 分支 | HEAD | 提交数 | 合并状态 |
|---|---|---|---|---|---|
| **ZCode** | B1-B8 核心 + 流 C(3/5) + 流 E(前置) | main / feat/stream-b-ir-prompts | `9f8c58a` | ~34 | ✅ 全部在 main |
| **WorkBuddy** | 流 A（Web UI 视图补全） | `feat/stream-a-webui` | `e1c02e3` | 6 | ✅ 已合并到 main（`2470d48`） |
| **qoder** | 流 B（IR 契约 + 提示词 + Skill） | `feat/stream-b-ir-prompts` | `9f8c58a` | 5+ | ✅ 合并到 main（含在 9f8c58a 祖先链中） |
| **trae** | 流 D（执行引擎改造） | `feat/stream-d-execution` | `72d314c` | 7 | ✅ 合并到 main（含在 2470d48 祖先链中） |

**main 分支 HEAD**：`2470d48`（Merge branch 'feat/stream-a-webui'），共 68 个提交（ahead of origin/main）。

## 二、各 Agent 交付明细

### ZCode（流 B1-B8 核心 + 流 C + 流 E 前置）

**B1 编排与导航层**：
- 导航扁平化（七项全局菜单，拆项目门禁）
- 双入口（测试助手落 default_agent + 测试任务合并列表）
- 登记前移（qa_runs planned 预登记 + startRun 兑现 + observeRun 对账）
- 端维度建模（环境 end_type + 任务 ends_json + 六类枚举）
- 弹窗仅显式关闭（9 处）
- 新建任务整页表单（大文本域 + 测试重点 + 附件）
- 队长/助手提示词改造（test_agent 132→60 行 + default_agent 7→40 行）
- 修订续接双路径（input_subagent 续接优先 + revise_stage 重启兜底）

**B2 出厂校验**：
- stage_finalize 合并调用（analysis 三工具 + 诊断一次 exec）
- stage_finalize 扩展三设计阶段
- approve 门禁拒绝 failed 工具回执
- approve 门禁补跑阶段诊断（C1 引擎收口）

**B3 资产中心**：
- /qa/assets 只读投影端点
- 资料页测试资产页签
- 宿主库项目知识区测试资产入口

**B4 探索管线**：
- env_explorer_agent 注册（agents.json + AGENTS.md + system-map-exploration skill）
- 探索→资产候选自动派生（幂等）
- agents 列表自动补建 QA 角色（createAgent 正规链路）

**B5 执行架构**：
- 运行通道分组/徽章/planned 本地化
- 池容量可配置（config/pool-capacity.json）

**B7 变更分析**：
- change_source 全链路（列/创建/编辑/简报/提示词/UI/.diff/.patch）

**B8 缺陷闭环**：
- 缺陷生命周期服务端桥接（confirm/reject/fixed/retest）
- 缺陷详情确认/标记已修复按钮
- 复测轮次路由 + 抽屉入口按钮

**流 C 引擎校验 + 修订续接**：
- C1 approve 门禁补跑阶段诊断（三设计阶段引擎自动跑）
- C2 诊断失败错误带违规清单
- C3 修订续接双路径（AGENTS.md + UI 消息指示 input_subagent）
- C4 修订简报装配器（assembleRevisionBrief）

**流 E 前置**：
- origin 枚举扩展（created/backfill/assistant/environment）
- 池容量可配置

**流 B5-4 项目视图对齐**：
- 项目视图任务列表与测试任务列表对齐（双源拉取）

**部署事故修复**：
- schema.ts 回填对象补 IF NOT EXISTS
- env_explorer_agent AGENTS.md 入 release-resources

**fresh 库补齐**：
- U2/U3 层 21 表 + 22 索引逐字回填 SCHEMA_SQL
- 18 张表建表文本对齐（ensureColumn ALTER 写回问题）

**web 设计规则清理**：
- deslop 规则 1/2/3/6/12/13 清零
- required-mark 改 RequiredMark 组件
- admin-channels 手写红星修复

### WorkBuddy（流 A Web UI 视图补全）

| 条目 | 文件 | 说明 |
|---|---|---|
| A1 | task-detail.tsx | 运行列表按修订轮次分组（第1轮/修订vN，optgroup） |
| A2 | project-view.tsx 或新组件 | 项目维度缺陷台账（生命周期状态/关联用例/操作） |
| A3 | metrics-panel.tsx（新增） | 用例总数/已执行/通过率/严重度分布/高严重度计数 |
| A4 | project-knowledge-page.tsx | 系统地图页签：环境端点拉取四层清单 |
| A5 | run-archive-view.tsx（新增） | 历史档案页签：历次 run 产物只读表 |
| A6 | retest-scope-drawer.tsx（新增） | 复测三层范围勾选 + 提交到 retest 端点 |
| A7 | task-detail.tsx | 执行确认按通道列明 |
| A8 | EndsReportSection（新增） | 报告按涉及端分节 |

**测试**：tsc 通过、vitest 59/59、vite 构建通过、交付文档 docs/stream-a-report-2026-11-22.md

### qoder（流 B IR 契约 + 提示词 + Skill）

| 条目 | 文件 | 说明 |
|---|---|---|
| B1 | test_point/test_case.schema.json | 加 end 字段（可选，枚举六类+空串） |
| B2 | irval enums.py + cases.py | 枚举字典 + 11 个 end 用例（125 passed） |
| B3-B7 | 五个阶段 agent AGENTS.md | 端标签/锚点三选一/暂不可测/verified 约束 |
| B8 | requirement-analysis SKILL.md | frontmatter tools 语义注释 + 版本升 patch |
| B9 | skills/anchor-verification/SKILL.md | 新建 |
| B10 | skills/change-analysis/SKILL.md | 新建 |
| B11 | agents.json skills 绑定 + release-resources 白名单 | 登记两个新 skill |

**测试**：check-skills PASS (18/41/12)、check-tool-contract PASS、irval 125 passed、Ajv 冒烟 PASS

### trae（流 D 执行引擎改造）

| 条目 | 新增文件 | 说明 |
|---|---|---|
| D1 脚本资产化 | execution-script-assets.mjs | 三版本绑定（case/anchor/environment）、幂等登记、失效增量再生 |
| D2 托管浏览器 | browser-launch-policy.mjs + config/browsers.json | Playwright 版本锁 + headless/headed 模式 + worker context 隔离 |
| D3 分片并行 | execution-shards.mjs + tests | 模块×数据画像分片、波次容量受池限制、检查点恢复、实测并行度=2 |
| D4 优先级分层 | execution-plan.mjs 扩展 | P0>P1>P2 排序 + smoke/regression 分区 |
| D5 环境级互斥 | environment-lock.mjs | O_EXCL 创建 + 进程存活判定 + TTL + 同 run 接管 |
| D6 grounding 三后端 | grounding-driver.mjs + tests | 结构层零模型→语义层降级反查→视觉层坐标反查锚点 |

**测试**：execution-attempts 15/15、web-script-library+shards+grounding 10/10、node --check 全过

## 三、合并与部署状态

| 提交 | 部署轮次 | 状态 |
|---|---|---|
| `0d7506f` → `a4b6f40` | 第一轮（B1 全量） | ✅ 部署+用户验收通过 |
| `de33cc5` → `2c5895f` | 第二轮（B2-2/B3/B4-2/B5/B7/B8 部分修复） | ✅ 部署+用户验收通过 |
| `d9c9d37` → `9f8c58a` | 第三轮（流 A 合并 + stream B/D 合并 + 双源对齐） | ✅ 部署完成，待用户验收 |
| `2470d48`（stream A 合并后） | ⏳ **待部署** | 流 A 的 8 个 UI 组件尚未部署到安装副本 |

**当前安装副本运行版本**：基于 9f8c58a 构建（不含流 A 的 6 个提交）。
**main 分支最新**：2470d48（含全部四 Agent 工作）。

## 四、待部署增量（9f8c58a → 2470d48）

流 A 的 8 个 UI 组件（A1-A8）在 `feat/stream-a-webui` 分支上，已合并到 main 但尚未部署。需：
1. 暂停 → deploy-project-management-local（web-dist 重构建同步）→ resume
2. 无新迁移、无引擎文件变化（纯 web 前端）

## 五、方案覆盖度自查（§2-§11）

### ✅ 已实现（含文件层+后端层）

| 节 | 条目 |
|---|---|
| §2.1 | 七项全局菜单 + 拆项目门禁 |
| §2.3 | 单账号全权制 |
| §3.1 | 队长三栏杆提示词 + 登记前移 planned + 端维度列 + 弹窗修正 + 整页表单 |
| §3.2 | default_agent 扩写（AGENTS.md 文件层） |
| §3.3 | 端枚举 + 环境端列 + 任务端列 + 创建页端多选 + 简报/提示词注入 |
| §4 | stage_finalize 合并调用（analysis+test_points+test_cases）+ approve 门禁拒绝 failed 回执 |
| §5.3 | 池容量可配置 + 运行通道分组/徽章 |
| §6 | /qa/assets 投影端点 + 资料页测试资产页签 + 宿主库入口 |
| §7 | env_explorer_agent 注册 + system-map-exploration skill + 探索→资产候选派生 |
| §10 | 缺陷生命周期桥接 + UI 确认/修复 + 复测路由 + 复测入口 + 缺陷台账动作 |

### ⚠️ 做了壳但底层待补

| 节 | 条目 | 差什么 |
|---|---|---|
| §3.1 | 修订同会话续接 | AGENTS.md 写了双路径，实际 revise_stage 仍走新 dispatch（input_subagent 是宿主工具需实测续接行为） |
| §3.1 | 登记单位=attempt | manifest revisionId 已有但 qa_runs 无独立列 |
| §3.2 | 助手单阶段承接 | AGENTS.md 写了但 default_agent 无 exec 工具/origin 登记无数据 |
| §3.2 | 写权限运行时守卫 | 未实现 |
| §3.3 | IR end 字段 | qoder 已加 schema 枚举但 IR 契约文档未同步 |
| §3.3 | 锚定率按端统计 | 无 |
| §3.3 | 执行按端动态通道 | trae 的 D3 分片+D6 grounding 已建基础设施，但 dispatch 路由未按端动态选择 |
| §3.3 | 报告按端分节 | WorkBuddy A8 组件已建但未接入报告渲染链 |
| §4 | 引擎自动收口 | C1 approve 门禁已补跑诊断，但 stage_finalize 仍是 LLM action 非引擎自动 |
| §5.1 | 脚本资产化 lifecycle | trae D1 已建基础（登记/三版本绑定/失效判定），但首跑→verified 晋升流程未闭环 |
| §5.3 | 分片并行调度 | trae D3 已建基础设施，但分片 opt-in 默认关闭 |
| §6 | 系统地图/历史档案内嵌视图 | WorkBuddy A4/A5 组件已建，待部署后可见 |
| §6 | 被引用记录追踪 | 未实现 |

### ❌ 方案写了但完全未实现

| 节 | 条目 | 归属流 | 说明 |
|---|---|---|---|
| §5.2 | grounding 三后端 driver 抽象 | trae D6 已建纯抽象 | 语义/视觉适配器需调用方注入，未接入 browser-task |
| §5.3 | 托管浏览器版本受控 | trae D2 已建策略模块 | 需在真实执行中验证 |
| §8 | MCP 工具面全部 | 无 | 需设计文档 |
| §9 | diff 内容拉取与装配 | 无 | 需 MR API 凭据设计 |
| §10 | 复测范围三层选择后端 | WorkBuddy A6 UI 已建 | 后端 regression-impact 选集 API 未实现 |
| §10 | 外部缺陷平台提交/回流 | 无 | 需上游凭据 |
| §10 | 指标面板后端聚合 API | WorkBuddy A3 UI 已建 | 后端聚合 API 未实现 |

## 六、已部署内容与待部署内容的分界

**已部署（用户可验收）**：
- 导航扁平化、双入口、弹窗修正、登记前移、端维度、附件、整页表单、队长/助手提示词
- stage_finalize 合并、approve 门禁、/qa/assets 投影、资产候选派生
- 缺陷桥接、复测路由、池容量、通道分组/徽章
- change_source 全链路、env_explorer_agent 注册
- 宿主库测试资产入口、fresh 库 U2/U3 补齐

**待部署（main 2470d48 有但安装副本无）**：
- 流 A 全部 8 个 UI 组件（metrics-panel / retest-scope-drawer / system-map-view / run-archive-view / execution-channels / EndsReportSection / 修订轮次分组 / 缺陷台账视图）
- 流 B 的 schema end 字段（IR 契约变更需重新构建 server）
- 流 D 的执行引擎改造（分片并行/托管浏览器/grounding driver/脚本资产化/环境锁/优先级）

## 七、文件清单（按 Agent 分）

### ZCode 修改/新增的关键文件
- `penguin/ui/workspace-ui.mjs`（菜单/侧栏/测试助手/资料重构）
- `penguin/agents/test_agent/AGENTS.md`（队长三栏杆）
- `penguin/agents/default_agent/AGENTS.md`（测试助手扩写）
- `penguin/agents/env_explorer_agent/AGENTS.md`（新建）
- `scripts/structured-actions.mjs`（stage_finalize/origin 等多项）
- `scripts/approve-design-stage.mjs`（引擎收口诊断）
- `scripts/test-asset-catalog.mjs`（资产候选派生）
- `scripts/deploy-engine-files.mjs` 相关 config
- `platform/packages/server/src/db/schema.ts`（端维度/附件/origin/U2U3 补齐）
- `platform/packages/server/src/db/migrations/`（4 条新迁移）
- `platform/packages/server/src/http/routes/`（qa-platform-tasks/qa-project/agents/qa-project-knowledge）
- `platform/packages/server/src/services/`（qa-platform-task-service/qa-task-run-registry/project-environment-service/pool-capacity）
- `platform/packages/web/src/features/qa/`（多文件 UI 修改）
- `platform/packages/web/src/components/layout/sidebar.tsx`（品牌态移除）
- `skills/requirement-analysis/SKILL.md`（工具协议更新）

## 八、后续行动

1. **部署流 A 增量**（web-dist 重构建同步，无迁移）
2. **跑全量 `npm test`**（1149 条 + 新增测试）
3. **设计门项逐个立项**（§18 指引）
4. **债务批**（web 设计规则按页面分批 + 迁移链文本对齐）
5. **用户逐章验收**（对照方案 §2-§11）
