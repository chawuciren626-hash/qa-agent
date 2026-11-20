# P4 第八切片：发起方接线——"命令被调用过"从此有据可查 — 2026-11-20

## 0. 一句话

判据 1 的证据链此前缺中间一格：manifest 证明"运行存在过"，执行器痕迹证明"执行开始过"，但**"命令被真正调用了"**这件事没有任何记录——执行器没起来、起来就退、参数就错，这三者和"从没发起过"长得一模一样。本轮在发起入口（`run-ui-tests.mjs`）落一份本地事实 `execution/dispatch.json`，并让 `readRunTrace` 把它读出来。

## 1. 为什么是"写文件"而不是"回调登记"

执行器是 spawn 出的子进程，拿不到平台会话令牌；为一行"已发起"给子进程开凭据通道，是一处新的信任边界，不值得。而发起入口本来就跑在引擎目录里，写一份本地 JSON 零权限、零网络。与第六切片同一判断：**缺的是事实，不是通道**。

## 2. `dispatch.json` 的四条约束（写在 `run-ui-tests.mjs` 里）

1. **不联系平台**：发起记录是辅助证据，不是闸门；写失败只打一行 stderr，不拦住执行（本轮专门包了 try/catch——若 `directoryContext` 校验失败连带把执行拦死，发起记录就变成了闸门）。
2. **不改 manifest**：manifest 是产物清单，混进调度事实会让两份真源对不上。
3. **只写第一次**：同一 run 重跑时"发起时刻"仍是第一次；重跑本身有 attempts 记录。
4. **manifest 不存在就不写**：run 目录里还没有 manifest 时不要造目录——那不是一次运行，只是参数拼错了。

## 3. 服务端语义：dispatch 是独立一格事实，**不参与 `started_at`**

`RunTraceView` 新增 `dispatch: { dispatchedAt, sessionId, host, ownerPid } | null`。关键决定：

- **`startedAt`（=`qa_runs.started_at`）仍只认执行器痕迹**。`report_untraced` 靠它拦"报告说跑过、实际没跑"——若 dispatch 也能填它，「发起了但执行器从没开始」的报告就能混过这道闸。有专门的阴性对照测试钉住这一点。
- dispatch 回答的是另一个问题：「这次运行**被发起过**吗」。`dispatch 在 + execution 全空` = 发起了但执行器从没开始——此前不可见的失败模式，现在 trace 里直接可见。
- 坏 JSON、版本不对、`run_id` 与目录不符、时间字段非法：一律按"没读到"处理（时间非法时其余事实保留、时间给 null），不冒充。

## 4. 真实探针

让 `run-ui-tests.mjs` 真跑一次（缺 `execution-plan.json`，执行必然 blocked）：

- `dispatch.json` **确实先于执行落盘**（发起记录在执行器报错之前已存在）；
- 这次 blocked 恰好就是此前不可见的失败模式——现在 dispatch 证明"命令被调用过"，attempts 里也有密封的 blocked 结论，两格都有了。

## 5. 验收

| 项 | 结果 |
|---|---|
| `qa-run-trace.test.ts` | 10 → **13 例**（dispatch+执行并存 / 只有 dispatch 的阴性对照 / 坏 dispatch 三态） |
| `qa-run-trace-route.test.ts` | 1 例扩展：崩溃夹具里 dispatch 早于执行 2 分钟，trace 带出 `sessionId` |
| 相邻回归 | `qa-quality-traceability` 8 / `qa-run-execution` 13 / `qa-task-run-registry` 24 / `qa-run-pool-lease` 2 全绿 |
| `tsc --noEmit` | 干净 |

## 6. 判据 1 现状（更新）

| 要求 | 状态 |
|---|---|
| 能追到发起时刻 | ✅ 执行开始有 `started_at`；发起调用有 `dispatch.dispatchedAt` |
| 「发起了但执行器从没开始」可见 | ✅ 本轮补上（此前与"从没发起"同形） |
| **执行器启动前就断掉的运行进 `qa_runs`** | ❌ **仍缺**——dispatch 解决的是"可见"，不是"登记"。没有观察发生过的运行依然没有 `qa_runs` 行，只是 run 目录里的证据变全了。要不要补可信登记入口仍是产品决策 |

## 7. 边界

- `session_id` 在脱离会话直接跑 CLI 时为 null（legacy 目录模式），不是缺陷。
- dispatch 里的 `owner_pid` 是**发起方**进程号（run-ui-tests 自己），与执行锁里的执行器 pid 是两个进程；跨机时 pid 判定同样不可信。
- 前端展示沿用第六切片原型（`prototype/run-trace-stalled-prototype.html`），未新增场景——「未登记」场景现在可以多答一格"发起过没有"，等原型确认时一并看。
