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
