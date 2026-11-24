# 门禁复杂度复审：卡死点与重复调用（2026-11-24）

范围：`scripts/child-command-policy.mjs`、`stage-evidence.mjs`、`stage-handoff.mjs`、`controller-handoff.mjs`、`record-orchestration-event.mjs`、`artifact-contracts.mjs`、`penguin/hooks/*`。
结论：门禁的判定规则已经收敛到可维护的规模（见 `e9bcc5e`、`6546f4e`、`4df9a53`），剩下的是**成本问题**和**少数几个仍会永久卡死的地方**。

---

## 一、本轮已修（提交 `4df9a53`）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| 1 | `stage-evidence.mjs` `readSession` | 一次 handoff 解析同一份父/子 trace 4~8 遍；3.1k 行 trace 单次解析实测 66~76ms（2MB） | 加按调用生命周期的缓存，`stage-handoff` / `controller-handoff` / `interrupted-report-recovery` / `record-orchestration-event` 在入口建一份快照向下传 |
| 2 | `controller-handoff.mjs` `inspectHandoff` | stop hook 巡检按 run×stage 各建一份快照，父会话 trace 被反复解析；3 run × 5 stage 约 15 次 | 整个巡检共用一份快照 |
| 3 | `stage-evidence.mjs` `findParentDispatch` / `matchingDispatchCalls` | 每个 subagent 调用都 `parent.map().filter()` 全表扫一遍，O(n²) | 建 `tool_call_id → outputs` 索引，O(n)，语义不变 |
| 4 | `child-command-policy.mjs` 三处终局拒绝 | 只报"未纠正"，不说是哪条、怎么解 | 报错带出仍欠的 key/路径 + 唯一解除动作 |
| 5 | `child-command-policy.mjs` / `stage-evidence.mjs` 进程标记匹配 | `^…$` 与 `endsWith` 对尾部 `\r\n` 零容错；Windows 上宿主文案一模一样也判"未执行" | 匹配前 `trim()`。**这与 11-24 那个 `^` 锚定 bug 是同一类缺陷** |

验收：门禁相关 7 个测试文件 **121/121** 通过。

---

## 二、尚未修，已定位

### 高：仍可能永久卡死

**A. `resumeUnlaunchedDispatch` 的 `used >= 2 → stop`**（`controller-handoff.mjs:104`）
journal 落在 `output/handoff-checks/<parent>/launch-reminders.json`，计数到 2 后永久 `stop`，没有任何自助恢复路径。模型看不到"再试一次就会解锁"的信号，用户侧表现为会话静默停住。
建议：`stop` 时把 journal 路径与已用次数写进 reason，并提供显式重置入口（或改为只在同一 dispatch 内退避，换 dispatch 即归零）。

**B. `backgroundCatalogWithoutOutput` 要求"恰好 1 次 poll 且输出恰好 `[no output]`"**（`child-command-policy.mjs:155`）
宿主多 poll 一次、或多打一个字符，就落回正常判定 → 该 catalog 查询被算作"未完成" → 进 `pendingCatalog`，而解除它又必须再来一次成功的 catalog help。闭环依赖宿主行为逐字一致。
建议：`polls.length !== 1` 放宽为"取最后一次 poll 判定"，输出比较用 `trim()` 后 `includes`。

**C. `handoffReminder` 的 `used >= 2 → stop`**（`controller-handoff.mjs:140`）
生产代码**没有任何调用方**，只有 `tests/acceptance/orchestration.test.mjs:125-129` 在用。等于为一条不存在的路径维护一套 journal 语义和一条永久停止分支。
建议：删函数 + 改测试；如需保留，明确它由哪个入口驱动。

### 中：重复执行

**D. `structured-actions.mjs` 单次 action 内 23 次 `readRunFile(…'manifest.json')`**
其中 `artifactProgress()`（424 行）在 handoff/complete 时还会 `resolveDispatchedChild` + 再 `readSession(child)` 算 hash，且**不传缓存**——等于每次 handoff/complete 固定多读 2 遍子会话 trace。它只为一个 progressHash 服务。
建议：给 `artifactProgress` 接 cache；manifest 在 `executeAction` 内做一次快照（写操作后手动失效）。

**E. 同一次 handoff 里同一事实算三遍**
`inspectStageHandoff` → `assertArtifactContract`（产物哈希）、`verifyStageEvidence` → 产物哈希、`record-orchestration-event:139` → 产物哈希。`verifyStageEvidence` 内部 `matchingDispatchCalls`（304）与 `findParentDispatch`（311）也是同义计算。
建议：产物哈希随 `verifyStageEvidence` 的返回值带出，`record-orchestration-event` 直接复用。

### 低：结构性残留

**F. 拒绝文案耦合 hook 措辞（5 处）**
`startsWith('Tool call denied by the qa-delegation-guard hook')`、`'Tool call denied by the qa-stage-boundary hook'`、`'Tool call denied'` 等。hook 文案一改，5 处判定同时失效，且失效方向是"认为没被拒"——偏危险。
建议：hook 拒绝时在输出里带结构化前缀（如 `[qa-denied:<hook>]`），门禁匹配前缀而非整句。

**G. V1/V2/V3 三套命令协议并存**
`stage-evidence.mjs:310` 接受 V1/V2/V3，`:320` 又用 `/^QA_COMMAND_POLICY_V[23] /` 决定是否开恢复通道。等于三份契约共用一个校验器。
建议：确认无在跑的 V1/V2 dispatch 后只留 V3，强度由 manifest 记录的版本决定。

---

## 三、关于验证环境（重要）

`tests/acceptance/structured-actions.test.mjs` 共 85 个用例、单个 15~18 秒、全量约 13 分钟，且**对并发极其敏感**：本轮期间另一个进程在同一工作树改 `platform/*`（`router.tsx` 15:29、`platform-task-bridge.ts` 15:21），并行跑该文件时出现 41/53 假失败。

已用 `git stash` 做基线对比，确认 `orchestration.test.mjs` 的 1 个失败（`阶段 analysis 必须使用 Skill: api-contract-analysis,requirement-analysis`）在 HEAD 上同样失败，与本轮改动无关；其余按 `stage-evidence` / `child-*` / `runtime-reliability` / `draft-records` 分开跑全部通过。

建议：把该文件按主题拆成 3~4 个文件（`structured-actions-dispatch` / `-revision` / `-recovery` / `-inputs`），既能并行，也能让单个失败不再拖 13 分钟。

---

## 四、部署清单（交 codex）

1. 拉取 `e9bcc5e`、`6546f4e`、`4df9a53` 三个提交（本地 main，尚未 push）。
2. 引擎侧改动集中在 `scripts/`，**无需重建 `core/dist`**；若部署流程会重建，照常重建。
3. 部署后验证：
   - 跑一次 `node scripts/run-engineering-tests.mjs tests/acceptance/stage-evidence.test.mjs tests/acceptance/child-history-recovery.test.mjs`（应 52 通过）
   - 取一个此前卡在 handoff 的 run，重试一次 handoff；不重跑子任务、不重派发
4. 回滚：三个提交互相独立，可单独 `git revert`；`4df9a53` 只加了可选参数（默认 `null`），旧调用点行为不变。
