# 门禁体系框架梳理与问题清单（2026-11-26）

> 范围：`installed/app/engine/scripts/`（源 `scripts/`）+ `penguin/hooks/` 的全部交付门禁。
> 依据：2026-11-25/26 两天 6 起现场事故的逐层排查与修复（提交 `969b648` / `46278f4` / `a54ef3d` / `6729924` / `25f5907` / `4d5f17e`）。
> 读者：平台维护者（codex）、后续要优化门禁的任何人。
> 2026-11-26 补充：§7 源码级审查——累赘与僵硬清单、一处防篡改漏洞、路线图修订；§8 分支实施记录。

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
- 已知基线红：`child-recovery-receipts` #3、`delegation-stopped` 全红（safe-delete 锁超时）。**§7.3 更正：#3 不是噪声，是真实防篡改漏洞的信号；delegation-stopped 是环境问题，非代码回归。**

---

## 7. 源码级审查补充（2026-11-26）：累赘与僵硬

> 来源：同日全量源码审查（六层核心约 2500 行精读 + 301 脚本 throw 统计 + 基线红 #3 实跑复现）。
> 本节补充 §4 病灶清单、修订 §5 路线图。所有行号已逐一核实。
> 总判断：门禁的判定逻辑没有判错过，严格本身不是问题（正向证据 / 防篡改 / 人工批准是产品核心价值）；
> 问题是**累赘**（可收敛的意外复杂）与**僵硬**（严格但无出口）。灵活化的方向不是放松证据要求，而是给失败分级。

### 7.1 累赘：应收敛的意外复杂

六层串行是**本质复杂**——在宿主不给结构化保证的前提下手工搭跨父子会话、归档、manifest 的分布式证据链，砍层数只会让证据链断。以下是**意外复杂**，纯累赘：

**规模修正**：按 `throw new` 重计，201/301 个脚本、1178 处（§1 的 192 为旧口径）；普通 Error 1052 处，`CommandUsageError` 仅 **57 处（15 个文件）**。C 层豁免/跳过路径实际 **9~10 条**（§3 计 6），含 backgroundCatalog、归档 catalog 预览、handoff_correction 跳过、partialBrowser 等。

**四族散落判据**（P1 统一分类器的完整范围）：

| 族 | canonical | 散落点 | 风险 |
|---|---|---|---|
| request_end 终止白名单 | 无（四份互不一致） | `recover-stage.mjs:54` 认 5 种状态；`draft-stage-revision.mjs:55` 认组合条件；`browser-task-resume.mjs:38` 只认 completed；`api-worker.mjs:21` 只认 cancelled/interrupted | 同一宿主终止事件，四个门禁四种判定，漂移风险最高 |
| 回执解析 | `child-command-policy.mjs:349` 括号截取+归档容错 | `preparation-recovery.mjs:48` 逐字重复；`interrupted-report-recovery.mjs:51` 裸 `JSON.parse`（宿主归档前后缀即碎）、`:47` 裸 `payload.status` 绕过 `toolOutcome` 双版本语义 | 宿主输出形态一变，散点各自碎 |
| B 层绑定判据 | 无（三套并行） | `matchingDispatchCalls`（agent+runId+dispatchId token，**不查策略文本**）≠ `findParentDispatch`（要求策略全文包含）≠ `delegation-guard.mjs:61` prior（只查 dispatchId，解析失败 `catch{return true}` 直接算 prior） | token 对但策略文本差的调用被计为绑定、下一步却报 "No matching parent dispatch response"，错误信息不暴露真实原因——排障黑洞 |
| 拒绝判定 | `hook-denial.mjs` decision 行+前缀双信号 | `stage-evidence.mjs:226,231,289` 裸 `startsWith('Tool call denied')` | 两套机制回答同一个问题，新 hook 拒绝形态只改一处会漏 |

**宿主字符串无共享常量**：marker 全部内联字面量（`recordedChildHandle` 注释自认宿主措辞 "keeps drifting"），宿主升级需散弹式修改。应收进版本化适配模块（仿 `trace-outcome.mjs` 的 status/stop_reason 双版本思路）。

**错误类型误用清单**（本可纠正 → 死锁，机制见 7.2 R1）：

| 位置 | 性质 | 备注 |
|---|---|---|
| `project-action.mjs:24` | inline JSON 用法错误用普通 Error | 同文件 `:27` ENOENT 却正确用了 CommandUsageError，纯不一致 |
| `resolve-stage-confirmation.mjs:13,23,44` | 用法/状态错误 | `:23` 即 §5 P1 #2 点名的"无 pending 提示"；经子脚本执行 → script_failure → 非 safe 动作 → stopped |
| `request-stage-confirmation.mjs:10,16,22,26` | 用法/状态错误 | 同上链路 |
| `analysis-draft.mjs:20,37` | 调用者可纠正状态 | in-process 抛出 → runner_error → stopped |
| `draft-stage-revision.mjs:91,99` | 资格检查后的并发/边界守卫 | 资格类 throw 已被 `:76/:86` 捕获转 ineligible（设计正确），这两处漏网 |

注：`artifact-contracts.mjs` 的 assert→普通 Error **不算误用**——validate_artifacts 属 safe-artifact 动作，按结果分类（`recovery-policy.mjs:104-106`），与错误类型无关。

### 7.2 僵硬：严格但无出口

本周 6 起事故全是"判得对但没出口"。僵硬有三类：

**R1 失败不分级（病灶 2 只修了一半）**

- 1178 处 throw 全是 fatal，没有 retry / correct / halt 分级。
- `runnerErrorSuperseded` 只救"后来成功"的 runner_error；**没有后继成功的 runner_error 仍永久毒死**。而 `structured-actions.mjs:1214` 把所有非 CommandUsageError 兜底成 runner_error——错误类型治理是这里的治本。
- **类型误用 → 会话级死锁链**（比病灶 3 严重一个量级）：普通 Error → `classifyRecoverable` 返回 null（非 safe-artifact 动作）→ `controller-command-session.mjs:358` `state.status='stopped'` → 整个控制器会话停摆，只剩受限续接。现场"父任务三次 CLI 用法错误、子任务 30 分钟试错"的代价就是这条链。病灶 3（文案）治标，类型治理治本。

**R2 仪式代替证据（病灶 4 的新实例）**

- **目录债**：`child-command-policy.mjs:335,419` `pendingCatalog`——只读 catalog 查询 MODULE_NOT_FOUND 后必须重跑 catalog 成功才解锁，validate 全过、产物全对也清不掉。与 draft_records 完全同构，`4d5f17e` 未覆盖。只读帮助类债务根本不该阻塞交付。
- **策略全文精确匹配 = 隐形版本锁**：`stage-evidence.mjs:343`、`draft-stage-revision.mjs:47` 用当前代码重新生成 V2/V3 全文并精确比对 manifest 旧串。今后任何文案微调（哪怕一个词）毒死所有在途派发——与事故 6 同形态，触发源却是自己的引擎升级；按日常同步部署模式这是活风险。测试只锚前缀（`runtime-reliability.test.mjs:17`），拦不住。绑定应只认 `QA_COMMAND_POLICY_V<n> <uuid>` 前缀，正文进契约文件（P2 #4 的更硬理由）。
- **通配清债**：`clearsPendingKey` 省略 stage 视为通配——无 stage 的成功回执可清同 run 同动作任意 stage 的债。当前单阶段子会话下风险受限，类型化时应显式约束。

**R3 预算与锁的僵硬**

- **超时错配**：`qa-delegation-guard/hooks.json` 给 stop hook 60s，`stage-handoff.mjs:79` 每条内部命令允许 120s、最多两条。长 trace 下宿主先杀 hook，commit 对账没机会跑，表现为随机 handoff 失败噪声（下次 stop 可恢复，但排障成本高）。
- **两处 O(n²)**：`child-tool-guard.mjs:47` 子会话每条带 qa_request 的命令全量重读自己不断增长的 trace；`assertChildCommands` 对每条 exec 行做 `rows.slice(index+1)` 全扫描，`runnerErrorSuperseded` 还 JSON.parse 后续所有输出。父 trace 已有 `toolResultsById` 索引，子 trace 没有同等待遇。
- **PID 复用死锁**：`orchestration-state.mjs:78` "owner 进程还在就绝不接管，无论锁多旧"。Windows PID 复用激进，死 owner 的 PID 被无关进程复用后锁永久卡死，无锁龄出口。会话锁已有 `ownProcessIdentity` 比对，manifest 锁没有。
- **扩音器后缀**：`stage-handoff.mjs:73` `HandoffInputError` 给所有失败追加约 5 句通用长文，具体原因被淹没——拒绝文案的反模式，与"带下一步"目标背道而驰。

### 7.3 两类之外、但必须修订路线图的发现

**S1 防篡改漏洞（基线红 #3 的真正根因，应从 P2 提前到 P1）**

两段代码合谋：`child-command-policy.mjs:270` legacy 回退（`recovery.key` 不匹配 `run-`/`unbound:` 前缀时回退用 `result.task_key` 当债键）+ `stage-evidence.mjs:77` `verifyActionRecoveryReceipt` 只比对回执↔结果字段全等、**不校验 recovery.key 与 task_key 的内部一致性**。把 `recovery.key` 篡改成 `'foreign'`（两侧一致）即可通过验证、被当成合法 stalled 债、由后续同任务 success 清偿。实跑 `child-recovery-receipts.test.mjs:80`：10 个篡改变异 9 个正常抛错，唯独这一个逃逸。**这是证据链"防篡改"承诺上的洞，§5 P2 #5"基线清零"对此项必须修订：修代码不修测试。**

**delegation-stopped 全红是环境问题**：sandbox 的 safe-delete shim 批量删除阈值（50）拦截清理 → 锁残留 EEXIST → `controller-command-session.mjs` 5000ms 锁等待预算耗尽。已知解法 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=1000000`。另：该测试 fixture 直接写仓库 `output/` 且无清理钩子，应补。

**assertStageHistory fail-open**：`orchestration-state.mjs:230` 未知事件类型映射为 null → 静默放行，与全局 fail-closed 哲学相反；新增事件类型忘配映射时无信号。

### 7.4 路线图修订（对 §5 的补丁）

**P1 增补**：
1. 修 S1：删 legacy 回退或加 key↔task_key 一致性校验，让基线 #3 变绿（防篡改修复，不是基线卫生）。
2. S3 最小版：绑定判定只认 `QA_COMMAND_POLICY_V<n> <uuid>` 前缀，全文比对降级为 warning——先拆版本锁，正文分离放 P2。
3. 统一分类器范围扩至 7.1 四族：`parseActionReceipt` / `classifyChildTermination`（四份白名单合一，调用方传策略）/ `classifyDispatchBinding`（B 层三套合一）/ 拒绝判定统一走 hook-denial；宿主字符串收进共享常量。
4. throw 文案审计优先修 7.1 误用清单里"会打成 stopped"的那批，而非全部 1178 处。
5. delegation-stopped 用环境变量修环境，fixture 补清理。

**P2 增补**：
6. **错误类型治理（治本 R1）**：用法/状态类错误迁 `CommandUsageError`，加 CI lint（调用者-facing 脚本禁止裸 Error 表达可纠正错误）。
7. `closure_policy` 类型化覆盖 `pendingCatalog`（只读债不阻塞交付）与通配清债约束。
8. **性能与超时对齐**：子 trace 建 tool_call_id 索引；hook 内命令预算 < hook 超时；`currentRunId` 增量读或缓存。
9. 锁恢复加 PID 复用防护（`ownProcessIdentity`）+ 锁龄上限出口。

**P3 增补**：
10. **宿主适配层**：所有宿主字符串/事件格式判据集中到版本化适配模块，宿主升级只改一处——本周 6 起事故里 4 起的根因形态（宿主输出漂移）在结构上被隔离。

**明确不做的（补充一条）**：
- 不为消灭基线红而放宽断言——#3 的红是代码漏洞的信号。

**一句话结论**：门禁没有判错过，但证据边界靠字符串匹配宿主散文、可纠正性靠错误类型却只有约 5% 的 throw 用对了类型、防篡改有一个 legacy 回退洞。P1 修 S1/S3 + 统一分类器，P2 做错误类型治理——两步可消灭本周 6 起事故中 5 起的根因形态。

## 8. 实施记录（fix/gates-p1-20261126 分支，2026-11-26）

按用户授权（不合理设计可删改；重复返修/跨阶段返修不得卡死流程）落地 P1 主体：

**已实施**：
- **S1 防篡改**：stalled 回执必须 `recovery.key===task_key` 原文一致（legacy 回退只服务 correctable/legacy 路径）；`verifyActionRecoveryReceipt` 增加 progress_based 键一致性校验。基线红 #3 转绿。
- **S3 版本锁拆除**：`stage-evidence`/`draft-stage-revision` 的策略绑定改为 `QA_COMMAND_POLICY_V<n> <dispatchId>:` 前缀；全文仍锚定父派发调用与子接收行，模板改词不再搁浅旧 run。
- **返修解卡（R1/D1）**：`request_confirmation`/`resolve_confirmation`/`revise_stage` 纳入 `isSafeArtifactAction`——只动 manifest/确认单的动作，其失败是可纠正输入而非产品事故，不再打成 stopped；`pendingUnkeyed`/`pendingCatalog` 终局 throw 补 `allowUnresolvedRecovery` 守卫，与 pending/pendingReads 一致，返修路径不再被未决债务锁死。
- **pendingCatalog 仪式债放宽**：后续成功业务动作（completed）或成功 catalog help 即可清债，不再要求字面重跑 help；单独 help/ready 响应仍不算恢复证据。
- **错误类型迁移（局部）**：`project-action.mjs` 内联 JSON 拒绝、`analysis-draft.mjs` 两处所有权/快照状态拒绝迁 `CommandUsageError`（进程内可纠正分类）。
- **拒绝判定统一（四族之一）**：`hook-denial.mjs` 增 `isDenialOutput`（宿主固定前缀，覆盖 user/policy/任意 hook），`stage-evidence` 三处裸 `startsWith` 收编。
- **确认脚本拒绝文案**：重复确认、无确认配置、状态不符、找不到待处理确认、产物回执变化——均附下一步动作，避免总控原样重试。
- **测试卫生**：delegation-stopped fixture 补 per-fixture 清理；`run-engineering-tests` 子进程默认抬高 safe-delete 阈值。
- 既有 WIP（执行授权顺序颠倒进程内拒绝 + 旧 stopped 状态自恢复）已先行提交（ddcb5e6/3e0c517/5f82a33）；本分支把对应测试改写为"新失败立即可纠正 + 遗留锁死状态仍可恢复"双层断言。
- 注：`stage-evidence.mjs`/`stage-evidence.test.mjs` 的本批改动被并行会话随 `a2c45cf`（空归档降级）一并提交；其依赖的 `hook-denial.mjs` `isDenialOutput` 导出由本分支随后的门禁层提交补齐。

**保留不动**：`assertDesignMutable` 执行后设计冻结（有 new run/reuse_design 正路，非死锁）；`recover-stage` 的 blocked/failed+审批门槛；全文锚定与恰好一次派发绑定。

**遗留 → P2**：`parseActionReceipt`/`classifyChildTermination`/`classifyDispatchBinding` 三族统一、错误类型 CI lint、性能/超时对齐、PID 复用防护、宿主适配层。
