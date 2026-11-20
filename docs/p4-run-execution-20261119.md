# P4 第五切片（订正版）：执行登记，不是派发队列

> 2026-11-19。承接 `docs/p4-authorization-20261119.md`（判据 3）。
> **本文替换同日早先的 `p4-run-dispatch-20261119.md`**——那一版按"任务池"设计，
> 与产品模型不符，代码已收回重做。订正原因记在 §1，留着比删掉有用。

## 1. 我做错了什么

上一版把 run 设计成"排队等执行器来领"：`queued` 状态、租约、领取、交回、重领。
用户指出产品里根本没有这个模型：

> 没有排队概念，发起会话了就跑任务，同时可以存在多个会话进行。

也就是说执行是**会话内直接发生**的，不存在"待办池"，也不存在"谁来领走它"。多个会话
天然并行，不需要容量控制。租约那套是为了解决"执行器都是匿名消费者、谁先抢到谁跑"的
问题——一个不存在的问题。

留着它的代价不是多几行代码，而是**引入了不存在的概念**：后来的人会以为执行要先入队，
进而去找那个"队列管理界面"和"执行器注册表"，然后发现都没有，于是开始怀疑系统坏了。

## 2. 订正后只保留两个动作

```
POST /api/projects/:projectId/qa/task-records/:sessionId/runs              → 201 {run(status=running)}
POST /api/projects/:projectId/qa/task-records/:sessionId/runs/:runId/finish → 200 {run(status=facts.status)}
```

实现：`QaTaskRunRegistry.startRun` / `finishRun`，路由 `http/routes/qa-run-execution.ts`，
迁移 `2026-11-19-qa-run-execution`（只加 `dispatch_json` 一列 + `(project_id,status,started_at)` 索引）。

去掉的：`queued`、`claimRun`、`releaseRun`、`claimed_by`/`lease_until`/`attempts`、
`/qa/run-queue/*` 四个端点。迁移文件按"未推送的迁移可以整体替换"处理（该分支尚未 push，
旧迁移从未被任何数据库记录），不留空壳。

## 3. sessionID 与 run_id 的分工

用户问得对：每个会话本身已经有 sessionID，为什么还要 run_id。两者不是一件事：

| | 覆盖范围 | 回答的问题 |
| --- | --- | --- |
| `session_id` | 一次对话/任务，横跨需求、测试点、用例、执行、报告多段 | 这是哪一次任务 |
| `run_id` | 一次具体执行 | 报告里这条结果、这条缺陷，来自哪一次执行 |

同一个会话可以跑多次（首跑、修完重跑、回归），`qa_runs` 本来就是 `(session_id, run_index)`
组织。没有 run_id，重跑之后"第 2 次为什么好了"只能靠时间戳猜。

## 4. 中断：停在"疑似中断"，由人重跑

用户选择：不自动重跑。理由是这条链路上有真写操作（建用户、注销），自动续跑等于重复执行。

实现方式刻意做得最轻：

- **不落库**：`status='running'` 且 `started_at` 超过阈值（默认 30 分钟）时，读时派生
  `stalled=true`。落库就需要有人负责改回去，而"谁在什么时候判定它死了"本身是个会出错的猜测。
- **不改状态**：列表里显示"疑似中断"，点重跑生成新的 run_id，旧记录留着，两次可对比。
- **不写假结论**：执行器抛错时 `finishRun` 根本不会被调用，所以不会有"失败"被伪造出来。

## 5. 执行侧的边界（`exec/run_trace.py`）

`recorded_run(trace, session_id, run_id, run_dir, executor)` 的顺序是**验件 → 开始 → 执行 → 结束**：

1. **先验件、后登记**：manifest 不存在就不调 `start`。否则库里留一条永远 `running` 的记录，
   把"派发链路缺件"伪装成"执行卡住"——比不登记更难查。
2. **run_id 必须一致**：manifest 里的 `run_id` 与要登记的不一致，一个请求都不发（服务端按
   `facts.run_id` 登记，对不上会凭空多一条没人发起过的运行）。
3. **指纹在执行之后算**：执行会追加 exec IR / 基线，先算再跑，交上去的指纹描述的是"跑之前"。
4. **执行抛错不补 finish**：异常上抛，run 留在 `running` 等 `stalled` 判定。

## 6. 落地文件与测试

- `aitestharness_tools/exec/run_trace.py`：`RunTrace`（两个动作，写操作不自动重试——
  超时重发会得到 409，这是故意的）+ `recorded_run`
- `aitestharness-tools/tests/smoke_run_trace.py`：7 例（缺件不登记、身份不一致零请求、
  异常留 running、重复登记被拒、指纹取执行后、多会话并行）
- `platform/packages/server/test/qa-run-execution.test.ts`：13 例（发起即 running、同会话多 run
  并行、结束校验、已结束不能重填、stalled 三态）
- 回归：`qa-task-run-registry.test.ts` 23 例通过；`tsc --noEmit` 干净

## 7. 判据 1 还差什么

这一轮只保证"发起有痕迹、结束有结论、断了看得出来"。**判据 1 仍未成立**，缺的是：

1. **发起方接线**：会话进入执行段时调 `startRun`（run_id 与 run 目录同源，manifest 由既有
   `create-run` 生成）——这一步要动阶段编排，影响面比执行侧大，因此单独做；
2. **执行器接入**：`local-service` 在真正执行时套一层 `recorded_run`，并把判据 3 的
   `plan_fingerprint` 继续作为执行的必经闸；
3. **报告侧断言**：报告引用的 `run_id` 必须能在 `qa_runs` 追溯到发起行（现在只是索引存在，
   没有断言"一定追得到"）。

另外 `stalled` 目前只在服务端派生，前端尚未显示——如果界面上看不出"疑似中断"，这个字段
等于没做。这条属于下一步的 UI 接线。
