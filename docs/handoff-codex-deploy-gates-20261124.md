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
