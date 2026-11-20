# P4 第六切片：运行痕迹与报告追溯（判据 1 收口）— 2026-11-19

## 0. 一句话

以前 `qa_runs` 只能证明"这次运行存在过"，不能证明"执行真的开始了"。本轮把执行器自己写在 run 目录里的三份文件读成事实，于是**发起时刻、当前阶段、是否疑似中断**三问答得出了，报告也第一次必须"说得出自己从哪一刻跑起来"。

## 1. 被混成一个"状态"的三件事

排查一次失败只需要三个答案，而它们来自三处不同的证据：

| 问题 | 证据 | 以前 |
|---|---|---|
| 这次运行发起过没有 | `manifest.json`（`create-run` 写） | 有：平台登记过一次就有行 |
| 执行真的开始了没有、什么时候开始 | `execution/execution-state.json` / 执行锁（执行器写） | **没有**：`started_at` 永远是 null |
| 是跑着还是卡住了 | 锁是否释放、持锁 pid 是否还在、最后活动时间 | 有，但只按"开始到现在多久"粗判，长跑必误报 |

三者混在 `status` 一个字段里时，"没发起"、"发起了但死了"、"还在跑"在界面上长得一样——这正是判据 1 说"记录完整"却不成立的原因。

## 2. 为什么读文件，而不是让执行器回调登记

执行器（`scripts/execution-runner.mjs` → `execution-attempts.mjs`）是 spawn 出来的子进程，**拿不到平台会话令牌**；要它回调就得给子进程放一份平台凭据，那是一处新的信任边界，为一个只读判断不值得。

而这三份文件执行器本来就在写：

```
execution/execution.lock.json          开始写（含 owner_pid），正常收尾时删除
execution/execution-state.json         当前阶段 + 最后一次活动时间
execution/attempts/<id>/attempt.json   每次尝试密封后的起止与结论
```

**缺的只是有人读。** 所以本轮新增 `services/qa-run-trace.ts`：只读、不猜、不写库。

两条设计选择值得记下来：

1. **`stalled` 用"最后一次活动"判，不用 `started_at` 判。** 真机执行跑 40 分钟是正常的；按"开始到现在超过 30 分钟"判，会把所有长跑标成中断，而人一旦见过一次误报就不会再信这个标记——标记失效比没有标记更糟。
2. **锁在、进程不在 = 疑似中断的最强证据**（`orphaned`），不等阈值。执行器正常结束会删锁，剩下的锁只有两种含义：还在跑，或跑到一半死了。同机可以用 `pid` 区分（`ESRCH` = 已退出，`EPERM` = 存在但看不到）；跨机时 `pid` 不可信，`pidStatus` 降为 `unknown`，退回时间阈值并写明"需人工确认"。

容错口径：缺文件、坏 JSON、非法 `run_id`、指向工作区外的符号链接，一律返回"没有"，不抛。这些文件是别的进程写的，把查询读崩会让"读不到"这个事实变成 500。

## 3. 接进 `qa_runs`：`started_at` 只认执行器

- `assertNewRun` / `assertReportRun` 读一次 trace，把 `startedAt` 挂到 `RunObservation` 上；`observeRun` 用 `COALESCE(started_at, ?)` 写入——补一次就固定，不会被后来的观察改掉。
- **删掉了两处"编时间"**：① `observeRun` 原来在 manifest 自称 `in_progress` 时把"平台第一次看见"的时间写进 `started_at`；② `settleRun` 原来在结束时 `COALESCE(started_at, created_at)`。这两处都会让"到底有没有开始过"这个问题永远答"开始过"，正好把本轮要加的断言架空。
- `stalled` 的判定窗口退化为 `started_at ?? created_at`：`started_at` 缺了也要能提示"疑似中断"，但 `started_at` 字段本身仍为 null——**"不知道什么时候开始的"不能编一个值**。

## 4. 报告侧断言：声称跑过，就要追得到

`publishReport` 在结论校验之后新增一条：

```
conclusion ∈ {passed, failed, partial} 且 qa_runs.started_at 为空 → 400 report_untraced
```

三个边界是刻意的：

- **只要求这三种结论**。`blocked` / `not_run` 本身就是"没跑成"，要求它们有执行痕迹等于逼人补一行假数据。
- **凭据必须是执行器写的**（锁 / 状态 / 密封尝试），不接受 Agent 手写的 `test_results.json`：后者只能证明"有人写了 JSON"，不能证明"浏览器真的开过"。
- **不拦"确实没跑"的报告**，只拦"说自己跑过、却没有任何执行痕迹"的那一类。

实测这条断言立刻抓出了既有测试夹具的问题：那条用例的 run 目录里只有 manifest 和手写的截图，报告却写着 `failed`。夹具已补上执行痕迹——不是为了让断言通过，而是那些场景本来就是"跑过了"。

## 5. 接口

`GET /api/projects/:p/agents/qa/qa/task-records/:sessionId/runs/:runId/trace`

返回三块，故意不合并成一个"状态"：

```jsonc
{
  "registered": true,          // 平台有没有这次运行的登记行
  "run": { "...": "QaRun" },   // 登记行本身（未登记时为 null）
  "trace": {
    "present": true,           // run 目录里有没有 manifest
    "manifest": { "status": "in_progress", "manifestVersion": 3, "baselineHash": "…", "sha256": "…" },
    "execution": {
      "invocationId": "…", "startedAt": "…", "finishedAt": null,
      "phase": "playwright", "state": "running", "lastActivityAt": "…",
      "attempts": 0, "locked": true, "orphaned": true,
      "pidStatus": "dead", "blockReason": null
    },
    "startedAt": "…", "stalled": true,
    "stalledReason": "执行锁未释放且持锁进程已退出：疑似执行器崩溃或被强制结束，需人工确认残留后重跑。",
    "staleAfterMs": 1800000
  }
}
```

`registered=false` 而 `trace.present=true` 是**有价值的不一致**：目录里有这次运行、平台没登记过。接口不替它补一行——补上就把"曾经没登记"这个事实抹掉了。

## 6. 验收

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `test/qa-run-trace.test.ts` | 10 | 无 manifest / 只有 manifest / 执行中 / 长跑不误报 / 31 分钟无活动判中断 / 锁在进程亡 / 正常收尾不判中断 / 坏 JSON / 非法 pid / 多次尝试取最早与最晚 |
| `test/qa-run-trace-route.test.ts` | 1 | 无痕报告 400 `report_untraced` → 补痕迹后 201；`run.startedAt` 等于锁里的时刻；接口三态（未开始 / 崩溃 / 已收尾） |
| `test/qa-quality-traceability.test.ts` | 8 | 既有回归全绿（夹具补执行痕迹后） |
| `test/qa-run-execution.test.ts` + `qa-task-run-registry.test.ts` | 36 | `started_at` / `stalled` 语义改动后回归全绿 |

相邻回归 `qa-integration` / `qa-u2-contracts` / `qa-task-run-migration` 13 例通过；`tsc --noEmit` 干净。

## 7. 判据 1 现在到哪一步

| 判据 1 的要求 | 状态 |
|---|---|
| `qa_runs` 有这次运行 | ✅ 由 `observeRun` 保证（设计 / 报告两处观察） |
| 能追到**发起时刻** | ✅ 执行器写的 `startedAt` 落进 `qa_runs.started_at` |
| 报告 `run_id` 能追到发起行 | ✅ `report_untraced` 断言 |
| 执行期间的阶段/中断可解释（判据 4） | ✅ `trace.execution`（phase / state / attempts / blockReason）+ `stalledReason` |
| **执行器启动前就断掉**的运行也进 `qa_runs` | ❌ 仍缺。见下 |

最后一条缺口的真实原因是**没有通道**：引擎子进程无法回调平台，而"补登记"又必须来自某个能证明自己可信的入口。当前的处理是**如实呈现不一致**（`registered:false` + `present:true`），由人决定补登记还是重跑——这比伪造一行"已发起"更接近事实。

## 8. 未做

1. **`stalled` / trace 的前端展示**：按界面迭代铁律，先出原型 `prototype/run-trace-stalled-prototype.html`（四个场景：崩溃 / 长跑 / 正常收尾 / 未登记），等确认后再改真实前端。
2. **结果写入时不刷新 `started_at`**：`recordResults` 只做会话校验，不读 manifest/trace；发起时刻要到报告发布时才被补上。想让列表页更早正确，可以在 `recordResults` 里做一次 best-effort 观察。
3. **缺陷按 uid 反查**（G4 遗留）与 P4 判据 3 的权限强化不在本轮。
4. `trace` 只在单 run 粒度暴露；跨 run 的"这个任务最近有没有卡住的运行"需要列表页聚合，属前端那一步。
