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
   - `cd platform/packages/server && npx tsc --noEmit -p .`
   - `cd platform/packages/web && npx tsc --noEmit -p .`
   - 涉及运行时行为时加 `npm run test:core`
4. **提交**：一条批次一个（或按逻辑分几个）commit，信息格式 `feat/fix/docs(域): 一句话说明`；推送自己的分支，交付 commit、变更清单、测试结果和真实运行回执。Codex 验收后合并到 `main`。
5. **打卡**：在 §5 表格记录状态、分支和 commit；未合并时不能写成已交付。

## 3. 冲突边界（不许主动触碰的文件面）

| 归属 | 文件/机制 |
|---|---|
| 已完成的批次 1 基线 | 工具执行通道（`central-tools`/`tool-gate`）、阶段检查回执与后台追溯。后续批次在其上扩展，不得把 Node 检查冒称 Python v3 IR 已执行 |
| 已由云端完成、勿回退 | 用户级模型配置（`user-models.ts`/`project-config-service` 共享模型机制）、渠道管理（`admin-channels-page.tsx`/`control-plane /channels`）、管理后台布局（`admin-layout.*`）、设置页模型卡片（`user-models-settings.tsx`） |
| 批次 2U | Agent 设置页平台工具只读区块（见 `gap-inventory-20261116.md` 追加节） |
| 无人认领可做 | CI tsc 门禁、e2e 冒烟三链、qa_* 索引清单（见 `db-table-audit-20261116.md` §A 档合并，动库前须用户点头） |

## 4. 后续批次开工卡

这张表接续 `docs/refactor-batches-v3.md` 已完成的 B1~B12，批次 1 指本轮统一工具通道。负责人是建议分工，用户可调整；同一文件面不要让两个 Agent 同时修改。每批先做确定性单测，再做一条真实场景；源码通过、构建部署和已安装实例验收分别记录。未具备环境或可信输入的能力记为 `pending`/`not_applicable`，不得伪造成功回执。

| 批次 / 建议负责人 | 目标与主要文件面 | 完成条件（DoD） | 依赖 |
|---|---|---|---|
| **1 统一工具通道 / Codex** | 已在 `main` 完成阶段场景映射、真实产物触发、运行回执与后台追溯；见 `docs/tool-integration-batch1-20261116.md` | 定向回归通过并合入 `main`；验证码自动登录不算本批完成，运行副本仍需单独核验 | 基线 |
| **1F 图形验证码自动登录 / Qoder** | `scripts/browser-task.mjs`、`scripts/structured-actions.mjs`、`scripts/login-captcha-chain.mjs` 及对应测试；详见 `docs/captcha-auto-login-followup-20261117.md` | 同一受控浏览器完成识别、填码、提交、成功判定与会话复用；低置信度和未知提交结果不盲重试；扫码/短信走人工；真实 gatewayadmin 场景有产品 run 回执，测试数据清理 | 1；可与 2 的非浏览器部分并行 |
| **2 环境与建档 / WorkBuddy** | 项目/环境数据模型、建档动作、`onboard.bootstrap` 受控调用、项目创建与环境页；覆盖 `gap-inventory` 的 B1/A1 | 地址归属环境实体；一次建档从授权地址产生可追溯 maps/页面与接口摘要；失败或无权限不生成成功状态；新旧项目兼容，真实环境演示可复跑 | 1 |
| **2U Agent 工具只读展示 / Qoder** | Agent 设置的工具标签与现有工具查询接口；只展示平台工具绑定、权限和启停，不在设置页修改授权 | 与工具管理的绑定一致，未授权不可见；保留内置工具区；前端测试和一条管理页面验收 | 1；与 2 分文件面并行 |
| **3 来源条款化与上下文装配 / Qoder** | 来源归档/版本、`knowledge.extract`/`knowledge.incremental`、`context_assembler` 到项目资料及对话注入；覆盖 A5/A6 | 原文位置、版本 diff、引用反查可见；对话只注入授权的相关片段并记录截断/预算；同一输入结果可复现，敏感内容不进普通日志 | 2 的环境/项目标识稳定后 |
| **4 可重放的 Web 执行 / WorkBuddy** | 浏览器 Driver、DSL/断言、页面资产库接线、执行预算与取证；先打通 Web 单类型，其他 Adapter 后排 | 授权站点的一条用例可固化、重放 N=3，结果及取证可对比；预算超限明确停止；未执行不得报通过；记录源码、隔离实例、已安装环境三层结果 | 1F、2、3 |
| **5 回归与审核 / Qoder** | 变更影响来源、回归三闸、flaky 隔离、确认卡点三层 UI 与报告 draft/reviewing/approved；覆盖 M3、A3/A4 | 同一变更得到稳定选集；不稳定用例不进入可靠通过率；硬闸失败阻止报告批准；确认抽样可复现且报告审批留审计 | 4 |
| **6 缺陷闭环与有效性基线 / WorkBuddy + 用户准备受控系统** | `defect.evidence` 的真实执行 IR、内置/外部提单、复测与知识回流；种子缺陷集单独保管 | 真实失败可取证、提单、复测、关闭，状态可追溯；在受控系统上记录召回、误报、错误通过率及样本分母；未建立种子集前不宣称有效性达标 | 4、5 |

每批验收由 Codex 检查：范围与契约、回归结果、真实 run 的输入/输出哈希和失败路径、运行副本部署及回滚记录。仅合成 fixture 通过时标“工程验证通过”，不写“真实业务闭环”。Python v3 IR 适配须使用已归档字段，缺字段就保持待适配；客户端版本协商和其他三类 Adapter 在 Web 纵向链稳定后另立批次。

## 5. 执行打卡

| 批次 | 状态 | commit | 备注 |
|---|---|---|---|
| 1 统一工具通道 | 已合入 `main`，运行副本待核验 | `6635ac9`（含 `89978ab`、`29e4cee`、`612a432`） | 阶段回执与后台查询已实现；验证码闭环另列 1F |
| 1F 图形验证码自动登录（工程部分） | 已提交待 Codex 验收（未合并） | `7e2e750`（分支 `qoder/batch-2u-20261117`，基线 `e05361a`，未推送） | 工程验证通过：`browser_task` 新增 `login_probe`/`login`，同一受控会话分类→识别（项目测试码优先、本地算术解析、低置信度不猜测）→填码→提交→成功断言；≤2 次提交、未知结果不重放、扫码/短信/滑块/点选走人工；会话 0600 受保护保存并先验证再复用。专项测试 11/11（合成站点）、browser 套件 96/96、core 1082/1088（4 失败为基线既有沙箱缺目录问题，已基线对照）、ci:tools 冒烟、irval 114、server/web tsc 通过。含测试基建两处同步：`run-engineering-tests.mjs` 套件注册一行、`engineering-runner.test.mjs` 分区断言。真实 gatewayadmin 自动登录+运营 Key 闭环验收待用户授权环境；此前 `login.captcha_chain` 只报分类或未完成 |
| 2 环境与建档 | WorkBuddy 进行中 | | 由 WorkBuddy 负责 |
| 2U Agent 工具只读展示 | 已提交待 Codex 验收（未合并） | `03392d3`（分支 `qoder/batch-2u-20261117`，基线 `e05361a`，未推送） | 工程验证通过：新增前端测试 6/6；ci:tools 冒烟、irval 114、server/web tsc 均通过；web 全量 4306 通过/46 失败均为基线既有（已做基线对照）。管理页面真实验收待部署核验 |
| 3 | 未开始 | | |
| 4 | 未开始 | | |
| 5 | 未开始 | | |
| 6 | 未开始 | | |

## 6. 已知坑（云端踩过，本地同样注意）

- `config/tool-runtime-state.json` 是运行时状态文件，会自己变脏——提交时**不要**带上它。
- 前端主题 token 是自定义的（`bg-surface-muted`/`border-line-muted`/`text-fg-subtle`），Tailwind 没有 `surface-card`/`scrollbar-thin`，用任意值语法 `[scrollbar-width:thin]`。
- 共享模型记录 schema 强校验：手工拼 `.account-models/*.json` 少字段会让建项目 500，写它必须走 `publishSharedModels`/`publishUserModelBlock` 同构组装。
- `readRaw` 会因磁盘 stat 清缓存：内存态视图要临时接管（参考 `modelViewOfRaw` 的做法）。
- Playwright 的 host 白名单只认 `localhost`（不是 127.0.0.1）。
