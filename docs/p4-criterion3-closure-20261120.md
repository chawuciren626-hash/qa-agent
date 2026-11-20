# P4 判据 3 收口：把已有的闸装上（2026-11-20）

> 本文记录 **E2E-1 判据 3**（卡点有效性 + 确认人受权限校验）的收口。两条改动都不新增能力，
> 只是把已经写好但没有任何调用方的机制接到真实路径上——同一个项目里反复出现的那类缺陷：
> **表建了、函数写了、界面也展示了，闸门前没人经过。**

## 1. 两个缺口，同一个形状

### 1.1 确认卡点没有角色校验

`qa-confirm-gate.ts` 的 `approve` / `reject` 用的是 `scope(c)`：

```ts
const scope = (c) => {
  const projectId = requireValidId(c, "projectId");
  deps.access.requireProjectAccess(c.var.user.userId, projectId);  // 只问"能进这个项目吗"
  return { projectId, userId: c.var.user.userId };
};
```

`requireProjectAccess` 对 owner 与 member 一视同仁，所以**只读成员也能把卡点点掉**。而同一个
应用里，缺陷确认、复测登记、报告发布早就是 owner-only（`qa-quality-traceability.ts` 的
`ownerScope`，`role !== "owner"` 即 403 `project_owner_required`）。

两套口径并存的实际后果不是"权限不严"，而是**权限判定看起来时灵时不灵**：同一个用户在
「报告能不能发」上被拒，却在「这一段产物能不能往下走」上畅通。这类不一致最终会被当成 bug
报上来，然后被随手放宽成一致——两个都松。

### 1.2 资源池租约没有强制执行点

`qa_pool_leases` 表、`acquirePoolSlot` / `releasePoolSlot` / `poolStatus` 三个方法、`GET …/pools`
展示都在，**唯一调用方是测试自己**。`startRun` 从不申请槽位，`finishRun` 也从不归还。

§6.3 已经把后果写清楚了：Android 只有 1-2 台、小程序 1-2 个，两个 run 抢同一台设备会**双双**
出现偶发失败。而 P7 刚把 `flaky` 做成一个正经结论（不可复现即判 flaky 并给出候选），误判会被
这个新结论放大——"两个 run 抢设备"会被写成"这条用例不稳定"。

## 2. 做法

### 2.1 批准是背书，不是干活

| 动作 | 作用域 | 理由 |
|---|---|---|
| `submit`（送审） | 成员 | 准备材料本来就是成员干的活 |
| `approve` / `reject` | 所有者 | 决定"这一段能不能往下走"，是背书 |

`qa-confirm-gate.ts` 新增 `ownerScope`，与 `qa-quality-traceability.ts` 同口径（同样的
`role !== "owner" || ownerUserId !== userId` 判定、同样 403 `project_owner_required`），
所以前端已有的错误码处理直接生效，不需要改 UI。

### 2.2 声明了池才受管，拿不到就拒

发起路由（`POST …/runs`）：

1. **先取槽位，再登记**。取不到 → `409 pool_full`，消息里带**占用者与到期时间**
   （`资源池 web 没有空槽位（容量 1）：run-x（至 2026-11-20T…）。`）——只说"跑不了"等于没说。
2. **不排队、不忙等**。产品里没有队列（v13 已把队列整体收回），"发起会话就跑"是用户看到的
   行为；排到半小时后再跑等于骗人。
3. **登记失败要归还**。`run_id` 拼错会走到 `run_exists` 409，此时槽位已经取过——不还的话，
   一次手误白占一台设备到 TTL 到期，而人只会看到"资源池满了"却查不出原因。
4. **结束即归还**。`finishRun` 成功后按 `run.resource_pool` 释放；槽位在 TTL 过期后可能已换人，
   所以删除条件带 `holder_run_id`，**迟到归还是一行都不删**，返回 0 不是错误。
5. **崩溃交给 TTL**。执行器崩了不会调 `finish`，租约到期自动空出——这也是租约相对"加锁标志位"
   的唯一好处。

不移交 `startRun` 内部做，是因为取槽位与登记是两次写：先取后登记失败还能补偿（释放），
先登记后取失败就得回滚一条已经写进去的 run 行。

**不猜池**：`resourcePool` 未声明就不受管。池是物理事实，默认成 `web` 会把纯 API 的 run 也卡住，
而这类"猜一个默认值"的写法正是本项目反复踩的坑（`product` 当默认归因、`started_at` 编时间）。

## 3. 钉住的四条语义

`test/qa-run-pool-lease.test.ts`（2 例，走真实 HTTP）：

1. 同池第二个 run → `409 pool_full`，消息含占用者 `run-p1`；
2. 未声明池的 run 同时可以起来（阴性对照：证明闸只拦声明过的）；
3. `finish` 之后第三个 run 立刻能起来（不必等 TTL）；
4. `run_id` 重复 → `409 run_exists`，且**紧接着的 run 能起来**（证明补偿释放真的发生了）。

另两个测试文件：`qa-task-run-registry.test.ts` 增 1 例
（按 run 释放只还自己的；租约被接管时 0 行；跨项目同 run_id 不误删），`qa-confirm-gate.test.ts`
增 1 例（成员能送审、不能批准/退回，被拒后批次仍停 `reviewing` 且所有者仍可退回）。

## 4. 已知边界（都不藏在代码里）

1. **闸存在但真实链路上没人经过**：`startRun` 目前没有调用方——P4 判据 1 的"发起方接线"仍未做。
   所以这轮验的是"闸装对了"，不是"线上已经按这个跑"。接派发时要复核 `DEFAULT_POOL_CAPACITY.web = 1`
   是否过紧（§6.3 的描述是"Web 单机可多实例，受内存限制"，与 1 不符）。
2. **长跑会失去租约**：TTL 默认 30 分钟，超过就自动空出。续租的写法是同一个 run 再调一次
   `acquirePoolSlot`（幂等、会刷新 `lease_until`），但目前没有心跳方——真机 40 分钟长跑需要它。
3. **租约是全局的，不是按机器分的**：多机部署时 A 机的 run 会让 B 机以为槽位被占。当前是单机产品，
   未处理。
4. **管理员口径不变**：`qaAuthorization` 已禁止管理员代写别人项目；这轮只把成员挡在批准动作外，
   不改管理员语义。

## 5. 验收

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 干净 |
| `qa-run-pool-lease` | 2 例（新增） |
| `qa-confirm-gate` | 10 例（9 → 10） |
| `qa-task-run-registry` | 24 例（23 → 24） |
| 相邻回归（`qa-run-execution` 13 / `qa-run-trace` 10 / `qa-run-trace-route` 1 / `qa-quality-traceability` 8 / `qa-task-run-migration` 6） | 全绿，共 62 例 |
| `npm run ci:contract` | A1-A4 / B1-B4 PASS，release `--check` consistent |

## 6. 判据 3 现在到哪一步

| 判据 3 的要求 | 状态 |
|---|---|
| ①②③ 三处 confirm 都真实阻断过（有人不点就不往下走） | ✅ `approve_blocked` + `hard_gate_failed` 早就在跑 |
| 确认人受权限校验 | ✅ `approve`/`reject` 归所有者；同一产品口径统一 |
| "没权限的人点了也没留下东西" | ✅ 被拒后批次仍停 `reviewing`，审计不写 `approved` |

**E2E-1 四条判据**：判据 2（确定性）、判据 4（可解释）、判据 3（卡点）成立；判据 1 只剩两个
边缘——执行器启动前就断掉的运行进不了 `qa_runs`（需产品决策），以及发起方接线。
