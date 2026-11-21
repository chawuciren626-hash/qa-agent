# 桌面 computer-use 与管理后台 MCP 目录 交接说明（2026-11-21）

本批交付两件事，均已前后端闭环并通过回归：

1. **桌面 GUI computer-use（Windows）**：`desktop_task` 结构化动作 + `desktop.snapshot` / `desktop.visual_probe` / `desktop.replay` 三个阶段工具，按执行阶段接线。
2. **管理后台插件市场 MCP 能力（MCP 目录全闭环）**：`/api/admin/mcp-servers` 目录（登记/启停/连通测试/工具发现/下发装配/审计），内置 `aitest-internal-tools` 出口首次进入 Agent 装配。

## 一、能力地图（改了哪些文件）

### 桌面 computer-use

| 层 | 文件 | 说明 |
|---|---|---|
| 结构层（零模型） | `aitestharness-tools/aitestharness_tools/probe/desktop_probe.py` | Windows UIA 控件树快照、每元素 ≥2 指纹锚点、`element_from_point` 视觉定位反查、截图 |
| 重放层（零模型） | `aitestharness-tools/aitestharness_tools/exec/desktop_engine.py` | 封闭动作集 tap/type/key/wait/assert_anchor/assert_window；计划含坐标即拒绝 |
| 调度 | `aitestharness-tools/aitestharness_tools/exec/pools.py` | `desktop_pool`（容量 1，单屏独占）；计划声明 `pool:"desktop"` |
| CLI | `aitestharness-tools/aitestharness_tools/runtime_cli.py` | `desktop.snapshot` / `desktop.replay` 两个确定性工具入口 |
| 视觉层 | `scripts/desktop-visual.mjs` | Midscene `@midscene/computer`：截图→VLM 定位→动作；**命中后立即反查 UIA 锚点**（硬约束出口） |
| 动作模块 | `scripts/desktop-task.mjs` | doctor/snapshot/visual/replay；request_id 幂等回执；`execution/desktop.lock` 独占锁（死进程可接管） |
| 动作接入 | `scripts/structured-actions.mjs` | `desktop_task` 动作 + 阶段回执（audit/stage-tools）+ 工具闸门/用量；`execution_platform=desktop` |
| 闸门 | `scripts/tool-gate.mjs` | `desktop_task` 硬依赖 `desktop.snapshot`（停用即拦） |
| 阶段协议 | `scripts/stage-tool-scenarios.mjs` | execution 阶段桌面场景 + `desktopScenarioPrompt()` 轨道规则（进派发合同） |
| 计划 | `scripts/plan-run.mjs` | `execution_platform=desktop` → `desktop_test_agent` 角色 |
| 管理端登记 | `platform/packages/server/src/http/central-tools.ts` | 新增 `desktop` 分类 + 三个工具（含契约/实现路径/Agent 引用） |
| Agent 层 | `penguin/agents/desktop_test_agent/AGENTS.md`、`penguin/agents.json`、`test_agent/AGENTS.md`、`command-runtime.md` | 新角色 + 总控派发规则 + 公共运行规则 |
| 前端 | `platform/packages/web/src/features/qa/task-detail.tsx` | 执行视图新增「桌面自动化」档（platform=desktop 自动选中） |

### MCP 目录

| 层 | 文件 | 说明 |
|---|---|---|
| 迁移 | `platform/packages/server/src/db/migrations/steps/2026-11-21-mcp-server-catalog.ts` | `mcp_server_catalog` + 下发台账 + 审计表；`schema.ts` 同步 |
| 路由 | `platform/packages/server/src/http/routes/mcp-catalog.ts` | `/api/admin/mcp-servers`（`/api/admin/*` 前缀保证在所有部署形态落在本地执行）；连通测试复用 agent-config 的 `McpToolProvider` 探针；指派写 Agent `tools.mcpServers`（plugin=admin-catalog）+ 失效运行期；内置 `aitest-internal-tools` 出口 seed（需 `AITEST_ENGINE_ROOT`） |
| 装配 | `platform/packages/server/src/platform.ts` | 路由组件注册进 AgentsModule；`src/ifaces.json` 已重新生成 |
| 前端 | `platform/packages/web/src/features/admin/admin-mcp-page.tsx(+css)` | 管理后台「MCP 服务」页（/mcp）：列表/编辑/连通测试/下发/审计 |
| 注册 | `admin-system-pages.tsx`、`admin-layout.tsx`、`router.tsx` | 菜单键 mcp、图标、分发、路由五处注册 |

## 二、测试与校验（全绿）

- 引擎验收：`tests/acceptance/desktop-task.test.mjs` 7/7；受影响大套件（structured-actions / orchestration / command-runtime / stage-evidence）131/131。
- Python：`tests/smoke_desktop.py` 8/8；`smoke_tools.py`、`smoke_probe.py` 全过。
- 服务端：`mcp-catalog.test.ts` 9/9、`mcp-server-catalog-migration.test.ts` 2/2、`central-tools.test.ts` 7/7（36 工具 + desktop 分类）、`db-migrations`。
- Web：`admin-mcp-page` 7/7、`qa-execution-tab` 2/2、`admin-menu-normalization`（12 菜单含 mcp）。
- 契约：`check-tool-contract.mjs`（36 工具/登记一致）、`check-capability-source.mjs`（契约⊆出口）全过。
- 已知环境项：`release.mjs --check` 在重新构建并 `--stamp` 前会报产物与戳不一致——属构建前常态，不在本次源码修改范围。

## 三、部署（已执行，2026-11-21）

实际安装位置：`D:\AITestHarness`（AGENTS.md 旧记录 `E:\AItestHarness\installed` 已失效，待修订）。

已按序执行并全部通过校验：

1. 构建：web `npm run build`、desktop `npm run build`（tsup）；`release.mjs --stamp` → `--check` 一致（buildId 9581aff746a83d16）。
2. 任务保护核查：local-service status（desktopCount=0）、近 60 分钟无 run/会话活动 → `local-service.mjs pause D:\AITestHarness\installation.json`（stopped:true + 维护标记）。
3. 引擎同步：`deploy-engine-files.mjs D:\AITestHarness`（备份 `D:\backups\engine-files-2026-11-21T00-43-09-225Z`；清单内变更文件换件 + 重签 + checkSourceRuntime 自洽）。
4. 新增文件补拷（不在清单内的文件）：`scripts/desktop-visual.mjs`、`aitestharness_tools/probe/desktop_probe.py`、`aitestharness_tools/exec/desktop_engine.py`、`aitestharness-tools/tests/smoke_desktop.py`、`penguin/agents/desktop_test_agent/AGENTS.md`、docs 交接文档；另因安装副本的 aitestharness-tools 为裁剪子集（缺 `probe/base.py` 等 39 个文件），已从源码树镜像补齐。
5. 构建产物同步：`deploy-project-management-local.mjs D:\AITestHarness`（备份 `D:\backups\project-management-2026-11-21T00-44-15-035Z`，1133 文件校验通过）。
6. 运行时依赖：引擎根 `npm install @midscene/computer --no-save`（298 包，exports 验证通过）；runtime Python（无 pip，先 get-pip 引导）安装 `pywinauto 0.6.9`，pillow 已就绪。
7. 安装引擎真实验证：doctor（python/UIA/Midscene 全就绪）+ snapshot（104 元素、49 锚点，真实 UIA 枚举）。
8. `local-service.mjs resume` → 服务 ready（server pid 10004）。

> 注意：仓库根 `E:\AItestHarness` 与 AGENTS.md 描述的 `installed` 目录在本次交付时点不存在（docs/unified-local-workspace-2026-10-21.md 的迁移布局需复核）；实际安装路径以 `aitest-source-runtime.json` 所在目录为准。

## 四、验收指引

### A. MCP 目录闭环（无需视觉模型）

1. 管理后台 →「MCP 服务」（/mcp）：应看到内置 `aitest-internal-tools`（内置徽标、默认停用）。
2. 「启用」→「连通测试」：本机 spawn `central-mcp.mjs`，应列出 10 个阶段工具与延迟（tools/list 不需要 run 绑定）。
3. 「下发」→ 选项目 + Agent：Agent 详情 MCP 区出现条目（来源 admin-catalog）；管理页下发列表 +1，操作日志页/页面「最近变更」有 assign 记录。
4. 打开该 Agent 新会话：首跑出现 MCP 连接横幅（trace `mcp_connect_begin/end`、`tool_list_ready`）；tools/call 未绑运行时会被拒（既有契约不变）。
5. 边界核验：同名不同配置再下发 → 409；停用后下发 → 409；删除已下发条目 → 409；`${KEY}` 引用条目测试 → 提示不解析引用。

### B. 桌面 computer-use（需视觉模型）

1. 渠道管理配置视觉模型（DashScope qwen-vl 系列等 grounding 模型）。
2. 任一方式注入视觉模型环境变量（MIDSCENE_MODEL_NAME / MIDSCENE_OPENAI_BASE_URL / MIDSCENE_OPENAI_API_KEY），或在引擎根维护 `config/desktop-visual.json`（model_name/base_url + 密钥走环境变量）。
3. 桌面轨任务：总控 `plan_run(execution_platform=desktop)` → 派发 `desktop_test_agent` → 执行阶段任务详情出现「桌面自动化」档。
4. demo（记事本）：doctor（四项就绪）→ snapshot（控件树 + 锚点）→ visual locate("记事本的文件菜单")（回执含 anchor_ok=true 与截图）→ replay（按锚点零模型重放）。验证点：回执里 anchor 为 UIA 指纹、坐标只在 evidence_point/截图；desktop.lock 互斥生效。

## 五、本次明确不做

- M2b Web 探索视觉兜底、市场运营（发布/上传/审核）、RDP 远程桌面、剧本重放完整编排器（M4 全量）。
- `tool_degraded` 进最终报告（admin-tool-console §8 差距①）——本次未动。
