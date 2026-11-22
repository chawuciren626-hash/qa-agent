# 流 D：执行引擎改造报告（2026-11-22）

## 0. 分支与提交

- 分支：`feat/stream-d-execution`，从 `main` 最新提交切出。
- 工作区：独立 worktree `E:\AItestHarness-stream-d`，未改动主工作区（流 B 的未提交改动保持原样），`main` 无新提交。
- 6 项独立提交：

| 提交 | 内容 |
| --- | --- |
| `ad6eb85` | D1 脚本资产化 |
| `97f01d4` | D2 托管浏览器版本受控 |
| `72af981` | D3 分片并行调度 |
| `f045dbd` | D4 优先级分层 |
| `c8a2940` | D5 环境级互斥 |
| `dbd5055` | D6 grounding 三后端 driver |

## 1. 现有链路与落点（梳理结论）

```
用例确认 → scripts/execution-plan.mjs（计划模型 + 校验）
        → approve（execution-authorization）
        → prepare_execution_plan（structured-actions，内部复用 web-script-library）
        → validate_execution_prepare
        → scripts/browser-task.mjs（单浏览器/多操作 + Playwright 启动）
        → scripts/execution-runner.mjs（attempt 生命周期 + preflight + Playwright CLI）
        → execution/attempts/<invocation_id>/（attempt.json、playwright-results.json、证据）
        → scripts/build-quality-metrics.mjs（质量指标）
```

落点：D1 挂在 `web-script-library` 归档/复用路径（不侵入 structured-actions 契约）；D2 挂在 `browser-task` 真实 `chromium.launch` 点；D3/D5 挂在 `execution-runner`（默认路径不变，按计划开关启用）；D4 在 `execution-plan`/`create-execution-plan`；D6 为独立抽象模块。

## 2. 改动文件与行号范围

### D1 脚本资产化

- `scripts/execution-script-assets.mjs`（新增，1–172）
  - `scriptCatalogPath`(16)、`emptyCatalog`(25)
  - `caseVersion`(34)、`anchorVersion`(39)、`environmentVersion`(46)
  - `scriptAssetId`(50)、`scriptBinding`(55)
  - `deriveScriptAssets`(70)、`registerScriptAssetCandidates`(108)
  - `scriptAssetStatus`(137)、`bundleAssetStale`(162)
- `scripts/web-script-library.mjs`
  - 9：引入资产模块。
  - 75–82：`registerCandidates`，登记失败不影响 verified 归档。
  - 114–116：`already_archived` 分支补登记。
  - 128–129：新归档成功后登记 candidate。
  - 144–147：复用时剔除环境版本漂移的 bundle（只让受影响用例再生）。
  - 160–167：复用后把 `script_assets.reused/regenerate` 写入执行计划。
- `scripts/test-asset-catalog.mjs` 6：`assetKinds` 增加 `execution_script`。
- `schemas/test_asset.schema.json` 8：kind 枚举同步增加 `execution_script`。

资产绑定三版本：`case_version`（设计用例内容指纹）、`anchor_version`（锚点/资产引用排序指纹）、`environment_version`（环境配置文件字节指纹）。首跑通过 → `status: candidate`；人审晋升 `verified` 后 `scriptAssetStatus` 才判定为可零生成复用；三版本任一漂移只把该用例列入增量再生。

### D2 托管浏览器

- `config/browsers.json`（新增，1–16）：锁 `playwright: 1.63.0`、可选 `chromium_major`、`batch_headless`、`login_headed`、`isolate_workers`、viewport/serviceWorkers。
- `scripts/browser-launch-policy.mjs`（新增，1–109）
  - `DEFAULT_BROWSER_POLICY`(9)、`browserPolicyPath`(23)、`readBrowserPolicy`(27)
  - `assertPlaywrightVersion`(46)、`assertChromiumVersion`(61)
  - `resolveLaunchHeadless`(72)、`launchOptions`(78)、`workerContextOptions`(90)、`browserPolicyReceipt`(100)
- `scripts/browser-task.mjs`
  - 27：引入策略模块。
  - 109：新增 `browser_policy_mismatch` 诊断分类。
  - 239：`start.mode` 仅允许 `batch|login`。
  - 879–896：启动时读取策略、校验 Playwright/Chromium 版本、按模式决定 headless、写入版本回执、每 worker 独立 context。

说明：D2 任务描述指向 `local-browser-executor.mjs`，但该文件只是入口，真实 Playwright 启动在 `browser-task.mjs`，因此改在启动点实现，避免中间层重复包装。

### D3 分片并行调度

- `config/pool-capacity.json`（新增，1–10）：`pools {web:2, api:2, android:2, miniprogram:2}`、`max_shard_workers:2`。
- `scripts/execution-shards.mjs`（新增，1–178）
  - `DEFAULT_POOL_CAPACITY`(7)、`readPoolCapacity`(18)
  - `buildShards`(37)：模块 × 数据画像分片，片内按优先级排序。
  - `planShardWaves`(70)：波内并发 ≤ 池容量，共享 `resource_keys` 的分片不同波。
  - `planSha256`(90)、`readBatchCheckpoint`(94)、`writeBatchCheckpoint`(100)
  - `mergePlaywrightReports`(104)
  - `runShardedPlaywright`(116)：每片独立 Playwright 进程与 `QA_RUN_DIR`，波内 `Promise.all`，完成后写 `shards/checkpoint.json`，同计划指纹恢复时跳过已完成分片。
- `scripts/execution-runner.mjs` 14、85–96：`execution_policy.sharding.enabled === true` 且 host 后端时走分片，写入 `shards/summary.json`；默认路径（未开启）完全不变。
- `scripts/execution-plan.mjs` 72–76、100–116：sharding 结构校验与 phases 校验。
- `scripts/create-execution-plan.mjs` 53：`environment.execution.sharding === true` 时计划开启分片。
- `tests/acceptance/execution-shards.test.mjs`（新增，1–95）：分片/优先级、波次容量与资源键串行、报告合并、实测并行度=2、检查点恢复零重跑。

### D4 优先级分层

- `scripts/execution-plan.mjs`
  - 3–24：`PRIORITY_RANK`、`normalizePriority`、`caseModule`、`caseResourceKeys`。
  - 47–65：执行用例增加 `module/priority/resource_keys`，按 P0>P1>P2 稳定排序。
  - 78–83：校验 priority 枚举、module 非空、resource_keys 为字符串数组。
- `scripts/create-execution-plan.mjs` 33–41、50–51：输出 `phases`（`smoke` 快速反馈 / `regression` 批量窗口）与 `priority_summary`。
- `schemas/test_case.schema.json` 未改：既有 schema 已要求 `priority ∈ {P0,P1,P2}`（与流 B 的 schema 改动解耦）。

### D5 环境级互斥

- `scripts/environment-lock.mjs`（新增，1–73）
  - `environmentLockDir`(13)：隔离模式落项目级 `locks/environments`，锁在任务目录之外。
  - `environmentLockPath`(22)
  - `acquireEnvironmentLock`(47)：`O_EXCL` 创建；占用方进程已死或超 TTL 才回收；同 run 恢复可接管。
  - `releaseEnvironmentLock`(68)：token 校验，只释放自己的锁。
- `scripts/execution-runner.mjs`
  - 15、21：引入并声明 `envLock`。
  - 71–73：preflight 前按 `config.environment` 获取环境锁，失败即 blocked。
  - 114–117：`finally` 释放。

### D6 grounding 三后端 driver

- `scripts/grounding-driver.mjs`（新增，1–155）
  - `flattenTree`(12)、`findNode`(19)、`anchorTokens`(27)、`nodeTokens`(40)、`matchFingerprints`(52)
  - `resolveStructural`(70)：结构层零模型；<2 指纹、同分歧义均判未命中。
  - `reverseLookup`(89)：坐标取最小包含节点，且必须有指纹与锚点一致。
  - `toStructuralAnchor`(107)：任意后端命中固化为结构锚点。
  - `createGroundingDriver`(122)：结构 → 语义（命中降级并校验结构节点）→ 视觉（坐标必须反查结构节点），返回 `model_calls` 与逐后端 `attempts`。
- `tests/acceptance/grounding-driver.test.mjs`（新增，1–64）：结构零模型、单指纹拒绝、语义降级、语义无锚点拒绝、视觉坐标反查。

## 3. 新增接口一览

- 资产：`deriveScriptAssets`、`registerScriptAssetCandidates`、`scriptAssetStatus`、`bundleAssetStale`。
- 浏览器：`readBrowserPolicy`、`assertPlaywrightVersion`、`assertChromiumVersion`、`resolveLaunchHeadless`、`launchOptions`、`workerContextOptions`、`browserPolicyReceipt`。
- 调度：`readPoolCapacity`、`buildShards`、`planShardWaves`、`readBatchCheckpoint`、`writeBatchCheckpoint`、`mergePlaywrightReports`、`runShardedPlaywright`。
- 优先级：`normalizePriority`、`caseModule`、`caseResourceKeys`、`PRIORITY_RANK`；计划字段 `phases`、`priority_summary`。
- 互斥：`environmentLockDir`、`environmentLockPath`、`acquireEnvironmentLock`、`releaseEnvironmentLock`。
- grounding：`resolveStructural`、`reverseLookup`、`toStructuralAnchor`、`createGroundingDriver`。

## 4. 依赖的既有机制

- attempt 生命周期与原子落盘：`execution-attempts.mjs`（`beginAttempt`/`finishAttempt`/`atomicJson`）。
- 计划契约：`execution-plan.mjs` 的 `createExecutionCases`/`validateExecutionPlan`，未改变 attempts 输入输出结构。
- 授权与快照：`execution-authorization.mjs`、`approval-snapshot.json`。
- 复用基础：`web-script-library.mjs` 的 verified bundle 归档与指纹复用。
- 环境与隔离：`directory-context.mjs`（isolated/installed、`dataPath`、`resourcePath`）。
- Playwright 报告契约：`playwright.config.ts` 以 `QA_RUN_DIR` 决定 `playwright-results.json` 位置；分片据此各写各的目录再合并。

## 5. 测试结果

- `node --check`：本次改动/新增的 11 个脚本全部通过。
- `node --test tests/acceptance/execution-attempts.test.mjs`：15/15 通过（两轮，D5 后复跑确认环境锁不影响既有契约）。
- `node --test tests/acceptance/web-script-library.test.mjs tests/acceptance/execution-shards.test.mjs tests/acceptance/grounding-driver.test.mjs`：10/10 通过。
  - D3 测试实测同一波两个分片进程重叠执行（`maxActive = 2`），并验证同计划重跑复用检查点、零进程重启。
- 内联校验：`createExecutionCases` 输出 P0→P1→P2 顺序；`validateExecutionPlan` 对 `phases` 分区校验通过；环境锁「首个获取成功 / 其他 run 被拒 / 同 run 接管 / 释放后可再获取」符合预期。

## 6. 已知限制

1. D1：登记的资产是 `candidate`，需人审晋升 `verified` 后才计入零生成复用；真正复用仍走 `web-script-library` 的 verified bundle，catalog 负责治理与失效判定。隔离模式的资产目录在 `QA_APP_DATA_ROOT/projects/<project>/automation/test-assets.json`，安装模式回退到 `config/test-assets.json`。
2. D2：版本锁按主版本比对（浏览器安全更新不阻断）；未找到打包 Chromium 时沿用既有 `channel: chrome` 回退；单个 `browser-task` 进程仅创建一个 context，跨 worker 隔离由分片/多进程提供。
3. D3：分片仅支持 host 后端（WSL 会校验失败）；`config/pool-capacity.json` 默认 `web:2` 是显式策略值；分片为 opt-in（`execution_policy.sharding.enabled`），默认单进程行为不变；任一分片终止/无报告会中止整批，但已完成分片保留检查点。attempt 目录新增 `shards/` 文件，原有输入输出文件结构未改。
4. D4：`phase` 仅做计划分区与排序，尚未接入 UI/CLI 的“只跑 smoke”入口；测试选择 profile 属流 E 范围，未改动。
5. D5：环境锁以进程存活 + TTL 判定，跨主机依赖 TTL；attempt 结束即释放，即使终止不确定也释放（串行语义优先，恢复语义仍由 attempt 锁与 `recoverAttempt` 承担）。
6. D6：driver 为纯抽象，语义/视觉适配器（Midscene、computer-use）需由调用方注入，尚未接入 `browser-task`/锚点资产；视觉反查依赖快照提供 `bounds` 或 `node_id`。
