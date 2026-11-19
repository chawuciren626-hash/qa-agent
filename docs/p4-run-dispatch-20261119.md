# P4 第五切片：run 派发队列（判据 1 的执行侧）

> 2026-11-19。承接 `docs/p4-authorization-20261119.md`（判据 3）。本轮只做判据 1 的**后半程**，
> 不标"判据 1 成立"——理由见文末。

## 1. 判据 1 的两半

判据 1 要求：一次任务内 `qa_tasks` / `qa_runs` 记录完整，`run_id` 能**从派发一直追到报告**。

这条线其实由两段组成，中间那条缝在本轮之前是空的：

| 段 | 谁做 | 本轮之前的状态 |
| --- | --- | --- |
| 派发方：决定"要跑这一份"，分配 run_id | 总控 / 阶段编排（agent 侧） | 未接（本切片不碰） |
| 执行侧：领取 → 执行 → 交回 manifest 事实 | 本地执行器（用户机器） | **完全不存在**：run 只有"执行完再登记"一个入口 |

所以之前 `qa_runs` 里的一行，含义是"我已经跑完了"。派发那一刻库里什么都没有，
`run_id` 也就不存在一条连续的线——只能靠人去比对目录名。本轮补的是执行侧这一段：
让 run 先成为一个**可被领取的待办**，再由真正的执行者把它变成一条有结论的记录。

## 2. 三个动作与它们的语义

```
POST /api/projects/:projectId/qa/task-records/:sessionId/runs   → 201 {run(status=queued)}
POST /api/projects/:projectId/qa/run-queue/claim                → 200 {run, reclaimed, leaseUntil} | 204
POST /api/projects/:projectId/qa/run-queue/:runId/report        → 200 {run(status=facts.status)}
POST /api/projects/:projectId/qa/run-queue/:runId/release       → 200 {run(status=queued)}
```

实现：`services/qa-task-run-registry.ts` 的 `enqueueRun` / `claimRun` / `reportRun` / `releaseRun`，
路由 `http/routes/qa-run-dispatch.ts`，迁移 `2026-11-19-qa-run-dispatch`（`dispatch_json`、
`claimed_by`、`claimed_at`、`lease_until`、`attempts` + 领取索引）。

**这一层不改变"manifest 才是事实真源"**：`dispatch_json` 只存派发意图（剧本/计划引用、
run 目录），回填仍走 `observeRun`（必须带 manifest 路径与指纹），`counts` 是覆盖写入。

## 3. 五个不显然的决定

1. **领取用一条带条件的 UPDATE 抢，不做"先查再写"。**
   两个执行器同时轮询时，先查再写会双双认为可领，后写的覆盖前者租约——同一条 run 跑两遍，
   副作用也两遍，而库里只有一条记录，看不出重复。`changes` 是唯一可信的抢到凭据。

2. **租约到期即可被重领，但必须标 `reclaimed` + 累加 `attempts`。**
   没有租约，执行器崩溃会让任务永远停在"执行中"，且无法区分"在跑"和"已经死了"。
   重领时把 `reclaimed=true` 交给执行器，它才有机会先反验再继续，而不是当全新任务从头跑。

3. **回填要求 `facts.runId === runId`，不一致直接拒绝、连 release 都不做。**
   `observeRun` 以 `facts.runId` 为键：不一致会**插入一条新 run**，派发的这条永远停在
   `running`，而结果挂在一条没人派发过的 run 下。放置回队列也不对——下一个执行器会踩
   同一个坑，根因必须留给人看。（`test_manifest_run_id_mismatch_is_refused_without_report`）

4. **缺 manifest 不是执行失败。**
   派发链路缺件（run 目录没建好 / manifest 没生成）与产品缺陷是两回事。执行侧只
   `release(reason="manifest_missing")`，不写任何"失败"结论——把"我没跑起来"写成
   "用例失败"，是这类系统最常见也最难纠正的假事实。

5. **执行抛错不伪造结论，交回原因带异常类型。**
   `executor_error:<Type>` 回队列，由 `attempts` 暴露"反复拉起又失败"。执行侧无权判定
   产品对错；它的产出只有"我按这份计划做了什么、看到什么"。

## 4. 落地文件与测试

- `aitestharness_tools/exec/dispatch.py`：`PlatformQueue`（三个动作，写操作不自动重试——
  超时后重发会造成双领或双交）+ `consume_once`（领取→执行→交回，执行器注入）
- `aitestharness-tools/tests/smoke_dispatch.py`：9 例，内存平台替身 + 临时 run 目录
- `platform/packages/server/test/qa-run-dispatch.test.ts`：14 例（队列语义 + 身份校验 + 幂等）
- 回归：`qa-task-run-registry.test.ts` 23 例通过；`tsc --noEmit` 无输出

## 5. 为什么还不叫"判据 1 成立"

缺的还是**派发方**：现在没有任何产品路径会调用 `enqueueRun`。总控派发阶段（把
①②③④ 的产物编译成一份执行计划、分配 run_id、落 run 目录与 manifest）尚未接线，
而这正是"全程只用产品界面与真实派发"那句话里最有分量的一半。

剩下三件（按依赖顺序）：

1. 派发方接线：阶段编排在进入执行段时 `enqueueRun`（run_id 与 run 目录同源，
   manifest 由既有 `create-run` 生成）；
2. 执行器循环：`local-service` 起轮询线程 → `consume_once` → 执行器注入
   `WebEngine` + 授权（判据 3 的 `plan_fingerprint` 在这里仍必须生效）；
3. 报告侧读同一 `run_id`：`qa-quality-traceability` 目前已有 run 索引，需要断言
   "报告引用的 run_id 一定能在 `qa_runs` 里追溯到派发行"——这是判据 1 的最后一段。

本轮只保证：**这一段接通后，`run_id` 不会在中途被换掉或凭空多出来。**
