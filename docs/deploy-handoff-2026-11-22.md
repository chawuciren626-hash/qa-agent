# Codex 部署交接文档（2026-11-22）

## 概要

ZCode 在本地 main 上提交了 32 个 commit（`0d7506f` → `ef3c059`），涵盖 B1-B8 重构批次全部可安全落地项。已尝试三轮部署（a4b6f40 / de33cc5 / 2c5895f），其中 a4b6f40 通过了用户真实验收。后续因测试助手/资料页修复产生了新的提交需要部署，但遇到安装副本 checksum mismatch 问题（详见下文），交由 Codex 处理。

## 目标提交

`ef3c059` — 本地 main HEAD。所有 ZCode 的改动都已提交到这个点。

**注意**：工作树里有 Codex / 用户的未提交改动（account-client.ts、admin-system-store.ts、models.ts、user-models.ts、project-config-service.ts、project-service.ts、test-tracks.mjs 等），**不要混入部署**。使用隔离 worktree 在 `ef3c059` 上构建。

## 构建与部署步骤

按 `docs/local-build-merge-deploy-runbook-2026-11-21.md` 标准流程执行：

1. `git worktree add <隔离目录> ef3c059`
2. 对 packages/server / desktop / web 建 node_modules junction 到主仓
3. server 测试（AITEST_ENGINE_ROOT=隔离目录）→ tsup → desktop tsup+assets → web tsc+vite
4. `local-service.mjs pause` → `deploy-engine-files.mjs` → `deploy-project-management-local.mjs` → `sync-penguin-agents.mjs --apply`（逐账号根）→ `migrate-db.js` → `resume`

## 本轮新增迁移（需 migrate-db）

| 迁移 | 内容 |
| --- | --- |
| `2026-11-21-task-attachments` | qa_task_attachments 表（已应用过则跳过） |
| `2026-11-21-end-dimensions` | end_type/ends_json 列（已应用过则跳过） |
| `2026-11-22-change-source` | change_source 列（已应用过则跳过） |

## ⚠️ 安装副本当前状态

上一轮部署后 ZCode 直补了 `penguin/ui/workspace-ui.mjs`（未走部署脚本），导致 **source runtime checksum mismatch**——客户端启动时报错"应用未能启动"。Supervisor 日志在 `D:/AITestHarness/data/qa/local-service/supervisor.log`。

**修复方式**：正常执行 deploy-engine-files.mjs 会重发 workspace-ui.mjs 并更新 manifest 哈希，checksum mismatch 自然解决。如果 supervisor 进程在崩溃循环中无法 pause，终止 watchdog 进程后按上述步骤部署（服务本身就是崩的，不存在"强制停止运行中任务"的风险）。

## 变更清单（按功能分）

### B1 编排与导航层
- 导航扁平化：七项全局菜单（workspace-ui.mjs + sidebar.tsx）
- 登记前移：qa_runs 在开始测试时预登记 planned 行，run_id 随开工指令下发
- 端维度：环境 end_type 列、任务涉及端 ends_json 列
- 弹窗仅显式关闭（9 处）

### B2 出厂校验
- stage_finalize 合并调用：一次 exec 跑分析阶段全部确定性工具 + 台账诊断
- approve 门禁拒绝带 failed 工具回执的批准

### B3 资产中心
- /qa/assets 只读投影端点
- 资料页新增「测试资产」页签
- 宿主库项目知识区新增「测试资产」入口

### B4 探索管线
- env_explorer_agent 注册（agents.json + AGENTS.md + skill）
- 探索成功自动派生 ui_locator_bundle 候选资产
- ⚠️ env_explorer_agent/AGENTS.md 需在 release-resources.json 白名单（已加，commit d5d7f29）

### B5 执行架构
- 运行列表按通道（类型×环境）分组
- 池容量可配置（config/pool-capacity.json）
- B8-4 复测入口 UI

### B7 变更分析通道
- change_source 列 + 创建/编辑/简报/提示词注入 + .diff/.patch 附件

### B8 缺陷闭环
- 缺陷生命周期服务端桥接（POST .../defects/:id/lifecycle）
- 缺陷详情确认/标记已修复按钮
- 复测轮次路由（POST .../runs/:runId/retest）+ 抽屉入口按钮

### 测试助手
- default_agent AGENTS.md 扩写（三重身份 + 单阶段承接）
- workspace-ui.mjs 测试助手按钮显式落 default_agent
- 项目资料侧栏重构（隐藏旧导航，项目知识区为主体）

### 测试助手修复
- B3 验收修正：宿主库项目知识区测试资产入口
- 项目资料侧栏重构

### 部署事故修复
- schema.ts 回填对象补 IF NOT EXISTS（425c011）
- env_explorer_agent AGENTS.md 入 release-resources（d5d7f29）

### 债务清理
- fresh 库补齐 U2/U3 层 21 表 + 22 索引（888aaed）
- 18 张表建表文本对齐（4121319）
- web 设计规则 deslop 1/2/3/6/12/13 清零（08ee579）
- required-mark 改 RequiredMark 组件（0fae1dd）
- 债务清单入册（41f92fe + docs/web-design-debt-2026-11-22.md）

## 设计门遗留项（§18 有续作指引，暂不做）

1. B6 MCP 收口封装
2. B5 脚本资产化 lifecycle
3. B7 MR API diff 拉取
4. B8 复测范围装配 UI
5. 迁移链表文本级对齐（12 条基线失败，本次已改善但未完全清零）
6. web 设计规则残留（icon-registry/menu-style/control-size 等）

## 提示词与 Skill 变更

- `test_agent/AGENTS.md`：132→60 行队长三栏杆版
- `default_agent/AGENTS.md`：7→40 行测试助手
- `env_explorer_agent/AGENTS.md`：新建
- `skills/requirement-analysis/SKILL.md`：工具协议改合并收口
- `skills/system-map-exploration/SKILL.md`：新建
- `scripts/structured-actions.mjs`：stage_finalize 动作 + schema
- `config/release-resources.json`：新增 system-map-exploration/SKILL.md + env_explorer_agent/AGENTS.md
- `penguin/ui/workspace-ui.mjs`：菜单扁平化/侧栏重构/测试助手落 default_agent

## 数据兼容

- 新增表/列全部向后兼容（ensureColumn / CREATE IF NOT EXISTS）
- 存量 run 的 qa_runs 无需迁移（planned 是新增状态，旧数据不受影响）
- 项目创建会自动 provision 全部 12 个 agent（含新 env_explorer_agent）
