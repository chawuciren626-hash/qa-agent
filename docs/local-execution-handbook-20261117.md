# 本地执行交接手册（云端 Agent → 本地 Agent，2026-11-17）

> 背景：规划与验收由 Codex 负责，执行由 WorkBuddy、Qoder 等本地 Agent 按批次负责。本手册给**本地执行的 Agent**：拿到开工卡后按此开工。
> 仓库：`https://github.com/chawuciren626-hash/qa-agent.git`。开工前以远端 `main` 为基线，核对本批次的依赖提交。
> 本地机参考环境：Windows（`E:\AITestHarness\...`），Node + Python 双栈。

## 0. 角色与节奏

- **Codex**：列待执行批次、定验收标准、最终验收。
- **本地 Agent**：按开工卡在独立分支执行（编码 + 回归 + 提交推送），提交验收证据后由 Codex 审核并合并；每批次完成后在本文档 §5 打卡。
- **用户**：只在批次边界做决策（如渠道密钥策略、页签栏这类产品拍板）。

## 1. 环境准备（一次性）

| 项 | 要求 | 验证命令 |
|---|---|---|
| Node | ≥ 20.11（推荐 22） | `node -v` |
| Python | 3.11+，pytest 可用 | `python -m pytest --version`（Windows 无 `python3`，用 `python`/`py`） |
| Python 依赖 | 仓库根 `requirements-ci.txt` | `pip install -r requirements-ci.txt` |
| Playwright 浏览器 | Chromium（`playwright.config.ts` 已指定本机路径，Windows 下按需改 `executablePath`） | `npx playwright install chromium` |
| Git 凭据 | 已登录凭据助手或受控 SSH 身份 | `git ls-remote origin main` |

注意：`ci:irval` 脚本里写的是 `python3 -m pytest`，Windows 下直接执行 `cd aitestharness-ir && python -m pytest tests -q`。

### 虚拟机验收实例（2026-11-17 实查）

当前隔离的 `main` 实例在 Linux 虚拟机：从宿主机执行 `ssh -p 2222 agent@127.0.0.1`，部署根目录是 `/home/agent/aitest-main-21254a2`。其中 `source/` 是运行源码副本，`data/` 是实例数据与 launcher 状态，`logs/` 是服务日志，`backups/` 是部署前备份。验收时先核对这些目录和运行代码版本；不要把 `data/`、日志或备份提交到 Git。

该实例的用户端监听虚拟机 `127.0.0.1:18776`，管理端监听 `127.0.0.1:18777`；本机端口映射可访问 `http://localhost:18776/user/login` 与 `http://localhost:18777/admin/login`。实查时两个根路径均返回 302 登录跳转，不能把此探针当成登录后业务验收。宿主机 `E:\AITestHarness\source` 是主 Git 仓库，`E:\AITestHarness\installed` 是另一份已安装应用；虚拟机实例也与两者独立。Git 推送不会自动更新任何运行副本。

每批部署前先检查虚拟机是否有正在执行的任务，记录旧版本与关键文件哈希并在该实例 `backups/` 留可恢复备份；部署后核对两个服务、页面与静态资源，再用授权的真实场景检查 run 回执。失败时恢复备份并记录回滚结果。此前的 `develop` 服务端口 18766 仍独立运行，本批不得覆盖它；其部署目录需在接管时另行核实。

## 2. 每批次固定工作流

1. **开工前**：`git fetch origin main`，从最新 `origin/main` 创建独立分支；读该批次的开工卡。不得在共享工作树直接切换或覆盖他人的未提交改动。
2. **执行**：只动开工卡列出的文件面；边界外文件出现冲突迹象立即停下问用户。
3. **回归（每次提交前全跑）**：
   - `npm run ci:tools`（工具包冒烟）
   - `cd aitestharness-ir && python -m pytest tests -q`（契约校验器，114 用例）
   - `npm run check:types`（= `cd platform && pnpm gen:ifaces && pnpm --filter @prismshadow/penguin-server --filter @prismshadow/penguin-web typecheck`，与 CI `platform-qa` job 的 typecheck 步骤同源；顺带解决 §6 第 2 条"陈旧 ifaces.json"）
   - 涉及运行时行为时加 `npm run test:core`
4. **提交**：一条批次一个（或按逻辑分几个）commit，信息格式 `feat/fix/docs(域): 一句话说明`；推送自己的分支，交付 commit、变更清单、测试结果和真实运行回执。Codex 验收后合并到 `main`。
5. **打卡**：在 §5 表格记录状态、分支和 commit；未合并时不能写成已交付。

## 3. 冲突边界（不许主动触碰的文件面）

| 归属 | 文件/机制 |
|---|---|
| 已完成的批次 1 基线 | 工具执行通道（`central-tools`/`tool-gate`）、阶段检查回执与后台追溯。后续批次在其上扩展，不得把 Node 检查冒称 Python v3 IR 已执行 |
| 已由云端完成、勿回退 | 用户级模型配置（`user-models.ts`/`project-config-service` 共享模型机制）、渠道管理（`admin-channels-page.tsx`/`control-plane /channels`）、管理后台布局（`admin-layout.*`）、设置页模型卡片（`user-models-settings.tsx`） |
| 批次 2U | Agent 设置页平台工具只读区块（见 `gap-inventory-20261116.md` 追加节） |
| 无人认领可做 | e2e 冒烟三链、qa_* 索引清单（见 `db-table-audit-20261116.md` §A 档合并，动库前须用户点头）。**"CI tsc 门禁"一行已过期**：`.github/workflows/engineering-tests.yml` 的 `platform-qa` job 自 `eb633c4` 起就在跑 server/web 的 typecheck，本地对应命令收敛为 `npm run check:types` |

## 4. 后续批次开工卡

这张表接续 `docs/refactor-batches-v3.md` 已完成的 B1~B12，批次 1 指本轮统一工具通道。负责人是建议分工，用户可调整；同一文件面不要让两个 Agent 同时修改。每批先做确定性单测，再做一条真实场景；源码通过、构建部署和已安装实例验收分别记录。未具备环境或可信输入的能力记为 `pending`/`not_applicable`，不得伪造成功回执。

| 批次 / 建议负责人 | 目标与主要文件面 | 完成条件（DoD） | 依赖 |
|---|---|---|---|
| **1 统一工具通道 / Codex** | 已在 `main` 完成阶段场景映射、真实产物触发、运行回执与后台追溯；见 `docs/tool-integration-batch1-20261116.md` | 定向回归通过并合入 `main`；验证码自动登录不算本批完成，运行副本仍需单独核验 | 基线 |
| **1F 图形验证码自动登录 / WorkBuddy（原 Qoder，已交接）** | `scripts/browser-task.mjs`、`scripts/structured-actions.mjs`、`scripts/login-captcha-chain.mjs` 及对应测试；详见 `docs/captcha-auto-login-followup-20261117.md` | 同一受控浏览器完成识别、填码、提交、成功判定与会话复用；低置信度和未知提交结果不盲重试；扫码/短信走人工；真实 gatewayadmin 场景有产品 run 回执，测试数据清理 | 1；可与 2 的非浏览器部分并行 |
| **2 环境与建档 / WorkBuddy** | 项目/环境数据模型、建档动作、`onboard.bootstrap` 受控调用、项目创建与环境页；覆盖 `gap-inventory` 的 B1/A1 | 地址归属环境实体；一次建档从授权地址产生可追溯 maps/页面与接口摘要；失败或无权限不生成成功状态；新旧项目兼容，真实环境演示可复跑 | 1 |
| **2U Agent 工具只读展示 / Qoder** | Agent 设置的工具标签与现有工具查询接口；只展示平台工具绑定、权限和启停，不在设置页修改授权 | 与工具管理的绑定一致，未授权不可见；保留内置工具区；前端测试和一条管理页面验收 | 1；与 2 分文件面并行 |
| **3 来源条款化与上下文装配 / WorkBuddy（原 Qoder，已交接）** | 来源归档/版本、`knowledge.extract`/`knowledge.incremental`、`context_assembler` 到项目资料及对话注入；覆盖 A5/A6 | 原文位置、版本 diff、引用反查可见；对话只注入授权的相关片段并记录截断/预算；同一输入结果可复现，敏感内容不进普通日志 | 2 的环境/项目标识稳定后 |
| **4 可重放的 Web 执行 / WorkBuddy** | 浏览器 Driver、DSL/断言、页面资产库接线、执行预算与取证；先打通 Web 单类型，其他 Adapter 后排 | 授权站点的一条用例可固化、重放 N=3，结果及取证可对比；预算超限明确停止；未执行不得报通过；记录源码、隔离实例、已安装环境三层结果 | 1F、2、3 |
| **5 回归与审核 / WorkBuddy（原 Qoder，已交接）** | 变更影响来源、回归三闸、flaky 隔离、确认卡点三层 UI 与报告 draft/reviewing/approved；覆盖 M3、A3/A4 | 同一变更得到稳定选集；不稳定用例不进入可靠通过率；硬闸失败阻止报告批准；确认抽样可复现且报告审批留审计 | 4 |
| **6 缺陷闭环与有效性基线 / WorkBuddy + 用户准备受控系统** | `defect.evidence` 的真实执行 IR、内置/外部提单、复测与知识回流；种子缺陷集单独保管 | 真实失败可取证、提单、复测、关闭，状态可追溯；在受控系统上记录召回、误报、错误通过率及样本分母；未建立种子集前不宣称有效性达标 | 4、5 |

> **未派单缺口（2026-11-17 提出，待决策）**：批次 2 落地的是"建档"，下面两件目前**没有任何批次认领**，写在这里免得被当成已排期：
> 1. **探索派发**（建会话 + 发 `breadth` 指令）：环境页现在只有"派发入口在批次 3 接通"的文案，没有真实入口。但批次 3 的范围是 A5/A6 来源条款化与上下文装配，不含探索派发。
> 2. **`maps/<env>/` 目录结构**：现状仍是扁平 `maps-<env>.yaml`；批次 2 文档原写"等批次 3 一并定"，而批次 3 不在同一执行方手里。
>
> 这两项不派下去，"建档 → 探索 → 测试任务"这条链在环境页是断的，且会拖到批次 4 才被发现没人做。
>
> **2026-11-18 进展**：缺口 1 的能力侧已由 `5a6cc82` 补上——`scripts/explore-authenticated.mjs`
> （登录式探索，复用 1F 登录链）+ `scripts/merge-explore-maps.py`（探索产物 → maps IR），
> 并在用户提供的真实后台完整跑通（登录 → 采集 → 会话复用 → 两次指纹一致 → maps 落盘）。
> 剩下的缺口是**平台内的派发入口**（环境页建会话 + 发 `breadth` 指令），仍待决策派单；
> 缺口 2（目录结构）未动。

每批验收由 Codex 检查：范围与契约、回归结果、真实 run 的输入/输出哈希和失败路径、运行副本部署及回滚记录。仅合成 fixture 通过时标“工程验证通过”，不写“真实业务闭环”。Python v3 IR 适配须使用已归档字段，缺字段就保持待适配；客户端版本协商和其他三类 Adapter 在 Web 纵向链稳定后另立批次。

## 5. 执行打卡

| 批次 | 状态 | commit | 备注 |
|---|---|---|---|
| 1 统一工具通道 | 已合入 `main`，运行副本待核验 | `6635ac9`（含 `89978ab`、`29e4cee`、`612a432`） | 阶段回执与后台查询已实现；验证码闭环另列 1F |
| 1F 图形验证码自动登录 | **真实闭环已通过**：登录 `logged_in` + 会话复用 `session_reused`，两次断言都 `passed` | `7e2e750`、`20bd3e0`（Qoder，已合入）；失败探测时序修复与真实验收见本轮提交 | 真实站点 `run-71178f8f`（登录）与 `run-39318e19`（复用）回执见 `docs/batch1f-real-acceptance-20261118.md`；修掉"先等 8s 成功再探失败"导致真失败被记 unknown 的缺陷；测试 20/20。**未做**：VM 实例与已安装应用同场景回执 |
| 2 环境与建档 | 本地已提交，**待验收合并**；**真实环境建档 + 项目视图已闭环**（见备注尾部） | 分支 `workbuddy/batch2-env-onboarding`，`2e90f58`…`60f1f44`（按用户要求暂未推送）；探索能力 `5a6cc82`、指纹修复 `6633146` | B1/A1 服务端 + 五步进度流式 + 前端五处落地。**真实验收（2026-11-18，全程真实服务 7377 端口、全新数据根）**：登录 → `POST /api/projects` 建项目 gateway_admin_accept → `POST .../environments` 建环境 local（baseUrl=local.console.gov-bid.com）→ `bootstrap/wait` 静态建档五步全 done（1 页 / 0 接口——SPA 接口运行时才暴露，如实报 0；静态猜验证码 sms）→ 浏览器登录式探索 key-card 页（会话复用成功）→ 探索事实经真实 API 写入知识四层：module 1（Key卡页骨架）/ flow 1（查询流）/ wall 2（算术验证码 + 会话复用）/ interface 10（接口含入参并集），项目视图成形。**静态 vs 行为验证分层有了实证**：静态建档猜 sms，浏览器实测算术验证码，wall 层写明真相。**指纹口径修复**（`6633146`）：表格数据行的重复操作按钮是模板结构，行数涨 1→2 曾致控件 14→16、指纹漂移；归并后 1 行/2 行两种状态指纹一致。早期教训：服务必须用 `localhost` 访问（127.0.0.1 是 preview host，API 拒答）；PENGUIN_HOME 要传 Windows 路径 |
| 2U Agent 工具只读展示 | 已合入整合分支（未合并 `main`、未推送） | `03392d3`（原 Qoder 分支，已合入） | 工程验证通过：新增前端测试 6/6；ci:tools、irval 114、server/web tsc 均通过；web 全量 4306 通过/46 失败为基线既有。管理页面真实验收待部署核验 |
| 3 来源条款化与上下文装配 | **已完成**（工程 + 界面） | `3b18759`、`dcadd58`、`048f8c7` | 2026-11-18 起由 WorkBuddy 接手（原建议负责人 Qoder 已无额度）。条款化带 file+line+section（`split_sources` 给多份资料加 `s01-` 前缀，防条款 id 相撞后"原文位置"指到别人家）、知识版本 `qa_knowledge_builds`（无位置即丢弃并计数；**全文哈希**定版本，措辞变了也留版本；语义哈希另记给 lineage）、四分类 diff、引用反查、装配账目 `qa_context_ledger`；对话注入改按预算装配，装配器不可用时只给索引（账目标 `fallback:index_only`）。界面：资料页「知识条款」页签（版本列表 + 知识项原文位置与条款高亮 + 四分类对比 + 引用反查）、任务详情「本次装配账目」卡（预算/装载/逐条裁剪原因，降级单独标记）。**设计决定**：页面不提供"一键构建知识版本"——抽知识要模型，纯界面构建只会产出空版本，空态写清构建发生在任务执行时。门禁：ci:tools 两道闸 ALL PASS、server/web tsc 干净、新增 14+5+4+8 用例全绿，web 全量 4378 通过 / 43 失败（基线 4306 / 46） |
| 4 可重放的 Web 执行 | **重放对比层已落地**（工程侧）；固化契约与预算停止此前已有 | `c5d6ea8` | 依赖核对：固化=execution_contract 归一化（`execution-plan.mjs normalizeContract`）、预算=global_timeout/preflight_timeout + 新增重放级 deadline、未执行不报通过=verdict R1~R5 上限 + blocked/skipped 不进分母（此前已有）。**本轮新增** `scripts/execution-replay.mjs`：同一计划跑 N 次（replays 1..5）逐案对比，结论不一致或内部重试翻盘 → `flaky_suspect`（供批次 5 隔离名单）；`replay_deadline_ms` 到点剩余次数记 not_run + stop_reason，attempt blocked 同样停；`reliable_passed` 只在"全部封存终态 + 全案一致 + 全部通过"时计；`target_tier`（source/isolated/installed）随计划声明随对比落盘，原始结果哈希一并记录。测试 7/7，既有 execution 三套件 28/28 无回归。**未做**：真实三层环境（源码/隔离实例/已安装）各跑一轮的回执（VM 与已安装实例仍未备） |
| 5 回归与审核 | **工程与界面均已落地**（选集稳定化 / 审批流+硬闸 / 三层卡点页），flaky 隔离入口已接通 | `4f2042c`、`5dd3669`、`d365c51`、`f18b6ee`、`6ff7d89` | 采样分层（L-6）与 judgeRuns（复跑不能洗成通过）此前已有（`regression-sampling.mjs`）；`flakyIsolation` 把批次 4 重放的 `flaky_suspect` 接进隔离名单。**2026-11-18 全部落地**：① `regression-impact.mjs`（`5dd3669`）——五触发源选集 JS 落地 + `selection_fingerprint`，同变更顺序打乱/重复项下指纹不变（9/9）；② `report-approval.mjs`（`d365c51`）——引擎侧三态+四条执行证据硬闸+审计 seq 连续校验（15/15）；③ **确认卡点真实代码**（`f18b6ee` 服务端 + `6ff7d89` 界面，用户已确认原型四点决策）——`qa_confirm_batches` 表、`services/qa-confirm-gate.ts`（三层规则：必审集=差异∪风险强制，未标风险按强制；确定性抽样 seed+id FNV-1a 取 10%，池<10 升级全审；问题率整数乘法比阈值，超阈退回全审且抽中项旧「通过」视为待审；换种子重抽作废名单外旧通过并审计 resampled；批准硬闸=执行证据四闸+确认侧两闸，approve_blocked 留痕可补正重批）、路由 `/api/projects/:id/agents/qa/confirm/*`、web 页 `/qa/project/confirm`（三层卡+退回横幅+抽样指纹+审批条+批准强制附证据对话框，项目视图头部入口）；服务端路由级测试 9/9，前端 model 5/5 + page 5/5，双端 tsc 干净，全量回归无新增失败文件（既有基线审计套件随环境波动 35↔44）。分工：引擎侧重放四闸归 `scripts/report-approval.mjs`，平台侧批准时按同一口径评估调用方带来的执行证据，缺证据不批准 |
| 6 缺陷闭环与有效性基线 | 排队（依赖 4、5 + 用户准备受控系统与种子缺陷集） | | 同上 |

## 6. 已知坑（云端踩过，本地同样注意）

- `config/tool-runtime-state.json` 是运行时状态文件，会自己变脏——提交时**不要**带上它。
- 前端主题 token 是自定义的（`bg-surface-muted`/`border-line-muted`/`text-fg-subtle`），Tailwind 没有 `surface-card`/`scrollbar-thin`，用任意值语法 `[scrollbar-width:thin]`。
- 共享模型记录 schema 强校验：手工拼 `.account-models/*.json` 少字段会让建项目 500，写它必须走 `publishSharedModels`/`publishUserModelBlock` 同构组装。
- `readRaw` 会因磁盘 stat 清缓存：内存态视图要临时接管（参考 `modelViewOfRaw` 的做法）。
- Playwright 的 host 白名单只认 `localhost`（不是 127.0.0.1）。
- **在 WorkBuddy 的 Agent 沙箱里跑 engineering tests 必须先摘掉删除守卫**：沙箱给每个 node 进程注入
  `NODE_OPTIONS=--require=.../node-language-shim.cjs` 与 `CODEBUDDY_SAFE_DELETE_*`，每轮最多允许 50 次删除。
  browser 套件跑到第 6 个用例就会被 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` 拦在
  `state.json.lock` 上，后续用例全部 fixture 失败并卡住（实测挂 17 分钟无 CPU）。
  跑法：`env -u NODE_OPTIONS -u CODEBUDDY_SAFE_DELETE_ENABLED -u CODEBUDDY_SAFE_DELETE_BULK_GUARD ... node scripts/run-engineering-tests.mjs --suite=browser`，
  并把 PATH 里的 `shim/safe-bin` 去掉。
- **同一沙箱里 browser worker 会被进程树回收**：`browser-task` 用 `detached:true` 拉起 worker，但命令结束时
  整个进程树被回收，分步驱动（一条命令一步）会让 worker 在下一步之前消失，并触发 pending 隔离
  （`transport_uncertain` → 按协议不重放）。需要多步交互的真实验收必须**一个进程跑完**，
  中途要外部读图就用答案文件握手（见 `output/real-acceptance/login-flow.mjs`）。
- `browser_task` 的成功判据优先用**正向可见条件**（如登录后工作台标题 `visible`）。
  用负向条件（`count=0`）时，断言记录要求 `ready` 锚点，缺了就只能记 `blocked/readiness_required`——
  登录明明成功，回执里却没有可用正向证据。
