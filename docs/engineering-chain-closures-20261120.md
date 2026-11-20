# 工程链收口四切片（2026-11-20）：迁移进发布链 / uid 反查 / 健康摘要 / G6 最小实体

四个 commit，全部无外部依赖，本文是记录与边界。

## 1. §6.4 红线 3：schema 迁移进发布链（`42604f8`）

- server 新增 `src/migrate-db.ts`（+ tsup entry `./migrate-db` + package.json exports）：照
  `reset-admin-password` 纪律——本地文件访问即授权、live server 持 root 时拒绝（web.db 单写者）、
  **db 不存在时不创建**。openDatabase 前后账本 diff 报出本次应用的迁移名单。
- `scripts/release.mjs` 发布流程 3 步→4 步：pause → 部署 → **迁移（新代码对 web.db，失败则发布
  中止、服务保持 paused）** → resume。数据根从 installation.json 经 `loadProductLayout` 取
  `host_data`，与服务的 `PENGUIN_HOME` 同源。
- 测试 4 例（`test/migrate-db.test.ts`）：缺库不创建 / 已最新零写入（mtime 不变）/ 老库补迁移按名
  报告且幂等 / live server 拒绝。
- **部署注意**：tsup entry 变了，发布前要重新构建 desktop 并重打 stamp（`release.mjs --check` 现在
  不一致是预期——第九切片构建 web 后产物已变）。

## 2. P6 缺陷按 uid 反查（`bc83bb9`）

- `listDefects` 增 `pointUid` 过滤：`json_each` 对 `related_points_json` **整值匹配**（不用 LIKE
  子串——内容哈希截断互为前缀时子串匹配会误伤）。路由 `GET /qa/defects?pointUid=`，零新端点。
- 测试 +1（traceability 套件 9 例）：正向命中 + 阴性对照（未关联 uid → 0 条）。

## 3. §6.5 一次 run 的健康摘要（`26f900e`）

- `services/qa-run-health.ts` + 路由 `GET /qa/task-records/:sessionId/runs/:runId/health`：
  - 工具面：`<engineRoot>/output/runtime/tool-usage.jsonl` 按 run_id 过滤，executions / invoked /
    degraded / checks 按 status 分组（execution 与 check 是两条流，成功计数不混诊断）；
  - token 面：`usage_records` SQL 聚合——session 全量 + `started_at` 之后的窗口增量；
  - trace 事实同源（present/stalled/startedAt）。
- **诚实边界**：engineRoot 未配置或无流水文件时 `tools` 为 null（附 `toolsSource` 指路）——
  「看不到」和「零次」是两个事实，不编 0。404 纪律与 trace 路由一致（未登记且无痕迹=不存在）。
- 测试 +2（trace-route 套件 3 例）：聚合正确性（别的 run 的行不混入、窗口边界、失败请求计数）+ 无文件阴性。

## 4. G6 资产治理最小实体（`e8735a3`）

- **G6 此前在文档中无定义**（grep "G6"/「资产治理」均无展开）。本切片给它第一件有据可查的内容：
  `acquirePoolSlot` 事务内顺手 `DELETE` 全表过期租约——包括容量缩到比历史峰值小之后
  `slot≥capacity` 的残行（acquire 的接管循环只扫 `[0,capacity)`，扫不到它们）。
- 有效租约的行不可能过期（`lease_until > now`），删除不可能误伤。
- 测试 +1（pool-lease 套件 3 例）。
- **G6 剩余面（已写进主计划定义，未做）**：`tool-usage.jsonl` 无限增长（按天聚合靠读方，文件本身
  无轮转）；`output/runs/` 产物保留策略。两者都涉及「删数据」，先有保留期决策再动手。

## 5. §6.2 token 预算的诚实盘点（无代码，订正主计划）

侦察结论：契约面已完整（`TASK_CONTRACTS` 5 条全有 `budget_tokens`/`on_exceed`，CI B1 断言非空
合法）；**但 `dispatch()` 零生产调用方**——派发包（含预算字段）没有任何运行时消费方，「超限强制
降级/中止」没有可挂的执行点。硬接 = 给不存在的链路造闸（v13 派发队列的教训同型）。

- **已接通的两半**：契约面（P5 声明 + CI 断言）；可见面（健康摘要回答「这个任务花了多少 token」）。
- **blocked-on-dispatch**：运行时强制面等 dispatch 派发链真实存在时接——届时 `dispatch()` 返回包
  自带 `budget_tokens`/`on_exceed`，消费方读包即可强制，契约不用改。

## 验证

server typecheck 干净；migrate-db 4 例 + traceability 9 例 + trace-route 3 例 + pool-lease 3 例全过
（后三套需 `AITEST_ENGINE_ROOT=E:/AITestHarness/source`）。
