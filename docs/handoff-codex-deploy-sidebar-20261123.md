# Codex 部署交接清单：侧栏菜单收敛批次（2026-11-23）

> 交接人：本地 Agent。部署执行：Codex。原则沿用 `docs/local-build-merge-deploy-runbook-2026-11-21.md`：源码 ≠ 运行版，走官方脚本（备份 → 换件 → 重签清单 → 自校验），禁止直拷。
> 本批次只改 **web 前端 + 共享 UI（penguin/ui）**，无服务端、无 core 引擎、无数据库改动。但注意：本地 main 上还有此前多批未推送提交（含 core 引擎改动），若与本次一起部署，**必须重新 build `platform/packages/core`**（core/dist 不入库，跳过会导致引擎改动不进运行副本——上一轮已发生过一次"部署后没生效"）。

## 1. 本批次提交内容（菜单收敛 + 项目资产归位）

> 热修 `4b5f5e5`（含在本批次内）：`ProjectBreadcrumb` 解构补进 `createSectionsUI`——修复部署验证时发现的资料页 `ReferenceError: ProjectBreadcrumb is not defined` 白屏。部署必须取到该提交之后的 main。

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 侧栏菜单收敛 | `penguin/ui/workspace-ui.mjs` | 一级菜单改为：测试助手（顶部按钮）、项目管理、测试任务、定时任务；删除「项目视图/项目环境/项目资料」三项；「项目管理」在三个子页（/qa/project、/qa/project/environments、/qa/library、/chat?view=library、/qa/project/confirm）保持高亮 |
| 品牌区回归 | `platform/packages/web/src/features/qa/workspace-ui.tsx` | 移除左上角项目切换器（ProjectNavigation），品牌区回落为 Logo + AITestHarness；项目上下文唯一入口 = 项目管理行内穿透 |
| 行内穿透 | `platform/packages/web/src/features/qa/project-management/project-management-page.tsx` | 操作列「进入 →」改「视图」（切到 /qa/project），新增「资料」链接（切到 /qa/library，按 library 模块权限过滤）；环境列点击直达 /qa/project/environments |
| 建档抽屉移除 | 删除 `bootstrap-drawer.tsx`（-230 行） | 其全部功能（建档状态/进度/重新建档）在项目环境页均有落点（环境页 366 行同款按钮） |
| 子页面包屑 | 新增 `project-breadcrumb.tsx` + `project-view.tsx`/`project-environments-page.tsx` 页头 + mjs SectionPage（资料页）注入 | 「项目管理 / 项目名 / 当前页 + 兄弟页链接」；样式 `penguin/ui/workspace-ui.css` 新增 `.qa-crumbs*` |
| 测试同步 | `test/project-management-page.test.ts` | 「进入 →」断言改「视图」 |

**路由零变更**：/qa/projects、/qa/project、/qa/project/environments、/qa/library、/chat?view=schedules 全部保留，旧链接与页面内文案指引（如"到项目环境页登记"）不失效。

## 2. 已做验证（部署前基线）

- web `tsc --noEmit` 0 错误。
- 定向测试 5 文件 46/46 通过：project-management-page / project-environments-page / qa-project-pagination / new-chat / current-agent。
- `node --check penguin/ui/workspace-ui.mjs` 语法通过。
- 存量失败（与本次无关，勿归因本批次）：全量 web 套件约 45 个文件失败（dock-state、nav-group-collapse、qa-skill-market 等，基线即有）；core/test/environment.test.ts:1750 TS 错误（未触碰）。

## 3. 部署步骤（按 runbook §5–§7）

1. `git diff --name-status <当前部署提交> <目标提交>` 确认变更范围与本清单 §1 一致；含 core 引擎文件则必须重跑 core 构建。
2. 构建（顺序执行，勿并行 server 与 desktop）：
   - `node scripts/build-assets.mjs`
   - server 构建（等 DTS 全部结束，见 "ESM Build success" 后仍有 DTS 阶段）
   - web：`node node_modules/vite/bin/vite.js build`
   - 如含 core：先 `pnpm --filter @prismshadow/penguin-core build` 再走 desktop 打包。
3. 官方 pause → 换件 → 重签清单 → 自校验；客户端仍连接或现状清单校验失败时停止部署。
4. 部署证据落 `output/release/<本轮名称>/`，不入 Git。

## 4. 部署后验收判据

1. 侧栏一级菜单恰为 5 项视觉行：测试助手（按钮）、项目管理、测试任务、定时任务、工作空间；顶部为 Logo + AITestHarness，无项目切换器。
2. 项目管理列表行内：点「视图」→ /qa/project（同项目）；点「资料」→ /qa/library；点环境列 → /qa/project/environments；环境列不再弹右侧抽屉。
3. 三个子页页头出现面包屑，兄弟页链接可横跳，面包屑「项目管理」回列表；进入子页时侧栏「项目管理」高亮。
4. 「定时任务」入口可见（路由 /chat?view=schedules 本就存在；按 schedules 模块权限过滤）。
5. 回归：新建任务 → 开始测试全流程（平台任务开工、需求分析派发）不受影响；项目视图统计卡与环境页建档按钮行为同前。
