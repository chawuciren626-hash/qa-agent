# 门禁续修部署说明（969b648 / 46278f4 / a54ef3d / 6729924）

给 codex：这三个提交（外加一处同批补丁）是**同一个现场的连续四处收口问题**，只动 `scripts/`，
不涉及 `platform/`，**不需要重建客户端或服务端，也不需要重启引擎进程**（引擎脚本与 hook 的
`guard.mjs` 都是每次工具调用新起进程，文件替换后下一个调用即生效）。

> 第四个提交 `6729924` 是梳理本文档时在同一条证据链上新发现的（用户中断 → 同样永久卡死），
> 与前三处同源、同样只改 `scripts/`。要不要一起上由你决定；**分开上也没问题**，但只上前三个的话，
> 现场"用户中断过一次"的会话仍然推不动。

---

## 一、部署范围

| 提交 | 时间 | 主题 |
|---|---|---|
| `969b648` | 2026-11-25 20:45 | 任一 hook 的拒绝都算"未执行"，不再被当成不可读回执 |
| `46278f4` | 2026-11-26 09:21 | 派发被通道 500 打断后可重试，不再被"已有子调用"锁死 |
| `a54ef3d` | 2026-11-26 09:23 | 修订不合格时按阶段状态给出下一步，而不是只说 "not eligible" |
| `6729924` | 2026-11-26 09:55 | 用户中断 / 进程中断的命令不再被判"输出不可读"（同批补丁） |

需要同步到 `installed/app/engine/scripts/` 的**只有 4 个文件**：

| 文件 | 改动来源 | 期望 sha256（去 CR 后取前 16 位） |
|---|---|---|
| `hook-denial.mjs` | `969b648` | `1c879b8d208af002` |
| `child-command-policy.mjs` | `969b648` + `6729924` | `5cfaa6fc3dd6519d` |
| `delegation-guard.mjs` | `46278f4` | `bea330faeb835cfb` |
| `draft-stage-revision.mjs` | `a54ef3d` | `cdd391084147f61e` |

这四个文件在工作区里是**干净**的（`git status --porcelain` 为空），内容与 `6729924` 的树一致，
差别只在行尾（工作区 CRLF、`git show` 出来是 LF）。所以哈希一律按"去掉 `\r` 再算"来比对，
不要用裸 `sha256sum` 直接对照。

**不需要动的**：

- `penguin/hooks/*/hooks.json`：这三个提交没有改它。上一批的 `timeout: 10 → 60` 已经同步到各 Agent
  （已核对 `installed/data/penguin/<acct>/agents/*/agent_state/hooks/qa-*/hooks.json` 为 `60`）。
- `platform/`：无改动，不用重打 `pnpm build`，不用重装桌面端。
- 数据库、运行中的 run：无 schema 变更。

测试文件（`tests/acceptance/*.test.mjs`）与 `docs/gate-repair-20261125.md` 只入库，不需要部署到运行副本。

---

## 二、这几处分别在修什么

### 1. `969b648` — 被 hook 拒绝的调用不再是"执行后返回了不可读输出"

现场：控制器会话里有 3 条调用被 `qa-delegation-guard` 拒绝（`status=aborted` +
`approval_decision decision=deny`），它们**从未执行**，输出是拒绝文案而不是回执。但
`child-command-policy` 只认 `qa-stage-boundary` 一个拒绝前缀，于是这 3 行被当成"命令跑完返回了
无法解析的输出"，之后每次 handoff/complete 都报 `Child runner response unreadable`，且没有任何
动作能清掉它。

改法：`hook-denial.mjs` 集中出 `HOOK_DENIALS` / `isAnyHookDenial` / `anyDenialRecorded` /
`anyDenialCorroborated`，`child-command-policy.mjs` 的两处判据改用它。

**判据没有放宽**：仍要求 `toolOutcome = aborted` + 恰好一条 `decision=deny` + 文案以某个已知前缀
开头，三者齐全才算"未执行"。模型自己打印同名前缀不足以放行。

### 2. `46278f4` — 派发被执行通道 500 打断后可以重试

现场（09:06）：

```
dispatch analysis 登记成功（dispatch_id 50f33288，stage → in_progress）
run_subagent → [run_subagent error: 执行通道 500: internal]   status=fatal
run_subagent 重试 → 拒绝：This dispatch already has a child call …      status=aborted
resolve_child   → rejected：No unique returned child for this dispatch
```

那次 `run_subagent` 根本没到子会话（通道在会话创建前就 500 了），父会话里既无 `subagent` 也无
`session_meta`，但 `delegation-guard` 把"调用过 run_subagent"当成"已经有子调用"，重试永远被拒。

改法：新增导出 `launchNeverStarted(rows, index)`，四条同时成立才算"从未启动"——
恰好一条输出、`toolOutcome = fatal`、输出是工具自己的失败信封 `[run_subagent error: …`、
到下一次 `run_subagent` 之间没有任何 `subagent` / origin `session_meta`。
`prior` 与 `resumeUnlaunchedDispatch` 里的同一判据一并放行。**半成功的启动（子会话已登记）仍然挡住
第二次派发**，防重复派生的语义没动。

### 3. `a54ef3d` — `preview_revision` 不合格时说清下一步

改前回执只有 `Stage is not eligible for controller revision` + `next_action=report_revision_ineligible`，
控制器只能自己猜，多花一次调用才想到走 `apply_analysis_feedback`。

改后按状态给话：`awaiting_confirmation` → 先解决待确认（新信息属于需求变更，走
`apply_analysis_feedback`）；`revision_requested` → 已有一份修订在开，续跑那个派发；
`planned` → 先派发；`skipped` → 本次计划跳过。行为未变，只是把已有信息写出来。

### 4. `6729924` — 用户中断的命令不再是"输出不可读"（同批补丁）

现场 09:08 用户中断了一次**已放行**的 `exec_command`，trace 里留下宿主写的占位符：

```
tool_call          exec_command … resolve_child_handle
approval_decision  allow
tool_call_output   [interrupted: tool aborted by user]     status=aborted
```

它不是回执（`TOOL_ABORTED_NOTE`，`platform/packages/core/src/environment/environment.ts:78`），
但门禁仍按"命令执行过 → 输出必须能解析"处理，于是每次 handoff/complete 都报
`Child runner response unreadable`，**没有任何动作能清掉这一行**——中断一次，这个 run 就再也
推进不了。同一类的还有 trace 回放的
`[interrupted: process exited before the tool finished]`（`core/src/trace/resume.ts:108`）。

改法：新增 `hostInterrupted(response)`，只在 `allowRecovery` 路径上、且**这两个宿主字符串 +
`status=aborted`** 三条件同时成立时跳过。命令自己打印同样的字样仍然算"没有回执"；严格路径
（`allowRecovery=false`）仍然 fail-closed。

复验同一父会话 759 行：改前 `plain` / `+unresolved` 都报 unreadable；改后 `plain` 只剩真实恢复债
（`resolve_confirmation`、`complete:test_cases` 等），`+unresolved` PASS。

---

## 三、部署步骤

> 只同步这四个文件，**不要整目录 `cp -r` 工作区**。`E:/AITestHarness/source` 里混着 codex 自己的
> 未提交改动（`penguin/ui/workspace-ui.mjs`、`platform/packages/desktop/src/*`、`platform/packages/server/*`
> 等），整目录拷会把没验证过的东西带进运行副本。这四份脚本本身是干净的，已逐个核对过。

```bash
SRC=/e/AITestHarness/source
DST=/e/AITestHarness/installed/app/engine/scripts
TIP=6729924          # 这批里最新的一个，用它取文件即为最终状态
FILES="hook-denial.mjs child-command-policy.mjs delegation-guard.mjs draft-stage-revision.mjs"

# 0) 先确认这四个文件在工作区没有被改过（输出应为空）
git -C "$SRC" status --porcelain -- scripts/$FILES

# 1) 备份现有副本
mkdir -p "$DST/.backup-20261126-batch3"
for f in $FILES; do cp -p "$DST/$f" "$DST/.backup-20261126-batch3/$f"; done

# 2) 同步：优先从工作区 cp（保留 CRLF，且内容等于提交）
for f in $FILES; do cp "$SRC/scripts/$f" "$DST/$f"; done

# 3) 校验（按去 CR 的哈希比对）
for f in $FILES; do
  a=$(git -C "$SRC" show "$TIP:scripts/$f" | tr -d '\r' | sha256sum | cut -c1-16)
  b=$(tr -d '\r' < "$DST/$f" | sha256sum | cut -c1-16)
  [ "$a" = "$b" ] && echo "$f OK $a" || echo "$f MISMATCH src=$a dst=$b"
done
```

如果第 0 步发现某个文件在工作区被改过（有人动了它），就别 cp，改成从提交取：

```bash
git -C "$SRC" show "$TIP:scripts/$f" | sed 's/$/\r/' > "$DST/$f"   # 补回 CRLF
```

**别直接用裸 `git show` 重定向**：那四份文件在仓库里存的是 LF，工作区是 CRLF（`core.autocrlf`）。
裸重定向写出去是 LF，功能上没问题，但下次有人 `git add` 会看到整文件 3500 行改动，看起来像重写。

### 部署后自检（语法/导入）

```bash
for m in hook-denial child-command-policy delegation-guard draft-stage-revision; do
  node -e "import('file:///E:/AITestHarness/installed/app/engine/scripts/$m.mjs').then(m=>console.log('$m ok', Object.keys(m).length+' exports')).catch(e=>{console.error('$m FAIL', e.message); process.exit(1)})"
done
```

---

## 四、验证

### 1. 验收测试（必须串行，带 env）

并行跑会撞沙箱的 `safe-delete state lock`，`delegation-stopped` / `preparation-recovery` 这类会以
`create_run` 失败的形式假红。

```bash
cd /e/AITestHarness/source
export CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=1000000

node --test tests/acceptance/child-history-recovery.test.mjs \
           tests/acceptance/child-tool-guard.test.mjs \
           tests/acceptance/stage-evidence.test.mjs
# 期望：全部通过。实测 child-history-recovery 10/10、child-tool-guard + stage-evidence 合计 51/51
# 新增覆盖：delegation 拒绝不算回执、用户中断不算回执、打印同名字样仍要回执、严格路径仍拒绝

node --test tests/acceptance/delegation-binding.test.mjs     # 期望 10/10
node --test tests/acceptance/stage-recovery.test.mjs         # 期望 14/14
```

`structured-actions`（87 条）本批没有改，只有改了 `structured-actions.mjs` / `draft-stage-revision.mjs`
的行为才需要跑；`a54ef3d` 只改了文案，跑命中的一条即可：

```bash
node --test --test-name-pattern="revision preview is read-only" tests/acceptance/structured-actions.test.mjs
```

### 2. 现场复验（可选，跑真实 trace）

用当前这个 run 的父会话直接过门禁，确认"unreadable"不再出现：

```bash
node --input-type=module -e "
const base='file:///E:/AITestHarness/installed/app/engine/scripts/';
const {readSession}=await import(base+'stage-evidence.mjs');
const {assertChildCommands}=await import(base+'child-command-policy.mjs');
const agentRoot='E:/AITestHarness/installed/data/penguin/execution-cache/fab072dee81f0c5edcbe52e46c8b74c4e6271352fa472d11a23aa1c2c749caee/test04-sync_4d9a70d2d2b05144/agents';
const rows=readSession(agentRoot,'test_agent','session-2026-11-25-07-04-51-dc329d62');
for(const [name,extra] of [['plain',{}],['+unresolved',{allowUnresolvedRecovery:true}]]){
  try{ assertChildCommands(rows,{allowRecovery:true,...extra,verifyRecovery:()=>true,verifyExternalRecovery:()=>false});
       console.log(name,'PASS',rows.length,'rows'); }
  catch(e){ console.log(name,'FAIL:',e.message.slice(0,300)); }
}
"
```

判定（部署前实测的基线，拿它对照）：

| 模式 | 部署前 | 部署后应当 |
|---|---|---|
| `plain` | `Child runner response unreadable` | 只剩真实恢复债：`Still open: …resolve_confirmation:analysis, …complete:test_cases …` |
| `+unresolved` | `Child runner response unreadable` | `PASS` |

也就是说：**只要还出现 `unreadable`，就说明这批没生效**；出现 `Still open` 是正常的——那是
控制器自己欠的两次失败动作（`resolve_child` 被 500 打进死循环时留下的），不是门禁的问题。

注意这个会话还在跑，行数会变（复验时 759 行），所以别把行数当断言。

### 3. 派发放行复验（可选）

拿现场那份派发对象 `50f33288` 再问一次守卫：改前 `deny`，改后 `{}`。需要工作区里仍有对应的
`output/action-requests/*.json` 与 `output/action-audit/`。

---

## 五、回滚

```bash
DST=/e/AITestHarness/installed/app/engine/scripts
cp -p "$DST/.backup-20261126-batch3/"*.mjs "$DST/"
```

更早的备份：`.backup-20261125-gate3/`（`hook-denial.mjs`、`child-command-policy.mjs`）、
`.backup-20261126-guard/`（`delegation-guard.mjs`、`draft-stage-revision.mjs`）。

回滚同样**不需要重启**，下一个工具调用即生效。

---

## 六、这次部署解不开的东西（别误判成部署失败）

1. **执行通道 500 不是这几个脚本的问题。** VM `Ubuntu-Agent` 上那个业务服务（`127.0.0.1:18777`
   是 VirtualBox NAT 转发）从 08:54 到 09:25 共 1070 次、每 ~1.7 秒一条通用 500，命中
   `POST /api/sessions/local-execution/events`（状态/快照回传）与 `/definition`（派发取 Agent 定义），
   而 `/poll`、`/model` 正常 —— 读的通过、写的全挂，指向服务端磁盘 / SQLite 写入失败
   （需在 VM 里 `df -h /` + `df -i /` 确认）。
   **09:25:46 之后已无新增 500，09:40:50 派发成功**（见下），说明通道已经恢复；但如果部署后又出现
   `execution-error: 执行通道 500`，先查这一层，不要回滚脚本。

2. **`child-recovery-receipts.test.mjs` 第 3 条 `stalled recovery cannot be inferred …` 是基线失败。**
   把 `child-command-policy.mjs` 换回 `HEAD` 版本同样失败（5 pass / 1 fail），与本批无关，未修。

3. **`delegation-stopped.test.mjs` 现在可能整体红。** 失败点是 `safe-delete state lock timeout`，
   发生在 `create_run`，与门禁无关；独占（不并行）重跑多半能过。

---

## 七、部署后的正确使用方式

1. **这个 run 已经验证过修复生效了**：09:40:42 控制器第二次调 `run_subagent`，这次没有被守卫拒，
   09:40:50 起了子会话 `subagent-2956bef3`（`requirement_analysis_agent`，需求分析修订）。
   也就是说 `46278f4` 的判据在真实流量上放行正确，且没有放过"已登记子会话"的重复派生。
2. 当前 run 状态：`analysis = in_progress`（子会话在跑修订）、`test_points` / `test_cases =
   revision_requested`（早上补充"万能验证码 1688"触发 `apply_analysis_feedback` 后置脏）。
   analysis 交付后，test_points / test_cases 要按顺序重走。
3. 09:50 用户发了 `[user_steering] 先等等`，控制器已暂停推进并说明子会话仍在后台跑。要接着做时
   直接让它继续，不要重新派发——重派发会丢上下文，也会撞上"已有子调用"的守卫。
4. 如果再出现 `Child runner response unreadable`，说明这批没生效（或只上了前三个、会话里存在
   用户中断的行），按第五节的现场复验定位。

