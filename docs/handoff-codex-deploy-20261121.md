# Codex 部署交接清单（2026-11-21，v4 集成部署验收版）

> 最新状态：批次 C 已于本地提交 7eed7e6，完整部署与安装版验收已完成，详见第 9–10 节。**批次 E（全流程审计收口，5 个 commit）已提交待部署**，见第 11 节——部署前先读它：engine_files 清单扩充 + 运行登记接线 + 阶段工具降级进报告。第 0–8 节中的旧失败与未提交描述是历史交接快照（两道门槛均已随批次 C/D 解除）。

> 交接人：本地 Agent（ZCode）。部署执行：Codex。本清单覆盖本地 `main` 上**全部 7 个未推送 commit**、工作区剩余的进行中改动（批次 C）、当前验证矩阵、部署前门槛、部署步骤与验收判据。
> 原则不变：源码 ≠ 运行版；所有部署走官方脚本（备份 → 换件 → 重签清单 → 自校验），禁止直拷；运行数据/凭据/迁移备份不入库。

## 0. 一页总览

| 来源 | 内容 | 状态 | 提交 |
| --- | --- | --- | --- |
| ZCode 批次 ① | 探索质量修复 P1-P5 + `deploy-engine-files.mjs` | ✅ 已提交已验证 | `b3bfd6f` |
| ZCode 批次 ② | 证据层第一批（零 LLM 语义证据 → observations.json → 假设/候选两管线） | ✅ 已提交已验证 | `214980b` |
| ZCode 批次 ③ | 证据层第二批（假设可见性 + 逆向需求文档渲染） | ✅ 已提交已验证 | `f125834` |
| 文档 | 交接清单（本文档） | ✅ 已提交 | `198aa02`/`e3acc6d` + 本次重写 |
| ZCode 工程修复 | 测试 runner staging、skill 版本断言、apiClient | ✅ 已提交已验证 | `2be280d` |
| Codex 批次 A | 各阶段提示词与公共规则精简（10 文件） | ⚠️ 已提交；**1 处回归未解决**（§4 门槛 1） | `dbb9a19` |
| Codex 批次 B | 桌面手动登录态/改密闭环 + main.js 进部署链 + 渠道驱动模型页（14 文件） | ✅ 已提交已验证 | `4daab7e` |
| 并发会话批次 C | 本地任务环境绑定 + 工具门/派发链（qa-platform-tasks/writeback 线，§2 已修正归属） | 🔴 **进行中未提交**；2 处测试失败（§4 门槛 2） | 工作区未提交改动 |
| ZCode 批次 D | 桌面 computer-use 全栈 + 插件市场 MCP 目录全闭环（含验收门槛同步） | ✅ 已提交已验证；**运行副本已部署验证**（D:\AITestHarness） | `d2c477b`/`fdc6180`/`fcbf88f` |
| ZCode 批次 E | 全流程审计收口：发布策略补 23 个运行时文件 + deploy-engine-files 策略感知 + 运行发起/结束登记接线（判据 1）+ 阶段工具降级进报告 + 证据验证轮契约进派发合同 | ✅ 已提交已验证（225/0 回归）；**待随下次部署生效** | `14ac8c2`/`3181509`/`c708525`/`8672041`/`745066c` |

**部署前必须先过 §4 的两道门槛**；门槛未清不得构建发布。

## 1. 已提交明细（main，7 个 commit 未推送）

### 1.1 探索质量修复（`b3bfd6f`，对应客户端实测五处失真）

- P1 建档报告与探索事实矛盾 → 探索成功后自动回写环境报告（`merge-explore-maps.py --report-out`，原建档快照保留为 `bootstrap-report-*.md`）
- P2 静态资源路由过滤（`explorer.py is_page_route` 与 `explore-authenticated.mjs normalizeRoute` 同源：CSS/favicon/manifest 等不入地图）
- P3 根前缀路由全拒 bug（`prefix='/'` 时 `startsWith('//')` 拒掉一切）+ 全站模式 BFS 链接发现 + 登录后落地页优先 + 重定向以最终路径登记
- P4 去硬编码幽灵路由（`//login`、`/profile/password`）+ apis `/v2/` 过滤清零修正 + 建档基线并集
- P5 服务端探索回写：合并地图提升为环境当前地图 + `maps_hash` + 环境摘要刷新（`promoteMergedMaps`）
- 新增 `scripts/deploy-engine-files.mjs`（引擎文件同步：变更探测 → 备份 → 换件 → 重签清单 → 自校验 → 失败回滚）

### 1.2 证据层第一批（`214980b`）

- `scripts/explore-observation-model.mjs`：零 LLM 语义证据（价格/字段标签/选项列表；逐字 verbatim + normalized + 多策略定位器 + 内容哈希）；确定性 question/rule 生成（上限 10/20 条每轮）；跨轮去重
- `explore-authenticated.mjs` 挂接：每页采集后产出 `observations.json`（与 pages.json 分离）；receipt 增 `observations/questions/evidence_rules` 计数
- 服务端 `syncEvidence`：question → `qa_exploration_hypotheses`（`created_by=system:exploration:round-N`，statement 去重）；rule → `qa_knowledge_candidates`（owner 确认队列，rationale 标注系统来源，409 超限按跳过计）
- 失败不改探索结论：`summary.evidenceSync` 如实计数/记错

### 1.3 证据层第二批（`f125834`）

- 时序修正：先落假设/候选再渲染知识文档
- 快照文档（`doc-explore-<env>`）末尾追加「待验证假设」节（`[tbd]` 标注；只读展示，**不进知识构建**）
- 新增**逆向需求文档** `doc-reverse-prd-<env>`：页面功能/接口/访问墙/业务规则/数据字段与选项/待确认未知/来源局限七节，逐条 verified/tbd 标注，空态如实占位，内容不变不制造修订
- 测试：`exploration-knowledge-sync-render.test.ts` 3/3

### 1.4 工程修复（`2be280d`）

- 测试 runner staging 补 `aitestharness-tools`、`platform/packages/server/src`（此前 2 个测试必失败的根因）
- skill 版本断言改格式级（`2026.11.02.N`，N≥1）——精确钉死在历次评审晋升后必漂移
- `apiClient` cookie 参数可选（批次 B 新测试需要）

### 1.5 Codex 批次 A：提示词精简（`dbb9a19`）

- 需求分析/总控角色精简：复用已读原文、一次 diagnose、方法类 Skill 按需读取
- 总控新增：完整流程首次规划即 `workflow_mode=lifecycle、review_mode=staged`；plan_test_tracks 被拒时按回执修正沿用原 run_id
- 公共规则按 `qa-roles` 角色裁剪；`irval.check` 从无条件必调改为「有适用 IR 才调，缺 IR 标 not_applicable」
- ⚠️ 遗留回归见 §4 门槛 1（command-runtime 精简后 10178 字符 > 测试上限 10000）

### 1.6 Codex 批次 B：桌面/账户（`4daab7e`）

- 桌面手动登录态（首次登出后进入密码登录模式）+ 改密后吊销会话并可重登（`attach-session.ts`/`main.ts` + 测试）
- **`dist/main.js` 进部署链**（`deploy-project-management-local.mjs` 备份/换件/重签三件套扩为四件）——桌面主进程改动从此随发布走
- account-client 渠道目录端点放宽（channels 只读直通）
- 模型设置页改为渠道驱动的供应商选项（admin 渠道目录权威，内置预设兜底）

### 1.7 ZCode 批次 D：桌面 computer-use 全栈（`d2c477b`）

- 结构层（零模型）：Windows UIA 控件树快照、每元素 ≥2 指纹锚点、视觉定位反查（`probe/desktop_probe.py`）
- 重放层（零模型）：封闭动作集，计划含坐标即拒绝（`exec/desktop_engine.py`）；`exec/pools.py` 桌面池（单屏独占）
- 视觉层：`@midscene/computer` 截图→VLM 定位→动作，命中当场降级为 UIA 锚点，坐标只留证据（`scripts/desktop-visual.mjs`）
- `desktop_task` 动作（`scripts/desktop-task.mjs`）：doctor/snapshot/visual/replay + 屏幕独占锁 + request_id 幂等回执 + audit/stage-tools 阶段回执
- 接线：`plan_run(execution_platform=desktop)` → `desktop_test_agent`；tool-gate 硬依赖 `desktop.snapshot`；execution 阶段桌面场景/轨道规则进派发合同；前端「桌面自动化」档

### 1.8 ZCode 批次 D：插件市场 MCP 目录全闭环（`fdc6180`）

- 迁移三表（swapSafe）：`mcp_server_catalog` + 下发台账 + 审计；`/api/admin/mcp-servers`（CRUD/启停/连通测试/工具发现/下发装配/审计；stdio spawn 即会话运行期语义，落在本地执行）
- 内置 `aitest-internal-tools` 出口入列并可一键下发——补 admin-tool-console §8 差距「agent 装配 tools.mcpServers 未加出口条目」
- 前端管理页 `/mcp` 五处注册；`${KEY}` 引用目录层不解析、下发后由 Agent vault 会话期解析

### 1.9 ZCode 批次 D：验收门槛同步（`fcbf88f`）

- `command-runtime.md` 9890 字符（<10000，**门槛 1 解除**）：桌面纪律单一真源收敛到 `desktopScenarioPrompt` 派发合同注入 + `desktop_test_agent/AGENTS.md`
- `skill-resources` 角色数 11、desktop_test_agent 入单段式执行轨豁免名单；`tool-gate` known 集合补 `desktop.snapshot`

## 2. 工作区剩余改动（批次 C，进行中，未提交）

> 归属：另一并发会话正在开发「本地任务环境绑定 + 工具门/派发链」。**本清单不替它提交**；部署前它必须自行完成并验证，或由维护者裁决剥离。

> 归属修正（批次 D 提交后）：此前本节误把 ZCode 批次 D 的文件（desktop/MCP 相关）并入 C。现按实际归属剥离：批次 D 的 `penguin/agents.json`、`central-tools.ts`、`scripts/{plan-run,tool-gate,stage-tool-runtime,local-browser-executor}.mjs`、`pools.py`、`runtime_cli.py`、`platform.ts`、`test/{central-tools,mcp-catalog}.test.ts`、web 管理端 MCP 页与路由、`task-detail.tsx`（desktop 档）、`package.json`/`package-lock.json`、`requirements-ci.txt` **已随 `d2c477b`/`fdc6180` 提交**。批次 C 剩余仅以下自己的文件。

按文件面分组：

- **本地任务环境绑定**：`http/routes/qa-platform-tasks.ts`、`services/qa-platform-task-service.ts`、`web/src/features/qa/platform-tasks/{api.ts,platform-tasks-page.tsx}`、`test/{qa-platform-tasks,platform-tasks-page}.test.ts`
- **db schema 迁移**：`db/database.ts`（ensureColumn 接线）；`db/schema.ts` 与 `db/migrations/index.ts` 中**批次 C 自己的行**仍在工作区（未提交）：`qa_local_tasks` 三列 + `localTaskContext` import/注册——提交时注意 index.ts 已含批次 D 的 `mcpServerCatalog` 两行
- **新脚本**：`scripts/qa-platform-writeback.mjs` + `tests/acceptance/qa-platform-writeback.test.mjs`、`scripts/controller-tool-guard.mjs`（platform_task_writeback 放行）、`http/routes/{agents,sessions}.ts`、`mechanisms/projects.ts`、`services/project-config-service.ts`
- **发布清单**：`config/release-resources.json` 中 `explore-observation-model.mjs`/`qa-platform-writeback.mjs` 两行（desktop 两行已随 D 提交）
- 其他：`db/migrations/steps/2026-11-21-local-task-context.ts`（新增未跟踪）

## 3. 当前验证矩阵（2026-11-21 10:30 实测）

| 套件 | 结果 | 失败归属 |
| --- | --- | --- |
| skill-resources + tool-gate + command-runtime（批次 D 门槛修复后，10:52 实测） | **50 过 / 0 失败** | 门槛 1 与门槛 2 之 1-5 全解除 |
| server / web / desktop `tsc --noEmit` | **全部 0 错误** | — |
| 批次 A 相关验收 11 套（command-runtime/structured-actions/stage-tool-scenarios+runtime/tool-gate/controller-tool-interface/skill-resources/delegation-binding/staged-result-gates/confirm-gate/role-boundaries） | 170 过 / **5 失败** | 全部 §4 门槛区 |
| server vitest（desktop/account-client/central-tools/mcp-catalog/qa-platform-tasks） | 49 过 / **1 失败** | 批次 C 区（published template 404 vs 201） |
| web vitest（platform-tasks-page/admin-menu-normalization/vendor-group-models） | 18 过 / **1 失败** | 批次 C 区（user-models add-model openers 数量变化） |
| desktop vitest | 421 过 / 6 失败 | `cli-link` macOS/Linux symlink 用例在 Windows EPERM——**环境噪音**，非代码 |
| `explore-observation-model.test.mjs` | 5/5 过 | — |
| `smoke_merge_explore_pages.py` | 25/25 过 | — |
| `exploration-knowledge-sync-render.test.ts` | 3/3 过 | — |

## 4. 部署前门槛（不过不得发布）

**门槛 1（✅ 已解除，`fcbf88f`）**
`skill-resources.test.mjs:273` — `penguin/command-runtime.md` 精简后 **10178 字符 > 断言上限 10000**。处置：删减约 180 字符冗余（推荐），或与用户确认上调上限并说明理由。

**门槛 2（批次 C 未完成；原 7 处失败中 1-5 已随批次 D 解除，剩 2 处在批次 C 自己的文件面）**
1. `skill-resources:98` 角色包安装断言（agents.json 变更后不匹配）
2. `skill-resources:128` installed instructions 分离断言
3. `skill-resources:294` functional/API scope 断言
4. `tool-gate:157` `desktop_task` 绑定了未注册工具 `desktop.snapshot`
6. server vitest `account-client` published template 404 vs 201（routes mid-refactor）
7. web vitest user-models add-model openers 断言

处置：批次 C 会话完成并自验后并入；或维护者裁决剥离其改动后部署。**db schema 迁移（`2026-11-xx` 新步骤）必须确认完整并进发布链第 3 步。**

**通用前置**：桌面客户端从托盘退出；`npm ci` + platform `pnpm install` 已就绪；双 Python 已注入全套依赖（bs4/requests/pytest/python-docx/reportlab/lxml/pillow）且 `configure-python.mjs` 已注册内置解释器。

## 5. 部署步骤（Codex 执行）

```powershell
# 0) 客户端退出；依赖就位（本机已装好，换机需重做）
npm ci
cd platform; pnpm install --frozen-lockfile

# 1) 构建顺序：amsp → core → cli → hmr → server → desktop → web
pnpm --filter @prismshadow/amsp build
pnpm --filter @prismshadow/penguin-core build
pnpm --filter @prismshadow/penguin-cli build
pnpm --filter @prismshadow/penguin-hmr build
pnpm --filter @prismshadow/penguin-server build    # 必须走包内脚本（4GB 堆），直接 tsup 会 OOM
pnpm --filter @prismshadow/penguin-desktop build   # 产出 dist/server.js + dist/main.js + migrate-db.js
pnpm --filter @prismshadow/penguin-web build

# 2) 打戳 + 发布（pause → 部署 web/server/main/migrate → 迁移 → resume）
cd ..
node scripts/release.mjs --stamp
node scripts/release.mjs D:\AITestHarness

# 3) 引擎文件同步（scripts/、aitestharness-tools/、penguin/、skills/ 变更探测→换件→重签→自校验）
node scripts/local-service.mjs pause D:\AITestHarness\installation.json
node scripts/deploy-engine-files.mjs D:\AITestHarness

# 4) 角色状态同步（提示词/Skill 改动必须进客户端角色状态才生效）
node scripts/sync-penguin-agents.mjs --apply --target-root=D:\AITestHarness\data\penguin

# 5) 恢复服务
node scripts/local-service.mjs resume D:\AITestHarness\installation.json
```

> **部署事实（2026-11-21 08:44，ZCode 已执行）**：批次 D 三个 commit 已按本流程同步到 `D:\AITestHarness`（pause → `deploy-engine-files` + 新增文件补拷 → `deploy-project-management-local`（备份 `D:ackups\project-management-2026-11-21T00-44-15-035Z`）→ 引擎根 `npm install @midscene/computer --no-save` → runtime Python（get-pip 引导后）`pywinauto 0.6.9` → doctor（python/UIA/Midscene 全就绪）+ snapshot（104 元素/49 锚点）实测 → resume ready）。**批次 C 并入后须重跑全流程**；换机部署按本节步骤。

要点：
- `dist/main.js` 已进部署链（批次 B），desktop 主进程改动随 release 生效；
- 第 4 步是**提示词/Skill 生效的关键**——宿主按 `data/penguin/<account>/agents/*/agent_state` 加载角色，不同步则改了白改；
- 顺序可调（引擎同步与 release 可互换），但都要在 pause 窗口内完成。

## 6. 部署后验收判据（按批次）

**探索/证据层（批次 ①②③）**
1. 重新建档+探索 saucedemo：建档报告不再报“未发现登录表单”；地图无 CSS/favicon/manifest 路由；无 `//login`、`/profile/password` 幽灵路由；apis 不被清零；全站模式采集登录后落地页并跟随链接扩展
2. 轮目录出现 `observations.json`（价格/字段标签/选项逐字+定位器+哈希）+ receipt 三个计数
3. `qa_exploration_hypotheses` 出现 `system:exploration:round-N` 行（statement 去重）；`qa_knowledge_candidates` 出现系统来源 pending 候选
4. 项目资料出现 `环境探索快照`（末尾待验证假设节）与 `逆向需求文档`（七节+验证等级）；内容不变不制造修订
5. `summary.evidenceSync` 计数如实；失败不改探索 succeeded 结论

**提示词/Skill（批次 A）**
6. 任务会话中派发子 Agent：阶段工具按适用条件调用（缺 IR 标 not_applicable 而非盲目调用）；需求分析同一派发内复用已读原文；完整流程首次规划即 lifecycle+staged（逐阶段人工确认）

**桌面/账户（批次 B）**
7. 首次登出后重启进入密码登录页；改密→登出→密码重登成功（sessionVia=password）
8. 桌面 `dist/main.js` 清单校验通过（启动不拒签）

**桌面 computer-use / MCP 目录（批次 D）**
9a. 管理后台「MCP 服务」：内置 `aitest-internal-tools` 启用 → 连通测试列出 10 个阶段工具 → 下发给 QA Agent → 会话首跑连接横幅 → 同名不同配置下发 409、停用下发 409、删除已下发 409
9b. 桌面轨：渠道管理配视觉模型 + `MIDSCENE_*` 环境变量 → `plan_run(execution_platform=desktop)` 派发 desktop_test_agent → 任务详情「桌面自动化」档看 doctor/snapshot/visual/replay 回执（anchor 降级与 desktop.lock 生效）

**资源池/派发链（批次 C，若并入）**
9. 按其自带验收（`qa-platform-tasks.test.ts`、`central-tools.test.ts` 等）全绿后再验收 UI：本地任务保存环境自动登记、开始测试把 env 带进任务档案

## 7. 回滚点

- 本次部署产生的备份目录：`D:\backups\project-management-<时间戳>`（web/server/main/migrate/manifest）与 `D:\backups\engine-files-<时间戳>`（引擎换件）
- 上一次部署回滚点（已存在）：`D:\backups\project-management-2026-11-20T16-42-50-538Z`、`D:\backups\engine-files-2026-11-20T16-42-34-409Z`
- 回滚 = 从备份目录恢复对应文件 + 恢复 `aitest-source-runtime.json` 后重启；不要直拷生产目录

## 8. 已知边界与提醒

- AGENTS.md 旧记录「已部署应用位于 `E:\AItestHarness\installed`」已失效：实际安装位置 `D:\AITestHarness`（部署命令均按此路径）

- cli-link 的 6 个 symlink 用例在无特权 Windows 上 EPERM，属环境噪音（测试未按平台跳过的实现问题，未修）
- platform vitest 在本机存在预存 boot 失败（`project-exploration.test.ts` 等 12 例），CI 基线为准
- 证据层候选归属当前挂项目所有者（rationale 标注系统来源）；会话侧证据轮（附录 A 契约）落地后改用真实 session 归属
- 批次 C 的 db schema 迁移若并入发布，必须走 `release.mjs` 第 3 步（迁移失败发布中止），禁止只在源码目录跑 migration

## 9. Codex 集成验证更新（2026-11-21，以本节为准）

批次 D 的四个提交已在本地 main；本次纳入批次 C 的本地任务环境关联、总控预分析异步回写、分析会话复用及存量数据库迁移。运行数据、凭据、构建产物及 `.zcode/` 不提交、不推送。

原部署门槛的两处剩余失败已处理：

- `account-client.test.ts`：原测试仅注释声明创建 test_agent，实际在非 QA 测试模式没有目标 Agent。现在通过宿主服务补齐本地目标，仍由真实路由应用模板；保留对 HTTP 状态及模板结果的断言，并在失败时输出响应正文。
- `vendor-group-models.test.ts`：模型页已有四个添加入口，更新入口清单并钉住新增空态入口的 `isAddableGroup` 条件，继续拒绝供应商分组直接添加模型。
- 新增 `local-task-context-migration.test.ts`：验证旧任务表补列、历史行保留、重复迁移及全新 schema 幂等。

验证结果：

- 工程验收 9 套共 156/156 通过（含 structured-actions、桌面执行、writeback、部署维护及源码清单验证）。
- 服务端选定 6 套 54 通过、1 个原有跳过；本地任务服务端套件单独配置 AITEST_ENGINE_ROOT 后 11/11 通过。
- Web 选定 5 套 28/28 通过；server/web/desktop 类型检查均通过。
- amsp → core → cli → hmr → server → desktop → web 已按顺序构建完成。
- 真实安装库的一致性备份在 `D:\backups\integration-2026-11-21T03-28-56Z`。新构建的迁移程序在备份副本上连续运行两次，账本为 39/39，未再写迁移；111 张业务表行数无变化，integrity_check=ok，任务上下文列及对应迁移已存在。原始备份未被演练修改。

边界：扩大运行 `db-migrations.test.ts` 时有 4 个 schema/回退形状断言失败。使用未修改的 de048be schema 和排除本次 local-task-context 的迁移集合，已复现旧 schema 与旧迁移的对象差异及回退形状不一致；该套件不能标为全绿。本次专门升级测试及真实库演练通过，部署不做历史 schema 清理或降级。

部署状态：源码集成验证完成，随后通过官方脚本进行备份、维护暂停、引擎同步、应用发布、数据库迁移、角色同步及恢复；执行结果追加于下节。角色同步应指向实际项目的 agents 目录，不能把 data/penguin 根目录当作 Agent 根目录。现有项目缺少新增 desktop_test_agent 时，通过核心 Agent 初始化入口补齐，再同步受管理指令与工具契约。

## 10. 本次部署执行结果（2026-11-21）

- 源码集成提交：`7eed7e6`；仅本地提交，未推送、未生成安装包。
- 构建号：`37a696a63068d5ee`；安装目录仍为 `D:\AITestHarness`。
- 已通过服务的空闲维护检查后正常暂停（stopped:true），未强杀任何任务或桌面进程。
- 引擎同步备份：`D:\backups\engine-files-2026-11-21T03-33-30-991Z`；本轮实际换件 `penguin/command-runtime.md` 和 `scripts/controller-tool-guard.mjs`。其他发布白名单文件（含新增回写脚本）已一致，未重复覆盖。
- 应用备份：`D:\backups\project-management-2026-11-21T03-34-51-564Z`。官方 release 链已完成应用换件、重签、数据库迁移和恢复服务。
- 数据/角色备份：`D:\backups\integration-2026-11-21T03-28-56Z`。保留最初一致性备份、暂停后 web-before-release.db 和两个实际项目的 agents 目录原件。
- 两个已有项目均缺新增 desktop_test_agent，已通过核心 loadAgentState 初始化，仅为新角色接入对应工具契约；随后由已安装引擎同步脚本更新角色指令。两个项目各更新 19 个受管理文件，复核均 in_sync；自定义角色和既有模型凭据未更改。
- 正式数据库迁移账本 39/39，程序报告 schema 已最新；升级列已由此前部署建立，无重复迁移。恢复后 integrity_check=ok，foreign_key_check 无违规。
- 恢复结果：ready=true，端口 55875，serverPid=22612，维护标记已解除。
- 清单校验：1133 个应用文件、435 个引擎文件通过；main.js/server.js/migrate-db.js 与本次构建哈希逐一相同；发布白名单 434 个源码文件与安装引擎无漂移。
- 已安装接口检查：/login、/api/me、/api/projects、/api/projects/default_project/agents、/api/admin/mcp-servers 均为 HTTP 200；default_project 已发现并登记 desktop_test_agent。
- 验证仅包含自动化测试、数据库及本机接口检查，未新建真实测试任务、未调用真实模型执行业务探索，也未修改账号密码或代替用户完成登录登出。

用户可重新打开 AITestHarness 验收。本节与第 9 节覆盖前面历史交接时的“未提交/未部署/剩余两处失败”状态。

## 11. 批次 E：全流程审计收口（2026-11-21 下午，ZCode，待部署）

> 背景：以当前代码（含批次 D）做的独立全流程审计发现两处部署层断链、三处端到端缺口、若干治理缺口。本批修复其中五项，全部带测试；剩余项见本节末尾"未修清单"。

### 11.1 修复内容（5 个 commit）

| commit | 修复 | 审计依据 |
|---|---|---|
| `14ac8c2` | **P0 部署断链**：`config/release-resources.json` 补 23 个运行时文件（exec/probe 引擎全套 19 个 py、`central-mcp.mjs`、`check-tool-contract.mjs`、`config/tool-runtime-state.json`、`desktop_test_agent/AGENTS.md`）；`deploy-engine-files.mjs` v2 升级为**策略感知**——期望状态取自发布策略（与 stageSourceRuntime 同源公式），新增文件自动入清单同步 | 实测安装副本缺 `central-mcp.mjs`（MCP 目录连通测试会 ENOENT）；清单外 121 个文件不受官方同步管理（82 个靠手工镜像，漂移风险） |
| `3181509` | **P1 判据 1 收口**：`scripts/run-registration.mjs`（startRun/finishRun 走 api-token 通道——鉴权中间件把本机 token 认作 admin，通道先例 qa-platform-writeback）；`run-ui-tests.mjs` 接线：发起即 running（409 幂等），尝试密封且非中断才交回 manifest 事实，中断不补结论留 stalled 判定 | 此前 `startRun` 零生产调用方、"执行器没起来/起来就退"无 qa_runs 行；`recorded_run` 零生产使用 |
| `c708525` | **P2-7**：阶段工具降级（run_stage_tool 流水 `output/runtime/tool-usage.jsonl` 按 run_id 过滤）进报告运行时段落，口径对齐 `qa-run-health.ts`；无流水不说"零次" | §8 差距①：降级此前只进流水与健康端点，报告一字未提 |
| `8672041` | **P2-8**：证据验证轮契约（单目标/Done when/证据格式/步数预算/红线）进执行阶段派发合同 | 会话侧证据验证轮的合同此前未标准化 |
| `745066c` | **P2-11**：AGENTS.md 路径修正（仓库 E:\AItestHarness、部署 D:\AITestHarness） |
| `df42865` | **P0 实测回归**：探索合并基线读取 JSON 优先 YAML 兜底——pyyaml 注入后 canonical maps 落盘变 safe_dump 格式，round-3 合并炸在 json.loads（saucedemo 用户实测复现）；smoke 加 YAML 基线用例 | 用户第 3 轮探索「合并/回写失败」实测：round-1 时代是 JSON、注入 pyyaml 后 round-2 起是 YAML，promote 把 YAML 顶上 canonical 后只认 JSON 的读取必炸 | 旧记录指向不存在的 `E:\AItestHarness\installed` |

### 11.2 验证

- 新增测试：`run-registration.test.mjs` 6/6（本机 HTTP 捕获：Bearer 头/路径/409 幂等/manifest 事实口径/路径正斜杠）、`report-runtime-sections.test.mjs` +2（降级进报告/无流水不说零次）、smoke_merge_explore_pages +1（YAML 基线读取，25/25）。
- **现场验证**：用安装副本的 canonical YAML 文件实测——json.loads 精确复现用户报错，YAML 解析成功（3 页/登录事实齐）。
- 回归：13 套验收 **225 过 / 0 失败**（含 structured-actions/command-runtime/tool-gate/skill-resources/desktop-task/qa-platform-writeback/confirm-gate/staged-result-gates）；三包 typecheck 0 错误。

### 11.3 部署注意（并入 §5 流程）

1. `deploy-engine-files.mjs` 现在按策略自动补新文件——**下次运行会自动把 central-mcp.mjs 等 23 个文件带进安装副本并入清单**，不再手工补拷；结果 JSON 的 `added` 字段即新增数。
2. 策略扩充后 `stageSourceRuntime` 的 `assertReleaseImportClosure` 会在整装时校验导入闭包，新增文件均来自源码树，预期通过。
3. 运行登记对既有验收无行为变化（失败降级 stderr，不拦执行）；验收判据 1 补一条：跑一轮生命周期执行后 `qa_runs` 应出现发起行（`dispatch_json.entry='run-ui-tests'`），执行器未启动时也有行可查。

### 11.4 审计未修清单（如实在案，不在本批）

- **P1-4 token 预算强制**：budget_tokens 仍无派发消费方（登记包已可携带，强制点等阶段运行时接入）。
- **P1-5 漏测回流**：缺陷确认 → 假设的回流无生产者（语义需产品决策：什么算"漏测"）。
- **P1-6 E2E-1**：产品 UI 从新建任务到报告的全链验收仍未跑过（判据 2/3/4 已各自成立）。
- **P1-10 任务平台拉取**：ingestion 轮询未接线（outbox 只有结果回传方向）；平台任务仍是 demo 种子。
- **P2-9 环境恢复**：`restore()` 壳为零（外部依赖）。
- 已知噪音：desktop `cli-link` 6 例在无特权 Windows 上 EPERM（测试未按平台跳过）。
