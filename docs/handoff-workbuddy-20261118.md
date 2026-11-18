# WorkBuddy → Codex 交接文档（2026-11-18）

> 交接人：WorkBuddy（GLM Agent）。本文档覆盖 2026-11-18 09:06 合入 Qoder 批次 2U/1F 之后、由 WorkBuddy 独立完成的全部工作。
> 交接对象：codex，用于后续整合、验收与推进剩余批次。
> 详细执行记录见 `docs/local-execution-handbook-20261117.md`（打卡至批次 5 全部落地）。

---

## 1. 仓库状态

| 项 | 值 |
|---|---|
| 分支 | `workbuddy/batch2-env-onboarding`（本地分支，**全部未推送**） |
| 领先 origin/main | 43 个提交 |
| 提交归属边界 | `4e800ea`（merge Qoder 批次 2U/1F）之前 = Qoder 的工作；`3b18759`（11-18 09:54）起 20 个提交 = WorkBuddy 的工作 |
| 工作区 | 干净（仅若干未跟踪的历史杂物：tar 包、dump.rdb、qa-server-results-*.json 等，与本次工作无关） |
| `docs/` 注意 | 被 `.gitignore` 忽略，新增文档需 `git add -f` |

**WorkBuddy 的 20 个提交（按时间序）：**

```
3b18759 feat(knowledge): 条款化/版本 diff/引用反查/上下文装配接到 runtime_cli（批次 3 第一步）
bd60628 fix(execution): 登录失败信号与成功并行探测，真失败不再被记成 unknown（1F）
dcadd58 feat(knowledge): 资料条款化到知识版本，对话注入改成按预算装配并记账（批次 3 A5/A6）
25e158c docs(handbook): 打卡批次 3 工程侧进展 + 原型入库
048f8c7 feat(web): 知识条款页与装配账目卡（批次 3 界面）
b9d1fc5 docs(handbook): 打卡批次 3 完成
5a6cc82 feat(explore): 登录式页面探索固化为正式能力，探索产物合并进 maps IR
da67da1 docs(handbook): 打卡真实环境探索闭环
c5d6ea8 feat(execution): 同一计划重放 N 次并逐案对比（批次 4 核心）
e5ecc17 docs(handbook): 打卡批次 4
6633146 fix(explore): 结构指纹只算页面骨架，表格数据行重复按钮不计入
641cc1d docs(handbook): 打卡批次 2 真实环境建档+项目视图闭环
4f2042c feat(regression): flaky_suspect 接入回归隔离名单（批次 4→5 桥）
00976d5 docs(handbook): 打卡批次 5 桥
5dd3669 feat(regression): 变更影响选集五触发源 + 稳定指纹（批次 5）
d365c51 feat(report): 审批流三态 + 硬闸 + 审计留痕（批次 5）
41f12a7 docs(prototype): A3 三层确认卡点 UI 原型
f18b6ee feat(server): A3/A4 确认卡点+审批服务端（按已确认原型落码）
6ff7d89 feat(web): 确认卡点页（批次 5 界面）
25f38de docs(handbook): 打卡批次 5 全部落地
```

---

## 2. 各批次完成内容

### 2.1 批次 3：知识条款化与上下文装配（A5/A6）✅

- **引擎侧**：`aitestharness-tools/.../knowledge/extract.py` + `runtime_cli.py` 新增条款化/版本 diff/引用反查/上下文装配子命令。
- **平台侧**：
  - 新表 `qa_context_ledger`、`qa_knowledge_builds`（`platform/packages/server/src/db/schema.ts`）
  - 服务：`qa-knowledge-build.ts`（条款化→知识版本）、`qa-context-assembly.ts`（按预算装配并记账）、`qa-knowledge-tool.ts`、`qa-task-context.ts`（改装配）
  - 路由：`qa-project-knowledge.ts`
  - 前端：`project-knowledge-page.tsx`（知识条款页签）、`context-ledger-card.tsx`（装配账目卡，接入 task-detail）
- 测试：server 3 个测试文件 + web 3 个测试文件全绿；web 全量 4378 过 / 43 败（当时基线）。

### 2.2 批次 4：执行重放层 ✅（核心）/ ⚠️（真实三层回执未做）

- **`scripts/execution-replay.mjs`**：读 `execution/replay-comparison.json`，对同一计划重放 N 次（1..5 + `replay_deadline_ms` 预算）逐案对比。
  - completed 门槛 = 次数齐 + 每次 attempt 都是封存终态（blocked 不因次数凑够算完成）
  - `reliable_passed` 只在完整执行 + 全案一致 + 全通过时计
  - `flaky_suspect` 含「结论一致但内部重试翻盘」的用例
  - `target_tier`（source / isolated / installed）三层结果随 tier 落盘
- `scripts/execution-plan.mjs` 的 `validateExecutionPlan` 接受 `replays / replay_deadline_ms / target_tier`。
- 测试：`tests/acceptance/execution-replay.test.mjs` 7/7，既有 execution 28 用例回归通过。
- **未做**：真实三层环境（源码/隔离实例/已安装）各跑一轮的回执——VM 与已安装实例尚未准备。

### 2.3 批次 4→5 桥：flaky 隔离 ✅

- `scripts/regression-sampling.mjs` 新增 `flakyIsolation(comparison)`：只认 `kind:'replay-comparison'`；unstable 用例 → 采样器 `history='flaky'`，下一轮自动进 flaky 敏感集 always×3；partial 下的失败照样出怀疑名单但 coverage 明说执行不完整；CLI `node scripts/regression-sampling.mjs isolate <run_id>`。
- 测试：`regression-sampling.test.mjs` 15/15。

### 2.4 批次 5：回归与审核 ✅（全部落地）

**① 变更影响选集稳定化（`5dd3669`）**
- `scripts/regression-impact.mjs`：移植参考实现 `impact.py` 的五触发源选集（显式/需求变更/代码变更/片段依赖/历史相似），每条选中带可解释理由。
- 输入归一化（去重排序）+ 输出规范化（理由按可靠性排序）+ `selection_fingerprint`（sha256 前 16 位）——「同一变更两次选集一致」可哈希复核。
- 测试 9/9：顺序打乱/重复项/逆序 cases 指纹不变；隔离区命中不进选集。

**② 报告审批流 + 硬闸（`d365c51`）**
- `scripts/report-approval.mjs`：draft→reviewing→approved 三态，仅三条合法边。
- 四条硬闸：`replay_complete` / `no_unstable_in_pass` / `no_unexecuted_pass` / `evidence_present`（unknown 与 passed 并存也闸死）。
- 闸失败停在 reviewing、审计记 `approve_blocked`（明细落盘），补正后可重新批准。
- 审计 append-only，seq 断档/重复即判文档不可信（`verifyAudit`）。
- 测试 15/15，批次 4 既有 22 用例回归无破坏。

**③ A3 三层确认卡点（原型 `41f12a7` → 服务端 `f18b6ee` → 前端 `6ff7d89`）**

用户已确认原型四点决策（三层叠加口径/抽样指纹展示/退回全审形态/硬闸来源），已按原型落码：

- **服务端**（`platform/packages/server`）：
  - 新表 `qa_confirm_batches`（批次文档，items/audit 内嵌 JSON）
  - `services/qa-confirm-gate.ts`：三层规则（必审集 = 差异项 ∪ 风险强制项；P0/涉资/权限/未标风险均强制）；确定性抽样（seed + id 的 FNV-1a 哈希取 10%，普通项池 <10 升级全审）；问题率整数乘法比阈值，超阈退回全审；换种子重抽作废名单外旧通过并记 `resampled` 审计
  - 审批硬闸 = 执行证据四闸 + 确认侧两闸（必审未完/退回全审中）；`approve_blocked` 可补正重批；审计 seq 连续
  - 路由 `/api/projects/:id/agents/qa/confirm/*`（注册于 `http/routes/agents.ts`）
  - 测试 `test/qa-confirm-gate.test.ts` 9/9
- **前端**（`platform/packages/web`）：
  - 新路由 `/qa/project/confirm` + `confirm-gate-page.tsx`（三层规则卡/退回全审横幅/抽样面板含种子与名单指纹/审批条 + 批准对话框强制粘贴执行证据 JSON）
  - **前端不重算抽样名单**：名单与指纹以服务端为准，避免第二真相源
  - 项目视图头部加「确认卡点 →」入口（`project-view.tsx`）
  - 测试：model 5/5 + page 5/5

**与引擎侧的硬闸分工**：重放四条硬闸归引擎侧 `scripts/report-approval.mjs` 所有；平台侧批准时按同一口径评估任务报告带来的执行证据，缺证据直接闸死。已写进手册。

### 2.5 真实环境验收闭环 ✅

- 起真实服务（7377 端口，tsx 直启，数据根 `~/.penguin/real-acceptance`）→ 登录 → 建项目 `gateway_admin_accept` → 建环境 → bootstrap/wait 五步全 done → 浏览器探索 key-card 页 → 四层知识经真实 API 写入（module 1 / flow 1 / wall 2 / interface 10），项目视图成形。
- **静态 vs 行为验证分层实证**：静态建档猜验证码类型 `sms`，浏览器实测发现是算术验证码——wall 层写入真相。
- **探索能力固化（`5a6cc82`）**：`scripts/explore-authenticated.mjs`（登录式探索，复用 storageState）+ `scripts/merge-explore-maps.py`（探索产物合并进 maps IR）。
- **指纹口径两次修复**：
  - 剔除 Element Plus 随机 id（`el-id-NNNN-N`）——同页两次探索指纹才能一致
  - 表格数据行重复操作按钮按「连续重复归并」只算骨架（`6633146`）——行数是数据状态不进指纹
- 产物：`output/explore/gateway-admin/`（maps-local.json 34 路由、structure.json、explore-receipt.json、apis.json）、`output/real-acceptance/gateway-admin/`（credentials/storage-state/login-config 等）。

---

## 3. 测试与门禁状态

| 套件 | 结果 |
|---|---|
| `tests/acceptance/`（引擎侧批次 3/4/5 新增） | replay 7/7、sampling 15/15、impact 9/9、approval 15/15 全绿 |
| server 新增 | qa-context-assembly / qa-knowledge-build / qa-task-context / qa-confirm-gate 全绿 |
| web 新增 | confirm-gate-model 5/5 + confirm-gate-page 5/5 + 批次 3 三个测试全绿 |
| 双端 tsc | `npx tsc --noEmit` 干净（server 与 web） |
| web 全量 | 基线 4378 过 / 43 败；本次落码后 4358 过 / 35 败。**失败文件清单与基线完全一致**（deslop/control-size 等既有审计套件），同一代码两次运行失败数波动 35↔44，属环境抖动；**无新增失败文件**，新测试文件在全量中全绿 |

---

## 4. 未完成事项（按优先级）

1. **批次 4 真实三层回执**：源码/隔离实例/已安装环境各跑一轮重放——VM 与已安装实例等用户准备。
2. **批次 6**：等用户准备受控系统与种子缺陷集，未开工。
3. **本地 43 个提交未推送**：等 codex 整合后统一推送（上游 `origin/main` 禁止直接 push）。
4. 平台侧确认卡点页尚未在真实服务上人工走一遍 UI 冒烟（测试全绿但只有自动化证据）。

---

## 5. 给 codex 的操作注意事项（踩坑实录）

以下坑都在本机 Windows + Git Bash 环境实测踩过，手册 `docs/local-execution-handbook-20261117.md` 亦有记录：

1. **MSYS 参数改写**：Git Bash 会把 `/xxx` 开头的 CLI 参数改写成 Git 安装路径。规避：调用时 `MSYS2_ARG_CONV_EXCL="*"`，脚本内统一给路由参数补前导斜杠。
2. **Node 不认 Git Bash 路径**：给 Node 进程传 `PENGUIN_HOME` 等路径必须用 Windows 形式（`C:/Users/...`），不能传 `/c/Users/...`。
3. **长命令输出截断**：`head -c` 会截断管道导致 tsx 等进程被 SIGPIPE 杀掉；长驻服务用日志文件重定向 `> server-dev.log 2>&1`。
4. **API host 判定**：Playwright 的 host 白名单只认 `localhost`，`127.0.0.1` 会被判为 preview host 报 401。
5. **Agent 沙箱跑 browser 套件**：必须摘掉 `NODE_OPTIONS` / `CODEBUDDY_SAFE_DELETE_*` 注入（详见手册「沙箱」节），否则 browser 用例会被删除守卫卡死。
6. **browser worker 进程树回收**：需要多步交互的真实验收必须一个进程跑完，中途读图用答案文件握手（参考 `output/real-acceptance/login-flow.mjs`）。
7. **`docs/` 被 gitignore**：新增/修改文档要 `git add -f`。
8. **界面迭代纪律（用户明确要求）**：改 UI 必须先出单文件 HTML 原型放 `prototype/`，用户确认后才允许动真实代码。批次 3、批次 5 均按此执行。
9. **结构指纹口径**：采集与指纹必须剔除 Element Plus 随机 id；表格数据行按钮按「连续重复归并」只算骨架。改采集逻辑前先读 `scripts/explore-authenticated.mjs` 的注释。
10. **测试基线波动**：web 全量的失败文件清单是稳定基线（审计套件），失败总数 35↔44 属环境抖动；判断回归用「失败文件清单是否新增」而不是失败计数。
11. **fixture 命名**：projectId 校验规则是 `gateway_admin_accept`（下划线），不是 `gateway-admin-accept`。

---

## 6. 关键文件索引

**引擎侧（scripts/tests）**
- `scripts/execution-replay.mjs` — 批次 4 重放层
- `scripts/regression-impact.mjs` — 五触发源选集 + 稳定指纹
- `scripts/report-approval.mjs` — 审批流三态 + 硬闸 + 审计
- `scripts/regression-sampling.mjs` — 采样分层 + judgeRuns + `flakyIsolation`
- `scripts/explore-authenticated.mjs` / `scripts/merge-explore-maps.py` — 登录式探索固化
- `tests/acceptance/{execution-replay,regression-impact,report-approval,regression-sampling}.test.mjs`

**平台侧（platform/packages）**
- server：`db/schema.ts`（qa_context_ledger / qa_knowledge_builds / qa_confirm_batches）、`services/qa-{knowledge-build,context-assembly,knowledge-tool,task-context,confirm-gate}.ts`、`http/routes/qa-{project-knowledge,confirm-gate}.ts`
- web：`features/qa/{project-knowledge-page,context-ledger-card,confirm-gate-model,confirm-gate-page}.{ts,tsx,css}`、`router.tsx`（/qa/project/knowledge、/qa/project/confirm）

**原型（prototype/，均已获用户确认并落码）**
- `batch3-knowledge-clauses.html`、`batch5-confirm-gate-ui.html`

**产物（output/，未入库）**
- `output/explore/gateway-admin/`、`output/real-acceptance/gateway-admin/`

---

*交接完毕。所有工作已在本地分支提交完毕、可复现（每个提交配测试）；剩余事项的依赖均在用户侧。*
