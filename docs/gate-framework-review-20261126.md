# 门禁体系框架梳理与问题清单（2026-11-26）

> 范围：`installed/app/engine/scripts/`（源 `scripts/`）+ `penguin/hooks/` 的全部交付门禁。
> 依据：2026-11-25/26 两天 6 起现场事故的逐层排查与修复（提交 `969b648` / `46278f4` / `a54ef3d` / `6729924` / `25f5907` / `4d5f17e`）。
> 读者：平台维护者（codex）、后续要优化门禁的任何人。

---

## 1. 门禁体系是什么

门禁的目标：**每次交付都有完整、防篡改、可追溯的证据链**——模型说"做完了"不算数，只有结构化回执、产物哈希、状态机记录三方互证后才算交付。安全骨架是成立的，本周 6 起事故没有一起是"门禁判错了"，全部是"门禁对新的失败形态没有出口"。

总体形态：**六层串行 + 一层贯穿**。一个动作从父会话派发到正式交付，要纵向穿过全部六层，任何一层 throw 都把动作打回。规模参考：引擎 301 个脚本，其中 192 个含 throw。

| 层 | 职责 | 关键实现 |
|---|---|---|
| A 运行时 hook 层 | 进程外逐命令强制 | `penguin/hooks/qa-delegation-guard`（拦派发所有权）、`qa-stage-boundary`（拦越界 shell / 跨阶段动作） |
| B 派发绑定层 | 一次派发 ⇄ 恰好一次子调用 | `delegation-binding.mjs`、`stage-evidence.mjs:matchingDispatchCalls`、`launch-evidence.mjs:launchNeverStarted` |
| C 子命令审计层 | 子会话每条 shell 的合规与回执 | `child-command-policy.mjs:assertChildCommands`（最厚一层） |
| D 证据产物层 | 交付物 = 证据链 | `stage-evidence.mjs:verifyStageEvidence`、`artifact-contracts.mjs`、`readSession`（归档防篡改） |
| E 编排状态层 | manifest 状态机 | `orchestration-state.mjs`、`stage-recovery`、`draft-stage-revision.mjs` |
| F 回执与恢复层（贯穿） | 回执 + 恢复台账互证 | `action-audit/*.json` + `recovery` ledger（category/key/retry_allowed/progress_based），`verifyActionRecoveryReceipt` |

## 2. 一次派发的完整生命周期

```
dispatch（structured-actions.mjs）
  ├─ 生成 delegation.prompt + 受管契约文件 + child_command_policy(QA_COMMAND_POLICY_V3) 绑定 token
  ├─ B 层登记绑定证据（captureDelegationBinding）
  └─ run_subagent 起子会话
        ├─ A 层 hook：每条命令过 qa-stage-boundary（越界即拒，拒绝文本进 trace）
        └─ 子会话全部走受管入口 node project-action.mjs execute
              └─ F 层：每个动作写 action-audit 回执 + recovery ledger
  子会话返回 →
  handoff（stage-handoff.mjs:inspectStageHandoff，只读预检）：
    ├─ E 层：assertStageHistory / draftHandoffReconciliation（blocked 对账）
    ├─ B 层：matchingDispatchCalls 必须恰好 1 条（排除 hook 拒绝与未启动调用）
    ├─ C 层：assertChildCommands 遍历子会话 trace（见 §3）
    ├─ D 层：verifyStageEvidence + assertArtifactContract（哈希/表头/上游依赖）
    └─ 通过 → record-orchestration-event(completed) → request-stage-confirmation
  用户确认（resolve_confirmation）→ approved
```

**C 层内部结构**（本周事故最集中处）：

```
assertChildCommands(rows):
  对子会话每条 exec_command：
    1. 必须是受管入口（node project-action/command.mjs），否则 throw
    2. 恰好一个终态输出，否则 throw（unreadable）
    3. 一串豁免 continue：目录查询未输出 / 重定向前被拒（hook denial 需 decision 行佐证）/
       未启动（ENOENT 单行）/ 用户中断占位 / runner_error 且同任务后来成功 / 部分浏览器交付
    4. 解析回执 JSON → recordedCorrection 分类：
       可纠正（input_correction 等 5 类）→ 加入 pending 债（key = run:action:stage）
    5. 后续成功回执按 clearsPendingKey 闭环同 (run, action, stage) 的债；
       validate-artifacts 成功额外清 pendingUnkeyed 与 draft_records 债（4d5f17e）
  收尾：pending / pendingUnkeyed / pendingCatalog 非空 → throw 列出仍欠什么
```

## 3. 本周 6 起事故复盘（映射到框架）

| # | 事故 | 层 | 根因 | 修复提交 |
|---|---|---|---|---|
| 1 | 截断回执被判"仍会被拒"（误判） | D | 探针绕过 readSession；现场 8 条归档早已还原，门禁 PASS | 补回归用例 |
| 2 | hook 拒绝被当成"读不出的回执" | A→C | qa-stage-boundary 拒绝文本进 trace，审计层要求解析成回执 | `969b648`：hook-denial 集中前缀判定 + decision 行佐证 |
| 3 | 执行通道 500 未启动，派发被锁死 | B | `[run_subagent error:…500]` 是 fatal 回执但子会话从未建立 | `46278f4`：launchNeverStarted 只认正向证据 |
| 4 | 用户中断后卡"unreadable" | A→C | 中断占位符被当回执 | `6729924`：hostInterrupted 两个宿主串精确匹配 |
| 5 | 重试成功后绑定数=2，三个动作全拒 | B | `launchNeverStarted` 只用于放行重试，`matchingDispatchCalls` 没排除死调用 | `25f5907`：判定抽到 launch-evidence.mjs 共用 |
| 6 | runner_error 瞬时回执毒死 handoff | C→F | 宿主归档日志写盘竞态 → validate_artifacts rejected/runner_error/无台账 → :359 对无纠正分类的 rejected 一律抛错 | `4d5f17e`：runnerErrorSuperseded（同任务后来成功则跳过）+ draft_records 债由阶段验证闭环 |

**脆弱点高度集中**：6 起里 5 起的根都在"**什么算证据**"这条边界上。每来一种新噪声（hook 拒绝文本、中断占位、500、归档竞态），就要在 C 层加一个豁免 continue——豁免已积累 6 个，且与 B 层的 `matchingDispatchCalls` 不同步（事故 5 正是"放行了一边、没放行另一边"）。

## 4. 四个共性病灶

1. **非回执行被当回执解析**。凡不是标准 JSON 回执的行（hook 拒绝、中断占位、500 错误、runner_error），审计层一律要求解析。豁免散装（每个 continue 一处、每处一段判据），下一个新形态还会炸。
2. **瞬时噪声永久毒死**。一次竞态/一次 500 没有恢复路径，把整个派发卡死，每次靠人工修门禁解锁。
3. **拒绝不带下一步**。192 处 throw 全是长句文案，只说不行不说该干什么。现场代价：子任务曾 30 分钟试错、父任务三次 CLI 用法错误。`recovery.next_action` 只有动作层有，throw 层没有。
4. **债的闭环按动作名而非按目的**。纠正债要求"重跑同一动作"，哪怕产物已被 validate 证明正确、子任务已返回（仪式无法履行 → 死锁）。`4d5f17e` 只对 draft_records 一类手工放宽，没有类型化。

## 5. 优化路线图

### P1 止血（1-2 天，只动豁免与文案，不动绑定语义）

1. **统一"非证据行"分类器**：把未启动 / 中断 / hook 拒绝 / runner_error 四类判据收进一处（`launch-evidence.mjs` 方向延伸），`assertChildCommands` 与 `matchingDispatchCalls` 共用。新噪声只需加一个分类分支，两层自动同步。每个豁免都有现成回归用例兜底。
2. **全量 throw 文案审计**：每条拒绝带一句"下一步做什么"，与 `recovery.next_action` 对齐。优先修今天已踩过的：resolve_confirmation 无 pending 时的提示、revise_stage ineligible 的各状态提示（`a54ef3d` 已做一部分）、CLI 用法错误的提示。

### P2 结构（3-5 天，动债模型与策略绑定，需全套回归）

3. **纠正债类型化**：给 CORRECTABLE 分类加 `closure_policy` 字段——`artifact-verified`（输出会被整体验证的，如 draft_records，由同阶段 validate_artifacts 闭环）/ `same-action`（执行类，维持现状）。把手工放宽变成类型系统。
4. **策略绑定 token 与正文分离**：绑定只认 `QA_COMMAND_POLICY_V3 <uuid>` 前缀，正文移进契约文件。派发词瘦身（另见派发提示词三层结构的讨论：身份句、语言指令、【】表单的分层改造）。
5. **基线测试清零**：`child-recovery-receipts` #3（stalled recovery，基线即红）、`delegation-stopped`（safe-delete 锁超时）。基线红稀释回归信号，本周每次改完都要人工分辨红是谁的。

### P3 长期（门禁从 throw 海变成结构化 verdict）

6. **verdict 契约**：每层检查返回 `{pass | blocked, reason, next_action, evidence}`，顶层聚合器统一呈现。模型不再从长报错里猜下一步；UI 可以直接渲染"卡在哪、缺什么、下一步按钮"。
7. **throw 分级**：安全红线（绝不自动放行）/ 输入纠正（带 next_action）/ 瞬时类（自动重试或跳过）。让"噪声毒死派发"这类事故在类型上不可能发生。

### 明确不做的

- 不放松"正向证据"原则（所有豁免必须带反例测试）。
- 不让模型现场生成派发词/自证交付（确定性绑定是根基）。
- 不动 manifest 状态机的语义（`workflow_mode` 二值等），本周易碎点不在那。

## 6. 附录：调试要点

- 直接调 `inspectStageHandoff` 等门禁函数：root 必须是引擎根（`installed/app/engine`）+ 环境变量 `QA_DIRECTORY_CONTEXT`（含 project_id）；output 走 session_root，`config/test-delivery-template.json` 只在引擎根存在。
- trace 位置：`installed/data/penguin/execution-cache/<hash>/<project>/agents/<agent>/traces/<date>/`；回执：workspace `output/action-audit/<session>/`。
- 运行副本同步：`installed/app/engine/scripts/`，备份 `.backup-20261126-batchN/`，去 CR 后 sha256 比对；脚本每次调用新起进程，不重启。
- 已知基线红：`child-recovery-receipts` #3、`delegation-stopped` 全红（safe-delete 锁超时），与门禁改动无关。
