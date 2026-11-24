# Codex 部署交接：门禁续接绑定修复（2026-11-24）

> 交接人：本地 Agent。部署执行：Codex。原则沿用 `docs/local-build-merge-deploy-runbook-2026-11-21.md`（暂停 → 备份 → 换件 → 重签 → 自校验 → 失败回滚），禁止直拷。

## 0. 一句话

引擎门禁 `findParentDispatch` 里「保留句柄标记」的正则锚定在字符串开头，导致**子任务先输出正文、再追加保留标记**的中断回执无法绑定续接链，`handoff` / `complete` 永久报 `No unique returned child for this dispatch`。已修复并提交 `cca8270`，部署后这一个 run 只需重试一次 handoff 即可收口。

## 1. 提交与改动

| 项 | 内容 |
| --- | --- |
| 提交 | `cca8270` fix(engine): 保留句柄标记在子任务正文之后时也能绑定续接回执，修复 handoff 永久卡死 |
| 文件 | `scripts/stage-evidence.mjs`（**1 行**）、`tests/acceptance/stage-evidence.test.mjs`（新增 1 例） |
| 变更 | `const retained=/^\[subagent retained …` → `/(?:^|\n)\[subagent retained …` |

只改引擎脚本，**不涉及** core 引擎源码、web 构建、数据库迁移。

## 2. 根因与现场证据

现场：`E:\AITestHarness\installed\workspaces\test03-proj_527a832c\2026-11-24-13-42-09-96c026c8`

1. `05:43:02` 父会话 `run_subagent` 派发 `requirement_analysis_agent`（dispatch `36f001c7-…`）；
2. `05:43:49` 任务被停止（trace 出现 `abort` + `task_end`），子任务已流式输出部分正文，回执 `status=aborted`，尾部追加：
   `[subagent retained with subagent_id subagent-2cc46870; parent stopped; …]`
3. 父会话按保留句柄用 `input_subagent` 续接 → `05:53:43` 子任务完成并交付产物；`validate_artifacts` 已 `passed`；
4. 此后 `handoff` ×3、`complete` ×1 全部被拒（`No unique returned child for this dispatch`），`recovery.stalled=true`、`failure_number=3`。

原因：该正则用 `^` 锚定**字符串开头**，而真实回执是「子任务正文 + 换行 + 标记」，匹配失败 → 门禁看不到续接链，只看到那次 aborted 的 `run_subagent`，于是判定无唯一返回子任务。注意 `recordedChildHandle`（`resolve_child_handle` 用）本来就用 `(?:^|\n)`，所以句柄能查到、但 handoff 走不通，表现极像"门禁自相矛盾"。

## 3. 验证（均已执行）

- 真实 trace 复放：修复前 `findParentDispatch` 返回 `null`；修复后返回 `call_0fcc37889bbc4f7bbe8c1d4d`（`unique_active_call_subagent_event`）。
- 只读全链路预检：`resolveDispatchedChild` 绑定成功；`inspectStageHandoff(...)` 通过（生成 completed 事件与 confirm 请求命令，未落盘）。
- 回归：`tests/acceptance/stage-evidence.test.mjs` **37/37**；`stage-evidence + 全部 *handoff* 测试` **73/73**。

## 4. 部署步骤

```bash
# 1) 暂停后台服务（与常规部署同一前置）
node scripts/local-service.mjs status  E:/AITestHarness/installed/installation.json

# 2) 同步引擎文件（会自动备份、换件、重签清单、自校验，失败回滚）
node scripts/deploy-engine-files.mjs E:/AITestHarness/installed

# 3) 校验安装副本已吃到修复
grep -n "subagent retained with subagent_id" E:/AITestHarness/installed/app/engine/scripts/stage-evidence.mjs
# 期望：出现 /(?:^|\n)\[subagent retained with subagent_id …

# 4) 恢复服务
```

> 本批不含 `platform/packages/core` 改动，无需重跑 core 构建。但本地 main 上仍压着此前未推送的 core 引擎提交，**若与那些提交一起部署，必须重新 build `platform/packages/core`**（`core/dist` 不入库）。

## 5. 卡住的那个 run 怎么收口

不需要重跑子任务、不需要重新派发、不需要改产物：

1. 在客户端打开该会话（`session-2026-11-24-13-42-09-96c026c8`），让总控对 `analysis` 重试 `handoff`（artifacts：`analysis/requirement_analysis.md`、`analysis/requirement-ledger.json`）；
2. 若总控以 `stalled` 为由拒绝，明确告知：**引擎门禁已修复，这是同一条已被验证的纠错路径，不改变派发与产物，请重试 handoff**；
3. 验收判据：`handoff` 返回 `status=completed`；`run_status` 里 `analysis` 变 `completed`，其余五个阶段仍为 `planned`，`consistency=consistent`。

## 6. 已知副作用与遗留

- 本修复只让「标记在正文之后」可被识别；`^` 与 `(?:^|\n)` 两种历史写法都继续支持（原有测试仍绿）。
- 同一会话里 05:51–05:52 曾有两次 `run_stage_tool` 被拒（`payload` 传成 JSON 字符串、`payload` 与 `source_path` 同传），模型已自行纠正，属一次性格式错，不是卡死原因；若后续高频复现，再考虑在 catalog note 里加强提示。
