# Codex 部署交接清单（2026-11-21）

> 交接人：本地 Agent（ZCode）。部署执行：Codex。本清单覆盖本地 main 上两个未部署的批次，以及 D:\AITestHarness 当前的已部署状态与回滚点。
> 原则不变：源码 ≠ 运行版；所有部署走官方脚本（备份 → 换件 → 重签清单 → 自校验），禁止直拷。

## 1. 本地提交（main，未推送）

| commit | 内容 | 文件 |
| --- | --- | --- |
| ① `fix(探索)` | 建档/全站探索五处失真修复（P1-P5）：静态资源路由过滤、`prefix='/'` 路由全拒 bug、BFS 链接发现 + 落地页/重定向捕获、去硬编码幽灵路由（`//login`、`/profile/password`）、apis `/v2/` 过滤清零、探索回写报告；新增 `deploy-engine-files.mjs` | `aitestharness-tools/.../explore/explorer.py`、`scripts/merge-explore-maps.py`、`scripts/deploy-engine-files.mjs`、`aitestharness-tools/tests/smoke_merge_explore_pages.py` |
| ② `feat(探索)` | 证据层第一批（零 LLM）：语义证据提取（价格/字段标签/选项列表，逐字+多策略定位器+内容哈希）→ `observations.json`；确定性 question/rule 生成；服务端 `syncEvidence` 写入 `qa_exploration_hypotheses`（G4 接水）与 `qa_knowledge_candidates`（去重、系统来源、owner 确认队列）。commit ② 的 `explore-authenticated.mjs` 同时携带批次 ① 的同文件修复 | `scripts/explore-observation-model.mjs`、`scripts/explore-authenticated.mjs`、`tests/acceptance/explore-observation-model.test.mjs`、`platform/packages/server/src/services/project-exploration-service.ts` |
| ③ `docs` | 本清单 | `docs/handoff-codex-deploy-20261121.md`、`.gitignore`（白名单例外） |

## 2. 验证基线（交接时实测）

- `node --test tests/acceptance/explore-observation-model.test.mjs`：5/5 过。
- `python -I aitestharness-tools/tests/smoke_merge_explore_pages.py`：25/25 过（含幽灵路由/基线并集/回写报告/公开模式/根前缀 apis 断言）。
- server `tsc --noEmit`：本批次文件 0 错误。**已知未过项（非本批次）**：`test/desktop.test.ts(194)` 与 `test/vendor-group-models.test.ts` 的 implicit-any——属工作区里并行进行的 account-client / user-models-settings 改动，部署时与提交人确认。
- 环境预存（已解决/如实记录）：`smoke_tools.test_bootstrap_1010` 需要 bs4（两台 Python 均已注入 bs4 4.15.0 + requests 2.34.2）；platform vitest 在本机有预存 boot 失败（`project-exploration.test.ts` 等 12 例，与本批次无关，CI 基线为准）。

## 3. D:\AITestHarness 当前状态（上次部署结果）

- buildId `d37bbc643f7f576a`（server 87e63e69… / web 460 文件），清单自校验 1133+432 全过，迁移 37/37 无变更，服务恢复运行（port 55875）。
- 已包含：批次 ① 引擎文件 + 服务端、**提交时工作区里并行进行的** account-client.ts / user-models-settings.tsx 改动（当时未提交，部署产物与 commit 无一一对应）。
- **未包含**：批次 ②（证据层）——本次 Codex 要部署的主体。
- 回滚点：`D:\backups\engine-files-2026-11-20T16-42-34-409Z`、`D:\backups\project-management-2026-11-20T16-42-50-538Z`。

## 4. 部署步骤（Codex 执行）

```powershell
# 0) 前置：桌面客户端从托盘退出；仓库根 node_modules 与 platform 依赖就位
npm ci
cd platform; pnpm install --frozen-lockfile
pnpm --filter @prismshadow/amsp build; pnpm --filter @prismshadow/penguin-core build
pnpm --filter @prismshadow/penguin-cli build; pnpm --filter @prismshadow/penguin-hmr build
pnpm --filter @prismshadow/penguin-server build
pnpm --filter @prismshadow/penguin-desktop build   # 产出 dist/server.js + migrate-db.js
pnpm --filter @prismshadow/penguin-web build       # 产出 web dist

# 1) 打戳 + 发布（web/server/迁移，自动 pause→deploy→resume）
cd ..
node scripts/release.mjs --stamp
node scripts/release.mjs D:\AITestHarness

# 2) 引擎文件（scripts/、aitestharness-tools/ 变更探测→换件→重签→自校验，失败回滚）
node scripts/local-service.mjs pause D:\AITestHarness\installation.json
node scripts/deploy-engine-files.mjs D:\AITestHarness
node scripts/local-service.mjs resume D:\AITestHarness\installation.json
```

要点：
- `deploy-engine-files.mjs` 自动比对清单 `engine_files` 与源码树哈希，改了什么同步什么，没改不动；前置要求服务已暂停。
- 部署顺序可以反过来（先引擎后 release），只要两次换件都发生在 pause 窗口内。
- 若 `desktop.test.ts` 等 typecheck 问题未解决，先与提交人对齐再构建，不要带红构建。

## 5. 部署后验收（可测判据）

1. 探索一轮（saucedemo，全站模式）后，轮目录出现 `observations.json`：`observations[]` 含价格/字段标签/选项列表条目（逐字 verbatim + locators 多策略 + content_hash），`questions[]`/`rules[]` 按 facts 生成；`explore-receipt.json` 出现 `observations/questions/evidence_rules` 三个计数。
2. `web.db`：`qa_exploration_hypotheses` 出现 `created_by='system:exploration:round-<n>'` 的行（statement 为可判定句子）；重复探索不产生重复行（statement 去重）。
3. `qa_knowledge_candidates` 出现 rationale 标注"系统：探索 round-N"的 pending 候选（价格类带业务对象上下文才生成）；确认后进 `qa_project_rules` 版本链。
4. 探索轮次详情 summary 出现 `evidenceSync: {hypotheses, candidates, skipped}`；失败时 `error` 如实记录且不改探索 succeeded 结论。
5. 回归红线：探索失败轮不写任何证据（与知识层同口径）；`report_untraced` 等既有闸不受影响。

## 6. 边界与后续（未做，勿误报完成）

- 交互类证据（错误文案/状态转换）属第二批会话侧证据轮（总控派发 + browser_task 回执 + 任务契约 Done when），本批零 LLM 入口明确不采集，receipt limitations 已写明。
- 逆向需求文档（PRD）视图未做（用户决策：等证据层稳定）。
- 候选归属当前挂项目所有者（rationale 标注系统来源）；会话侧证据轮落地后改用真实 session 归属。
