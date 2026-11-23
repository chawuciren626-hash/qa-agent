# 部署后未生效的两处问题修复（2026-11-23）

本地部署后发现两处昨天改造"提交但未生效"，根因都是**改了上层、底层没跟上**。本次按源码修复，仅提交未部署。

## 1. 测试助手发起会话仍落在 test_agent

**现象**：用户端「测试助手」新建会话，承载 agent 是 `test_agent`，而不是后台发布的通用智能体 `default_agent`。

**根因**：
- 侧栏按钮入口 `penguin/ui/workspace-ui.mjs:524-528` 在 `0949cca` 已改成 `default_agent`，这一处是对的；
- 但平台 web 端两个**新建会话兜底**仍把 `test_agent` 排在前面：
  - `features/chat/new-chat.ts` 的 `newChatAgentId()`；
  - `state/project.tsx` 的 `agentOf()`。
- 昨天的 `3b1c0b4`/`16359c1` 只改了提示词，没碰这两个兜底。

**改动**：
- `new-chat.ts`：`newChatAgentId()` 去掉 `test_agent` 优先分支，统一走 `pickDefaultAgent()`（built-in `default_agent` 优先）。
- `project.tsx`：`agentOf()` 去掉 `test_agent` 兜底，只保留 `default_agent` → 第一个。
- 测试：`new-chat.test.ts`、`current-agent.test.ts` 更新断言，测试项目里也断言回落到 `default_agent`。

## 2. 返修/用户补充时重新派发，而不是在原会话续接

**现象**：阶段 agent（如需求分析）没达标要返修、或用户确认结果时有补充，总控重新 `run_subagent` 派一个新会话，从零开始。

**根因链条**（三处叠加）：
- 提示词层 `AGENTS.md:18`（昨天 `3b1c0b4` 加的）写了"问题清单原样注入回同一会话"，但只是文字，没有底层支持；
- 引擎层 `run-subagent.ts`：QA 子任务**正常完成后 `session.kill()`**，回执里没有 `subagent_id`，`input_subagent` 无从续接；
- 契约层 `structured-actions.mjs`：`revise_stage` 成功仍返回 `next_action:'dispatch'`，`apply_analysis_feedback`/`command-runtime.md` 也写"再派原角色/Redispatch"；
- 昨天的 `9ab7438`/`3e04c5e` 对这两个文件只做了 CRLF 换行规范化，**零实质改动**。

**改动**：
- 引擎 `run-subagent.ts`：QA 工作区（`.qa-session.json` + `AITEST_ENGINE_ROOT`）里正常完成的子任务也 `register` 保留，回执带
  `[subagent retained with subagent_id ...; continue this same child with input_subagent ...]`。非 QA 会话行为完全不变。
- 契约 `structured-actions.mjs`：`revise_stage` 成功后用 `resolveChildHandle()` 取句柄，返回 `continuation` 与
  `next_action:'continue_same_child'`（仅句柄确实不可用时才 `dispatch`）；`resolve_child_handle`、`resolve_child`、
  `apply_analysis_feedback`、`revise_stage` 的 note 统一为"续接优先，无句柄才重新派发"。
- 提示词 `command-runtime.md:112`、`test_agent/AGENTS.md`：明确 revise_stage 后用 resolve_child_handle + input_subagent
  把问题清单/用户补充送回同一子任务，不在新会话重派。

**关键前提**：`stage-evidence.mjs` 的 `recordedChildHandle()` 正则已能识别 `retained` 标记（不区分 completed/aborted），
所以引擎新增的"正常完成保留句柄"标记会被 `resolve_child_handle` 正确解析，无需改该函数。

## 验证

- 后端：新增 `subagent-qa-retain.test.ts`（QA 正常完成保留 + 续接同一 child），core 相关 33 例全绿；
  `stage-evidence.test.mjs` 36 例全绿（新增 QA 完成句柄断言）。
- 前端：`new-chat` / `current-agent` 13 例全绿；web `typecheck` 0 错误。
- 脚本语法检查通过；契约字段（`resolve_child_handle`/`revise_stage`/`apply_analysis_feedback` note）断言通过。
- 存量问题（与本次无关）：`core/test/environment.test.ts:1750` 的 TS 类型错误、全量测试的 spawn 超时。

## 部署提示

`platform/packages/core/dist/` 被 gitignore，部署时会从本源码重新构建。确认部署流程包含 core 的重新 build，
否则引擎层的会话保留改动不会进入运行副本。仅提交源码，未部署到任何运行目录。
