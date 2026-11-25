# Codex 部署交接清单：门禁去复杂度批次（2026-11-24）

> 交接人：本地 Agent。部署执行：Codex。原则沿用 `docs/local-build-merge-deploy-runbook-2026-11-21.md`：源码 ≠ 运行版，走官方脚本（pause → 同步 → 自校验 → resume），禁止直拷。
> 本批次**只改引擎脚本**（`scripts/`）+ 测试 + 发布清单，无 core 引擎、无服务端、无前端、无数据库迁移。
> 详细的问题分析与卡死点清单见 `docs/gate-audit-20261124.md`。

## 1. 提交清单

| 提交 | 标题 | 涉及范围 |
| --- | --- | --- |
| `e9bcc5e` | 删除只对历史 trace 生效的 shell 语法白名单 | `scripts/child-command-policy.mjs` + 2 测试 |
| `6546f4e` | 恢复特例收敛为单条 `recordedCorrection` 规则 | `scripts/child-command-policy.mjs` + 1 测试 |
| `4df9a53` | 一次校验只读一遍 trace，拒绝改成可执行的下一条命令 | 6 个 `scripts/` + 1 测试 |
| `1dcd6cf` | 门禁去复杂度（删历史文法 / 收敛纠正判据 / trace 单次解析） | 7 个 `scripts/`（含新增 `hook-denial.mjs`）+ 7 测试 |
| `cbc51f3` | 发布清单补 `scripts/hook-denial.mjs` | `config/release-resources.json` |
| `89b995a` | 审计文档补部署项与沙箱测试前置条件 | `docs/gate-audit-20261124.md` |

**`cbc51f3` 不是可选项。** 发布清单是显式白名单（469 条），`deploy-engine-files.mjs` 由它推导 `engine_files`。
名单里没有 `scripts/hook-denial.mjs` → 该文件不会进安装副本 → 引擎 import 时直接 `ERR_MODULE_NOT_FOUND`，
所有门禁 hook 一起挂。**只拉 `1dcd6cf` 不拉 `cbc51f3` 等于直接把引擎打死。**

## 2. 行为变化（部署后现场会有什么不同）

| 变化 | 部署前 | 部署后 |
| --- | --- | --- |
| 子代理跑 shell 探测命令 | 引擎侧有一套历史文法在事后"追认豁免" | 文法整段删除，只认受控命令白名单。这些命令本来 100% 被 hook 在执行前拒掉（实测 11 月子会话 388 条非受控命令无一放行），所以**实际放行行为不变**，变化是执行过的探测再也不能被后续成功"洗白" |
| handoff 卡死 | 同一 dispatch 两次提醒后永久 `stop`，用户发新消息也救不回来 | 提醒额度按用户轮次计；新用户消息即恢复。`stop` 文案从"报告工程限制"改成"告诉用户这个阶段没启动，问是否重派" |
| 纠正欠账 | 遗留 receipt 的 `recovery.key` 是类别标签（如 `input_correction`），永远清不掉；未选动作的请求级纠正会被 retry 预算误杀 | 非任务键回退到回执自己的 `task_key`；请求级纠正不受预算约束 |
| 后台 catalog 探测 | 必须"恰好一次静默轮询"才算合规，多看一次就留欠账 | 每次轮询都静默即合规（`every`），有内容返回仍判非静默 |
| 一次 handoff 的 trace 解析 | 同一份 trace 解析 4–8 遍（3.1k 行约 66–76ms/次） | 一个 hook 决策共用一份快照，解析 1 遍 |
| 死代码 | `handoffReminder`（生产零调用方，仅测试引用） | 已删除。`penguin/hooks/qa-delegation-guard/finish.mjs` 只用 `reconcileHandoff`，不受影响 |

## 3. 已做验证（部署前基线）

| 检查 | 结果 |
| --- | --- |
| `structured-actions.test.mjs` 全量 | **85/85 通过** |
| `child-history-recovery` / `delegation-stopped` / `independent-task` / `parallel-task-scheduling` | 通过 |
| `deploy-engine-files.test.mjs` | 2/2 通过 |
| `node scripts/check-release-resources.mjs` | `allowlist_valid`，469 文件 |
| 8 个改动脚本 `node --check` | 全通过 |
| `handoffReminder` 残留引用 | `scripts/` 下 0 处 |

**未重跑（不要当成已验证）**：`requirement-provenance` / `stage-recovery` / `orchestration` 三个文件本轮因用户中止批量执行没有重跑，
它们只改了 `--skills` 参数和 `inspectHandoff` 断言。部署后按 §6 第 4 条补跑即可。
存量问题不在本批次范围：`core/test/environment.test.ts:1750` 的 TS 错误、web 全量套件约 45 个文件失败（基线即有）。

## 4. 部署方式（二选一）

### 方案 A（推荐，最小风险）：只 cherry-pick 门禁批次

这 6 个提交与本地 main 上夹在中间的平台批次**文件零重叠**（已用 `comm` 比对确认），可以干净摘出。

```bash
git cherry-pick e9bcc5e 6546f4e 4df9a53 1dcd6cf cbc51f3 89b995a
node scripts/check-release-resources.mjs   # 必须 allowlist_valid
```

需要重新构建：**无**。本批次没有 `platform/packages/core` 改动，`core/dist` 不用重建。

### 方案 B：直接部署 main HEAD（`ed6abd5`）

会把中间的平台批次一并带上：`f9dcc4f` `178f846` `294f5a8` `d156469` `a8bbbd3`（task-platform / web / 平台资料），
以及之后的 `d95ff04` `f1e5342` `ed6abd5`（web 路由与登录面）。**这条路线必须构建 web 与 server**，不是纯引擎部署。

> 工作区里还有一批**未提交**的 remote-client / 单实例改造（`platform/packages/desktop/*`、`scripts/product-*.mjs`、
> `scripts/client-connection.mjs`、`tests/acceptance/remote-client.test.mjs` 等）。它们不在任何提交里，
> 部署 main HEAD 不会带上，也不该由本清单授权部署。

## 5. 部署步骤（按 runbook §7–§8）

```powershell
# 1. 安全暂停（客户端从托盘正常退出，确认 desktopCount=0）
node scripts/local-service.mjs status E:/AITestHarness/installed/installation.json
node scripts/local-service.mjs pause  E:/AITestHarness/installed/installation.json

# 2. 同步引擎文件（安装根以 installation.json 所在目录为准）
node scripts/deploy-engine-files.mjs E:/AITestHarness/installed

# 3. 恢复并确认
node scripts/local-service.mjs resume E:/AITestHarness/installed/installation.json
node scripts/local-service.mjs status E:/AITestHarness/installed/installation.json
```

方案 B 另需：`deploy-project-management-local.mjs` + web/server 构建，顺序按 runbook §5（server 与 web 不并行）。
平台那批（`d156469` `a8bbbd3` `ed6abd5`）另有独立清单 `docs/部署清单-平台资料四tab与流程闭环-2026-11-24.md`，
两批可以分别部署：先按本清单同步引擎（不重启前端资源），再按平台清单构建部署 web/server。

同步后必须核对一件事：**`hook-denial.mjs` 出现在引擎副本里，且 `aitest-source-runtime.json` 的 `engine_files` 含该键**。
只看"脚本报成功"不够——`deploy-engine-files.mjs` 只同步清单内的文件，清单漏项它会安静地不同步。

## 6. 部署后验收

1. `checkSourceRuntime` 报 `source_runtime_verified`，`engine_files` 数量比部署前多 1（新增 `hook-denial.mjs`）。
2. 引擎副本中存在 `<engine>/scripts/hook-denial.mjs`，且与源码 SHA256 一致。
3. 服务 `ready=true` / `error=null`；跑一个最小干跑（如 `node scripts/project-action.mjs` 的 catalog 类只读动作），
   确认没有 `ERR_MODULE_NOT_FOUND` 或 `denialRecorded is not a function` 这类 import 期错误。
4. 补跑未验证的三个文件：
   ```bash
   CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=1000000 \
     node scripts/run-engineering-tests.mjs tests/acceptance/orchestration.test.mjs \
     tests/acceptance/stage-recovery.test.mjs tests/acceptance/requirement-provenance.test.mjs
   ```
   （串行跑，别与其他套件并行。若在 Agent 沙箱里跑，阈值必须抬高，否则会伪报大批失败。）
5. 取一个此前卡在 handoff 的 run，重试一次 handoff。**不重跑子任务、不重派发**。
6. 取一个此前因「Registered child was not launched after two internal reminders」被 stop 的 run，
   发一条新用户消息，确认 hook 回到 `continue` 并给出 `run_subagent` 指令，而不是继续 `stop`。

验收边界：自动化用例通过、服务 ready，不等于真实模型请求已跑通。第 5、6 条是唯一能证明"卡死真的解了"的现场证据；
如果这两个 run 已不存在，如实记为"未执行现场复现"，不要用单测替代。

## 7. 回滚

- 6 个提交互相独立，可单独 `git revert`。`4df9a53` 与 `1dcd6cf` 的缓存参数都是可选（默认 `null`），旧调用点行为不变。
- **顺序约束**：`1dcd6cf` 与 `cbc51f3` 必须一起回滚，且先 revert `1dcd6cf` 再 revert `cbc51f3`。
  反过来会留下"清单指向不存在的文件"，部署脚本直接失败。
- 回滚 `1dcd6cf` 会恢复 `handoffReminder` 导出。当前 `scripts/` 下无引用，测试也已改为断言 `inspectHandoff` 抛错，
  回滚后需连带恢复 `tests/acceptance/orchestration.test.mjs` 的旧断言。
- 引擎回滚用引擎同步脚本的备份（按同步逆序恢复，配对应阶段的清单），不要手工改哈希。

## 8. 已知边界（不是缺陷，但要知道）

- **`recordedCorrection` 判据收紧是有意的**。旧 trace 若缺 `recovery` 台账，原本靠 error 文案兜底的"纠正"
  现在会被判为未解决，表现为 handoff 仍报欠账。原则是"宁可报欠账，也不把未验证的东西洗成通过"。
  这类历史 run 不可自愈，重试仍失败属预期，不要当部署回退。
- `docs/gate-audit-20261124.md` 不在发布白名单里，不会进安装副本——它只是仓库内文档。
- 发布清单里 `scripts/hook-denial.mjs` 插在 `child-command-policy.mjs` 之后，不是严格字典序；
  `check-release-resources.mjs` 不校验排序，无需调整。

## 9. 首轮部署未完成的现场核对（2026-11-25 09:20，只读实测）

部署方回报"门禁部分只做了代码检查和部分回归，安装副本缺 `hook-denial.mjs`、运行清单未登记"。核对结果：
**症状描述准确，但范围比他讲的更大——不是漏一个文件，是 `1dcd6cf` 整个提交没落地。**

| 核对项 | 实测结果 |
| --- | --- |
| `app/engine/scripts/hook-denial.mjs` | 不存在 |
| `aitest-source-runtime.json` → `engine_files` | 470 条，**无** `scripts/hook-denial.mjs` 键 |
| `child-command-policy.mjs` / `controller-handoff.mjs` / `stage-evidence.mjs` / `structured-actions.mjs` / `delegation-guard.mjs` / `preparation-recovery.mjs` | 6 个哈希与源码全不一致（安装副本是旧版，连 `import` 都没有） |
| `stage-handoff.mjs` / `record-orchestration-event.mjs` / `interrupted-report-recovery.mjs` | 3 个哈希与源码**一致** |

后三者的哈希一致恰好定位了现状：它们是 `4df9a53` 改的，`1dcd6cf` 没再动。
所以安装副本停在 **`4df9a53`**（刀一/二/三已生效），`1dcd6cf` + `cbc51f3` 完全没进安装环境。
按交接清单 §6 第 1 条，`engine_files` 计数没从 470 变 471，就是"没部署"的判据，不需要再猜。

### 9.1 同步是整体对齐，不能挑文件

`deploy-engine-files.mjs` 的期望集合 = 源码发布策略全量（470 条），逐条比哈希后**整体换件**。
按当前源码状态跑一次，会改 **24 个文件**，不是 7 个：

| 归属 | 文件 | 说明 |
| --- | --- | --- |
| 本批次 | 6 个门禁脚本 + `scripts/hook-denial.mjs`（新增）+ `config/release-resources.json` | 交接清单 §1 的内容 |
| 早前已提交、但安装副本一直没同步 | 14 个 `aitestharness-tools/aitestharness_tools/**`、`scripts/central-mcp.mjs`、`scripts/check-tool-contract.mjs`、`penguin/ui/workspace-ui.mjs` | 最后改动分别在 11-19 / 11-20 / 11-24，均已入库，属安装副本滞后 |

同步后 `engine_files` 应为 **471**。看到 24 个换件不要当异常，也不要手工只拷 7 个——
手工补拷的文件不受清单完整性校验，是漂移来源（脚本头注释已写明）。

### 9.2 跑同步前必须先解决的阻塞

`penguin/ui/workspace-ui.mjs` 在源码工作区是**未提交**状态（19 增 23 删，去掉 `default-workspace` 自动创建那一段）。
`deploy-engine-files.mjs` 从源码工作树取文件，直接跑会把这个半成品一起打进安装副本，违反 runbook §4「固定源码，避免混入并发修改」。

先落定该文件（提交，或 `git stash` 后在固定快照上部署），再执行同步。

### 9.3 补齐步骤

```powershell
# 0. 确认源码快照含全部 6 个提交（缺 cbc51f3 会被 import 闭包断言拒掉）
git merge-base --is-ancestor cbc51f3 HEAD && echo "snapshot ok"
node scripts/check-release-resources.mjs     # 期望 allowlist_valid / 469 文件

# 1. 暂停 → 同步 → 恢复
node scripts/local-service.mjs pause  E:/AITestHarness/installed/installation.json
node scripts/deploy-engine-files.mjs E:/AITestHarness/installed
node scripts/local-service.mjs resume E:/AITestHarness/installed/installation.json

# 2. 判据（两条都要，缺一条不算部署完成）
#    a) engine_files = 471 且含 scripts/hook-denial.mjs
#    b) 安装副本能真正加载新模块（import 期就会拉起 hook-denial）
node -e "import('file:///E:/AITestHarness/installed/app/engine/scripts/child-command-policy.mjs').then(()=>console.log('import ok'))"
```

`import ok` 这一条是关键：清单登记对但文件缺失、或文件在但依赖闭包不完整，都会在这里立刻炸，
比等真实任务跑到 handoff 才发现便宜得多。之后按 §6 第 5、6 条做现场复现。
