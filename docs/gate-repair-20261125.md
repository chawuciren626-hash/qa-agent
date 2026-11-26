# 门禁修复：返修续接被守卫判死 + 子会话取不到字段规则（2026-11-25）

现场样本：会话 `session-2026-11-25-07-04-51-dc329d62`（run `run-2026-11-25T07-04-53-297Z`）。
两批 trace、manifest、action-audit 已逐条核对，不是从截图推断。

## 一、两个独立缺陷

| # | 现象 | 影响 |
|---|---|---|
| 1 | 用户在待确认/已确认后要求返修，明明接续了原会话，却一条动作都发不出去，最后被迫重新派发 | 子会话上下文丢失，正是用户明确不要的 |
| 2 | 测试点子会话为查 `draft_records` 字段规则连续 5 次 shell 报错，空转 77 秒 | 可复现的低效绕路，且模型没有任何合法替代路径 |

## 二、修复项

### 1. 返修窗口被守卫判死（P0）

**证据**

- `scripts/analysis-revision.mjs:66` 在用户选择返修时把阶段写成 `status: 'revision_requested'`。
- `scripts/child-tool-guard.mjs` 的判据是 `status !== 'in_progress'` → 抛 `Active professional dispatch required`。
- 现场 07:29:05 `confirmation_resolved(decision=revision_requested)` → 07:31:25 父会话用 `input_subagent`
  续接旧子会话 → 07:31:47 起 11 次被拒，请求名从 `-v9` 加到 `-v19`，07:41 才重新派发。

**修复**

放行 `in_progress` 与 `revision_requested`（后者就是用户已请求返修的窗口）。
`awaiting_confirmation` 与 `completed` 仍然拒绝，但文案直接给出出路（等用户确认 / 让控制器登记 revision），
不再让模型去"改写请求"——那是唯一注定失败的动作。

**边界**：`completed` 一律拒。返修完成后 `revision_id` 仍在阶段上，不能用它的存在当放行依据。

### 2. 句柄解析漏掉 QA 的后台标记（P0）

**证据**

- 引擎 `platform/packages/core/src/environment/tools/run-subagent.ts:251` 在 QA 子任务跨调用继续时返回
  `[QA subagent continuing in background with subagent_id subagent-xxx; ...]`。
- `scripts/stage-evidence.mjs` 的正则只认 `subagent retained|running( in background)?`，且用 `(?:^|\n)` 锚定行首。
- 现场 07:29:27 `resolve_child_handle` 返回 `status: returned / subagent_id: null`，
  控制器据此判断"句柄不可用"，改走 `revise_stage` 重新派发。

两处都不匹配：文案不同（continuing ≠ retained/running），位置也不同（标记拼在子会话正文同一行末尾）。

**修复**

正则接受 `QA subagent continuing in background` 形式，并去掉行首锚定；出现多个句柄时仍返回 `null`（不猜）。

### 3. catalog 的按动作过滤被命令契约堵死（P1）

**证据**

- `scripts/project-action.mjs:12` 本来就实现 `parseOptions(args, ['controller-session','action','stage'])`。
- `scripts/command-contracts.mjs` 的 `parseActionInvocation` 只允许 `--controller-session`，
  hook 在执行前就把 `catalog --action=...` 判为非法选项。
- 裸 `catalog` 输出 59,016 字节，超过工具输出上限被截断；截断后的部分不含 `field_rules`
  （`'field_rules' in output === false`）。
- 而派发提示词自己写着"完整字段见 `catalog.field_rules.draft_records`"——指了路却没有入口。

**修复**

`catalog`/`help` 允许 `--action=`、`--stage=`（`summary` 与 `execute` 的允许项不变）。

效果：`catalog --action=draft_records` 输出 1,214 字节，不再截断。

### 4. 拒绝文案改成角色感知（P1）

原固定文案对**所有**阶段都写 `diagnose_test_cases`，对 `test_points` 角色是错的（应为 `diagnose_test_points`）；
又让模型"用 read_file 检查"，但 read_file 不能列目录。

修复：

- 按 stage 选择 diagnose 动作：analysis → `diagnose_analysis`，test_points → `diagnose_test_points`，
  test_cases → `diagnose_test_cases`，其余 → `diagnose_task`。
- 明确写出"没有 shell 管道、ls/grep/find、辅助脚本"。
- 给出正确查询方式：`node scripts/project-action.mjs catalog --action=<name>`，并说明 catalog 是 CLI 子命令、
  不能放进 `qa_request`。
- 状态级拦截不再追加 `Correct the structured request without user unlock`（对这类拦截是误导）。

### 5. run_status 补产物清单（P1）

`ls -R` 被拒后没有合法替代，`run_status` 原先只给阶段状态。
现在返回 `artifacts`（manifest 登记的产物相对路径），供子会话确认"产物结构"。

### 6. 调用图里子会话身份丢失（P2）

**证据**

- `bindSubagent` 只绑"尚未完成"的 `run_subagent` 卡片（`!item.outputComplete`）；
  QA 后台派发的卡片立刻完成 → 绑不上 → 追加 standalone 项。
- standalone 项 `agentId: null, description: null` → 节点标题退化成会话 id 尾号，第二行（派发时写的"做什么"）为空。
- `moveToSpawningCard` 第一行 `if (!from) return;`：standalone 永远不参与重绑。

**修复**

- `moveToSpawningCard` 允许从 standalone 项迁移到真实卡片；卡片原有子会话被挤出时保留为独立节点，不丢。
- `labelFor` 接 `localizedAgent`：`test_point_agent` 显示为「测试点智能体」而不是英文 id。

## 三、验证

| 套件 | 结果 |
|---|---|
| `structured-actions.test.mjs` | 85 / 85 |
| `stage-evidence.test.mjs` | 39 / 39（含新增后台标记用例） |
| `child-tool-guard.test.mjs` | 9 / 9（含新增返修窗口用例） |
| `run-status-summary.test.mjs` | 9 / 9 |
| `child-history-recovery.test.mjs` | 8 / 8 |
| `delegation-stopped.test.mjs` | 8 / 8 |
| web `tsc --noEmit` | 改动的 2 个文件零错误（基线仍有 `@prismshadow/penguin-server/model-catalog` 缺声明，与本次无关） |

本机沙箱跑上述套件需 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=1000000` 且独占串行，否则防批量删除会伪报失败。

## 四、部署注意

1. **引擎**：同步 `scripts/` 下 6 个改动文件。没有新增文件，`config/release-resources.json` 无需改动。
2. **Web**：改了 `subagents-view.tsx` 与 `stream-model.ts`，**必须重新构建 web**，否则调用图仍是旧行为。
3. 部署后验收（单测通过不能替代）：
   - 取一个 `revision_requested` 的 run，续接原子会话发一条修订，确认动作能执行、不再报
     `Active professional dispatch required`；
   - `resolve_child_handle` 对 QA 后台派发的子会话返回真实 `subagent_id`；
   - 在子会话里执行 `catalog --action=draft_records`，确认返回字段规则且不截断。

## 五、本次未做（不影响上面两条主线）

- `preview_revision` 只回 `ineligible`，不指出出口；
- `apply_analysis_feedback` 的 `exit 2` 被控制器误读为成功；
- `qa-delegation-guard` 的拒绝文案不含"正确值是什么"。

## 六、第二批核对：同一会话跑到测试用例阶段（截至 08:50，未部署）

前提：安装副本仍是 `4df9a53`，第一节 1–6 项一条都没生效。本节只记**部署之后仍然会发生**的问题，
不重复已修项。现场仍为 `session-2026-11-25-07-04-51-dc329d62`。

### 1. 完成闸门被一条"根本没跑起来"的命令行永久卡死（P0）

| 事实 | 值 |
|---|---|
| 毒化行 | `test_case_agent/…_002.jsonl` 08:22:08，`exec_command`，`status=fatal`，输出 `Error: ENOENT … lstat '…\d1fd3016-fix2a.json'` |
| 成因 | 08:21:57 子会话先 `execute --request=…fix2a.json`，请求文件 08:22:29 才由 `write_file` 创建 |
| 后果 | `child-command-policy.mjs` 对该行 `JSON.parse` 失败 → `Child runner response unreadable`；08:39:04 / 08:44:48 / 08:46:50 `handoff`、08:45:07 / 08:47:12 `complete` 全被拒；`qa-delegation-guard` 08:49:53 同样拒 |
| 范围 | 全部子 trace 只有这 1 条 fatal；其余 30 余条 `aborted` 都是 hook 拒绝，已被正确跳过 |

产物本身没问题：`design/test_cases.json` + `xlsx` 已生成，`validate_artifacts` 在 08:37:52 / 08:44:08
两次 passed。卡的是**阶段登记**，不是交付物。

修法：`status=fatal` 且只有一行 `Error: ENOENT/NOTDIR … lstat …`（没有堆栈、没有回执）说明进程没起来，
不构成证据，跳过；"真跑过但失败"的（缺入口模块、`open` 失败等）仍然算失败，
真正的交付证据由后面的 `completed` 回执与 `validate_artifacts` 提供。

### 2. 这条毒化行从哪来：hook 10 秒超时后放行（P0 成因）

`penguin/hooks/qa-stage-boundary/hooks.json` 写 `"timeout": 10`。08:22:07.957 该 hook
`failed: timed out after 10s`（`tool_total_ms=11015`，真正执行只用了 145ms）→ 被杀 → 内联请求文件
没写 → 命令照常执行 → 必然 ENOENT。

hook 每次工具调用都会把整份子 trace 解析**两遍**（`bindChildHookContext` 一次、`currentRunId` 一次），
测试用例子会话到后期是 3 个文件 1.6MB，10 秒余量本来就薄。

修法：`timeout` 提到 60；闸门不再把"没启动"的行当回执（见第 1 条）；hook 侧复用同一份解析结果。

> 补记：`project-action.mjs` 本来就把缺失请求文件转成 `Request JSON file does not exist …` 的
> 明确回执（已有用例覆盖），那条裸 `ENOENT … lstat` 不是它打的——命令没走到 CLI 的读取分支。
> 所以本条只修"超时太容易触发"和"闸门误读这种行"，不假设 CLI 需要改造。

### 3. 恢复台账的键不归一（P1，跳过第 1 条后紧接着会撞上）

- 被拒的 `diagnose_test_cases` 请求带了 `stage`，回执 `task_key = run-…:diagnose_test_cases:test_cases`；
  成功的同名请求不带 `stage`，`task_key = run-…:diagnose_test_cases:`。
- 守卫 `pending.delete(result.task_key)` 精确匹配 → `:test_cases` 这条永远清不掉。
- 实测：`_003` 里该键被 `pending.add`，之后 `diagnose` 成功两次、`validate` 通过两次，仍未清除。

修法：不改计数规则，改"什么算同一个键"——清账时按 `(run, action)` 比较，未写 stage 视为通配；
两个不同的具名阶段仍算不同，不会被误清。

### 4. `stalled` 实际上永远不会触发（P1）

`recovery-policy.mjs` 的签名取 `progress_sha256`，而该值包含**子会话 trace 的哈希**。
控制器每跟子会话说一句话，进度就"变了"，三次同一失败仍记成 1：

```
handoff:test_cases  failure_number=3  consecutive_same_failure=1  stalled=false   (三次 request_sha256 相同 e91a6fec)
```

所以 08:39–08:49 那 10 分钟是纯空转，最后靠模型自己写了"部分完成"收场。

修法：把"什么算进度"收紧，而不是改计数规则——`artifactProgress` 不再把子会话 transcript 计入，
`handoff`/`complete` 的请求文本也不再作为进度起点（`progressSeed`）。产物一变，计数照旧清零；
只是"再跟子会话说一遍"不再算进展。

### 5. 上一批的句柄正则只覆盖 5 种文案里的 1 种（P1，本批新发现）

同一会话里引擎实际用过 5 种：

```
[QA subagent continuing in background with subagent_id X; …]      4 次  → 新正则命中
[subagent idle with subagent_id X; send a follow-up prompt …]     2 次  → 未命中（前缀不在白名单）
[subagent still running with subagent_id X]                       1 次  → 未命中（没有分号）
```

`idle` 恰好出现在子会话交回的那一刻（08:44:36 / 08:46:29），也就是准备 handoff 的时点。
修法：改成"方括号内含 `with subagent_id subagent-…` 即视为句柄"，分号可选；多句柄仍返回 null。

### 6. 零碎往返（P2，各浪费 1 次调用）

- `diagnose_*` 的字段白名单只有 `run_id`，控制器多传 `stage` → `Unknown action field`（不说是哪个字段）。
- 内联请求复用同名文件 → `Request filename conflicts; existing content was not overwritten`（没给"换个文件名"）。
- `catalog` 命令同时带 `qa_request` → `qa_request requires one structured execute command`（没指向 CLI 子命令）。
- 子会话续跑后想 `ls output/action-requests/` 被拒，`run_status.artifacts` 不含该目录。

### 7. 本批落地的改动（分支 `fix/gate-repair-20261125` 第二次提交）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `scripts/child-command-policy.mjs` | `neverLaunched()`：`status=fatal` 且只有一行 `Error: ENOENT/NOTDIR … lstat …`（无堆栈、无回执）= 进程没起来，跳过；MODULE_NOT_FOUND、`open` 失败等"真跑过"的仍按失败处理 |
| 1b | 同上 | JSON 解析失败按状态分文案：`fatal` → `Child command failed; its terminal output is unreadable as a receipt: <原文>`；`completed` 才叫 `response unreadable` |
| 2 | `penguin/hooks/*/hooks.json` | 三个 `pre_tool_use` 超时 10 → 60 |
| 3 | `scripts/child-command-policy.mjs` | `clearsPendingKey()`：按 `(run, action)` 比较，未写 stage 视为通配；两个不同 stage 仍算不同 |
| 4 | `scripts/structured-actions.mjs` | `artifactProgress` 去掉子会话 transcript；新增并导出 `progressSeed()`，`handoff`/`complete` 不以请求文本计进度 |
| 5 | `scripts/stage-evidence.mjs` | 句柄匹配改为"方括号内含 `with subagent_id subagent-…`"，分号可选，多句柄仍返回 null |
| 6 | `scripts/structured-actions.mjs` | `diagnose_*` 接受 `stage`（须等于自身阶段）；`Unknown action field` 报出字段名与允许列表 |
| 7 | `scripts/inline-action-request.mjs` | catalog/help/summary 带 `qa_request` 时明确指出"CLI 子命令、去掉 qa_request"；同名请求冲突给出"换个文件名" |
| 8 | `scripts/show-run-status.mjs` | `run_status` 增 `action_requests`（仅文件名） |

验证：`stage-evidence` 42/42（含 5 条新增：未启动行、键归一、`still running`/`idle` 句柄、截断回执可还原）、
`efficiency-contracts` 9/9（新增 catalog 文案）、`structured-actions` 全量见提交说明。

部署注意补充：hooks.json 会由 `scripts/sync-penguin-agents.mjs` 复制进每个 Agent 的
`agent_state/hooks/`，只替换引擎目录不会改变已安装 Agent 的超时值，需要跑一次 `--apply` 同步
（或重装）。

### 8. 一条"看起来会卡"但实际不会的现象：截断回执

现场 trace 里大量 `status=completed` 的 `exec_command` 输出长度恰为 16362，尾部形如

```
"]\n}\n\n[output archived: …/scratchpad/session-…/truncated-tool-output/exec_command-<hash>.log]"
```

即内联结果被 16000 字符上限切成"头尾窗口 + 计数标记"，JSON 在中途断开。**这不需要改门禁**：
`readSession()`（`scripts/stage-evidence.mjs`，自 `eb633c4` 起）在读 trace 时就把
`[output archived: <path>]` 展开成归档文件里的完整 stdout，并校验归档必须落在本子会话
`scratchpad/<childId>/truncated-tool-output/` 下、文件名形如 `<tool>-<hash>.log`、未被重定向、
不超过 8 MiB；任何一条不满足都抛错（fail-closed）。

用现场真实 trace 复核：`test_case_agent` 881 行，8 条归档输出全部还原成功，
`assertChildCommands` 在 `stage=test_cases` 下通过。上一轮"仍被拒"的判断来自探针脚本绕过了
`readSession`、直接解析原始 jsonl，属于误判。本批只补了一条回归用例，锁住现场这个真实形态
（头尾窗口 + `[output truncated: kept first …]` + 归档）不被后续改动破坏。

## 七、第三批（2026-11-26）：派发被通道 500 打断后不能永久占位

现场（`session-2026-11-25-07-04-51-dc329d62`，09:04 用户补充"万能验证码 1688"之后）：

```
01:05:51 dispatch  analysis（登记成功，dispatch_id 50f33288，stage → in_progress）
01:06:17 run_subagent → [run_subagent error: 执行通道 500: internal]   status=fatal
01:06:29 run_subagent 重试 → 拒绝：This dispatch already has a child call …      status=aborted
01:07:10 resolve_child  → rejected：No unique returned child for this dispatch
01:07:55 第三次 run_subagent → 同一句拒绝
01:08:28 resolve_child_handle → [interrupted: tool aborted by user]
```

`delegation-guard.mjs` 的 `prior` 判据把"调用过 `run_subagent`"等同于"已经有了子调用"，
但这次调用根本没到子会话——执行通道在会话创建前就 500 了，父会话里既没有 `subagent`
也没有 `session_meta`。结果：派发登记在，子会话不存在，重试被守卫拒，控制器只能在
`run_subagent` 与 `resolve_child*` 之间来回。

修法：新增导出 `launchNeverStarted(rows,index)`，只有同时满足三条才算"从未启动"——
恰好一条输出、`toolOutcome=fatal`、输出是工具自己的失败信封 `[run_subagent error: …`，
且到下一次 `run_subagent` 之间没有任何 `subagent` / origin `session_meta`。
`prior` 与 `resumeUnlaunchedDispatch` 里的同一判据都因此自动放行。
半成功的启动（子会话已登记）仍然会挡住第二次派发，防重复派生的语义没动。

现场复验（同一份派发对象）：HEAD 版 `deny`（already has a child call），修复后 `{}`。
已同步到运行副本 `installed/app/engine/scripts/delegation-guard.mjs`，备份在
`installed/app/engine/scripts/.backup-20261126-guard/`。

测试：`delegation-binding` 10/10（新增 1 条，含"已登记子会话仍拦""非失败信封不算""缺/重复输出不算"）、
`stage-recovery` 14/14。

### 另一条，同一个现场但不在门禁里

- 09:01 用户通过 test_cases 确认；09:04 补充说明触发 `apply_analysis_feedback`，引擎按
  "补充信息影响上游"把 analysis 重开、test_points/test_cases 置为 `quality_revision_required`。
  这是设计行为，不是卡死。
- 从 08:54 起 `desktop.log` 每约 1.7 秒一条
  `[executor] execution-error: 执行通道 500`（已 400+ 次），对应
  `POST /api/sessions/local-execution/events`。本机执行端推送事件失败，界面收不到新状态，
  就一直停在上一帧（截图里那句"运行中 743s"就是这么来的）。该路由里唯一会抛裸
  `Error`（→500）的是 `receiveFile` 的轨迹归属校验，其余都是 `HttpError`。
  这一条属于服务端实例，需要看 VM 里那台业务服务的日志，不是引擎脚本能修的。
- 另：20:32 那一轮 `request_end` 之后没有 `hook`、也没有 `task_end`（同一会话在 19:15 也出现过一次），
  按 trace 语义"未闭合的 task_begin = 没走到结尾"，客户端据此把该步渲染成运行中。
  属于 `platform/packages/core` 的 Session 生命周期，尚未定位到具体抛出点，单列待查。

### 附：`preview_revision` 的"不合格"不再只说一句 "not eligible"

```
{"status":"ineligible","reason":"Stage is not eligible for controller revision",
 "next_action":"report_revision_ineligible"}
```

现场控制器拿到这句后只能自己猜原因，多花了一次调用才发现要走 `apply_analysis_feedback`。
`draft-stage-revision.mjs` 现在按状态给出下一步：`awaiting_confirmation` → 先解决待确认
（新信息属于需求变更，走 `apply_analysis_feedback`）；`revision_requested` → 已有一份修订
在开，续跑那个派发；`planned` → 先派发；`skipped` → 本次计划跳过。
