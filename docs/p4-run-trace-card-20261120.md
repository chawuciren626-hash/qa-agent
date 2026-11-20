# P4 第七切片：运行痕迹卡前端落地（2026-11-20）

- commit：`444d9bb`（分支 `codex/remove-first-run-guide-20261118`）
- 原型：`prototype/run-trace-stalled-prototype.html`（2026-11-20 用户确认）
- 触达：`platform/packages/web`（web 一行没碰的口径就此作废，本切片只动 QA 任务详情页）

## 做了什么

任务详情页（`features/qa/task-detail.tsx`）在选择运行后挂一张**运行痕迹卡**（`run-trace-card.tsx`），数据来自 `GET /api/projects/:pid/agents/qa/task-records/:sid/runs/:rid/trace`（server 读模型 `qa-run-trace.ts`，第六切片已交付）。卡片是 `<details>` 折叠区：

- **摘要行**：状态徽标 + 一句话（疑似中断 / 未登记 / 执行中 / 已收尾 / 无痕迹）。
- **alert 条**（红/琥珀/蓝，仅异常场景，默认展开卡片）：
  - 崩溃：`stalled && orphaned`（锁在、持锁进程已退出，不等阈值）→ 红条，文案含「不要自动续跑：真机上有写操作，自动续跑等于重复执行」；
  - 超阈值：`stalled` 非 orphaned → 红条，附 `stalledReason` 与阈值分钟数；
  - 发而未跑：`dispatch.dispatchedAt` 在而 `startedAt/finishedAt` 空、`attempts===0` → 红条（第五切片 dispatch.json 接线后才可见的一格）；
  - 未登记：`registered:false && trace.present` → 琥珀条，「平台不会替它补一行」；
  - 长跑：未收尾、开始已超阈值但最后活动未超 → 蓝条「这是长跑，不是卡住」。
- **时间线**：manifest → dispatch → 执行开始 → 最后活动 → 结束/负面节点；每个节点标注它来自哪份文件。
- **事实网格**：登记、startedAt、finishedAt、最后活动、attempts、阶段、dispatch（含 host）、持锁进程（pidStatus 三态）、stalled 判定、manifest sha256、执行器阻塞原因。
- **口径说明**：按场景给出「为什么这样判」（pid 证据优先于时间阈值、判中断只看最后活动等）。

## 明确不做的

- **不放假按钮**：原型里有「重新发起 / 标记已人工处置」，真实端点不存在，卡片只读——宁可少一个按钮，不可多一个假交互。
- **404 `run_not_found` 不算页面错误**（未登记且无目录痕迹 → 静默）。
- **形状防御**：响应里读不出 `trace.execution` 就不展示，不编造事实。

## 验证

- `pnpm typecheck` 干净；`qa-task-detail.test.ts` 5 例（新增 stalled 用例：红条默认展开、证据文字、无假按钮断言）、QA 子集 8 文件 32 例全过；`vite build` 通过。
- 测试 mock 顺手补了 `ApiError` 导出与 `/trace` 分支（此前 mock 对未知路径一律返回 Detail 形状）。

## 边界

- 卡片位置只在任务详情页；项目视图 / 概览页的运行列表徽标（原型左侧栏那种）本轮未做，可按需追加。
- `staleAfterMs` 阈值随接口返回并在文案里展示，前端不硬编码 30 分钟。
