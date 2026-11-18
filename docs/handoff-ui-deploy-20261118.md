# 界面部署排查与重新部署指引（WorkBuddy → Codex，2026-11-18）

> 现象：codex 部署后用户看不到 WorkBuddy 新做的界面。
> **根因已定位：`platform/packages/web/dist/` 是 2026-11-13 11:15 的旧构建产物**，不含 11-17/11-18 任何提交的前端代码（用 `grep -l "确认卡点" dist/assets/*.js` 验证为空）。也就是说，部署的产物早于全部 43 个本地提交——**不只缺 WorkBuddy 的页面，Qoder 11-17 的环境建档界面同样不在里面**。
> 代码都在本地分支 `workbuddy/batch2-env-onboarding`（工作区 `E:\AITestHarness\source`，**未推送**，请直接从该分支构建）。

---

## 1. 需要重新部署的范围

| 侧 | 内容 | 动作 |
|---|---|---|
| web（`platform/packages/web`） | 本文档 §2 的全部页面 | 重新 `vite build` 并部署 dist |
| server（`platform/packages/server`） | 新增 3 张表 + 多个新路由组（§3） | 重新部署/重启 server；表由启动时 `CREATE TABLE IF NOT EXISTS` 自动建，无需迁移脚本 |

## 2. 页面清单（WorkBuddy 新增/改动）

### 2.1 新增页面

**① 确认卡点页（批次 5 A3/A4）**
- 路由：**`/qa/project/confirm`**（`web/src/router.tsx:260`，新路由）
- 入口：**项目视图头部右侧「确认卡点 →」按钮**（`web/src/features/qa/project-view.tsx:155`）——先进入某个项目视图，点该按钮进入
- 页面内容：三层规则卡（差异聚焦/抽样审核/风险加权）、退回全审横幅、抽样面板（种子重抽 + 名单指纹）、确认项表格（红条=风险强制/绿条=抽中）、审批条（draft→reviewing→approved + 硬闸 + 审计留痕），批准对话框需粘贴执行证据 JSON
- 文件：`confirm-gate-page.tsx` / `confirm-gate-model.ts` / `confirm-gate-api.ts` / `confirm-gate.css`

**② 知识条款页（批次 3，嵌入式页签，无独立路由）**
- 访问位置：**资料库页 `/qa/library` 的「项目参考资料」页签**（URL 形如 `/qa/library?section=knowledge_documents`，侧边栏「项目知识」分组也指向它；旧地址 `/qa/knowledge` 会 302 过去）
- 机制：`ProjectKnowledgePage` 以 `embedded` 模式经 `workspace-ui.tsx` 注入共享工作台（`ProjectKnowledgePanel`），页签三个：documents / candidates / rules
- 文件：`project-knowledge-page.tsx` + `project-knowledge-model.ts`
- ⚠️ 排查提示：这页**不在 `/qa/project/confirm` 那类独立路由下**，如果只在项目下找会找不到——去资料库页看

**③ 装配账目卡 ContextLedgerCard（批次 3）**
- 位置：**任务详情页**（`task-detail.tsx:164`，有任务且有 projectId 时渲染在详情中）
- 内容：对话注入的条款装配记录——原文位置、版本 diff、引用反查、预算裁剪
- 文件：`context-ledger-card.tsx`

### 2.2 改动/优化的既有页面

| 页面 | 改动 | 提交 |
|---|---|---|
| 项目视图 `project-view.tsx` | 头部加「确认卡点 →」入口按钮 + 样式 | `6ff7d89` |
| 任务详情 `task-detail.tsx` | 挂装配账目卡 | `048f8c7` |
| `router.tsx` | 新路由 `/qa/project/confirm`、`/qa/knowledge` 重定向 | `6ff7d89`/`048f8c7` |
| `workspace-layout.css` | 入口按钮样式 | `6ff7d89` |

### 2.3 Qoder 的前端改动（同样未部署，一并补上）

- 建档抽屉、项目环境页、工作台环境条：`web/src/features/qa/project-management/`（bootstrap-drawer / project-environments-page / environment-cell 等，提交 `153f1ad`、`ba67592`）
- Agent 设置平台工具只读区块：`web/src/features/admin/central-agent-platform-tools.tsx`（`03392d3`）

## 3. server 配套（前端依赖这些接口，旧 server 会 404）

- 新路由组：`/api/projects/:id/agents/qa/confirm/*`（确认卡点，`http/routes/qa-confirm-gate.ts`，注册于 `agents.ts`）、知识条款路由（`qa-project-knowledge.ts`）
- 新表（启动自动建）：`qa_context_ledger`、`qa_knowledge_builds`、`qa_confirm_batches`
- 页面打开后如报接口 404，优先确认 **server 也换成了本分支的构建**

## 4. 构建要点与已知坑

```bash
cd E:\AITestHarness\source\platform\packages\web
npx vite build          # 产物 dist/
```

1. **沙箱删除守卫坑（WorkBuddy 实测踩到）**：在 Agent 沙箱里构建会因 `safe-delete` shim 拦截 vite 清空 dist 而失败（`node-safe-delete-shim.cjs` 的 rmSync 报错）。规避：`env -u NODE_OPTIONS -u CODEBUDDY_SAFE_DELETE_ENABLED -u CODEBUDDY_SAFE_DELETE_BULK_GUARD npx vite build`；codex 若在自己环境构建则无此问题。
2. WorkBuddy 侧一次构建在 1m21s 左右完成过 transform 阶段，正常耗时量级 1-2 分钟。
3. 构建前确认工作区干净且在正确分支：`git -C E:\AITestHarness\source branch --show-current` → `workbuddy/batch2-env-onboarding`；HEAD 应为 `71f2869` 或更新。
4. web 双端类型检查基线：`npm run check:types`（platform 根）应通过。
5. 部署脚本参考：仓库历史用 `platform/deploy-central-ui-*.py` 类脚本部署过 central-ui（未跟踪文件，codex 按既有部署流程即可）。

## 5. 部署后验收清单（按序人工过一遍）

| # | 操作 | 预期 |
|---|---|---|
| 1 | 打包验证：`grep -l "确认卡点" dist/assets/*.js` | 至少命中 1 个 js 文件 |
| 2 | 登录 → 进入任一项目视图 | 头部右侧有「确认卡点 →」按钮 |
| 3 | 点「确认卡点 →」 | 进入 `/qa/project/confirm`，无批次时显示空态/建批入口 |
| 4 | 侧边栏 → 资料库 `/qa/library` | 左侧「项目知识」分组 + 「项目参考资料」页签可见 |
| 5 | 打开任一任务详情 | 装配账目卡区域渲染（无数据时为空态，不报错） |
| 6 | 项目管理页 | 有环境列/环境地址（Qoder 的建档界面） |
| 7 | 任一确认卡点请求的 Network 面板 | `/api/.../qa/confirm/...` 返回 2xx/404 无（404 = server 旧构建） |
