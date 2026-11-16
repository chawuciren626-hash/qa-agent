# 数据库表现状盘点与合并建议（2026-11-16）

> 数据源：`<数据根>/web.db`（SQLite，`node:sqlite` DatabaseSync 打开；结构由 `src/db/schema.ts` + `src/db/migrations/steps/*`（32 个迁移）共同形成，实例内 `schema_migrations` 已记录 32 条）。
> 快照：本实例共 **111 张表**，其中 **17 张有数据、94 张为空**（新实例）。空 ≠ 无用，判断合并以**结构语义**为准，行数只影响迁移成本。

## 一、表域分布（111 张）

| 域（前缀） | 张数 | 状态 |
|---|---|---|
| qa_*（测试业务主链 + u2/u3 执行） | 40 | 主链 13 张全空；u2/u3 10 张全空 |
| public_*（发布/角色/菜单体系） | 17 | 全空（体系未启用） |
| org_*（公司模式） | 9 | 全空 |
| exchange_*（对外任务交换） | 8 | 全空 |
| central_*（中心工具/技能） | 12 | tools 33 行、tool_agents 57 行、categories 各 10 行，其余空 |
| messaging_* / unattended_* / machines | 8 | lifecycle 42 行，其余空 |
| 基础（users/projects/sessions/auth_sessions/ui_prefs/server_settings…） | 12 | users 1、projects 1、auth_sessions 42、ui_prefs 1 |
| 其他（qa 之外：connectors、trace、plugin、agent_api…） | 5 | 全空 |

有数据的表：agents(2)、auth_sessions(42)、central_tool_agents(57)、central_tool_audit(10)、central_tool_categories(10)、central_tools(33)、central_skill_categories(10)、error_records(357)、machine(1)、model_promotions(17)、projects(1)、public_admin_audit(40)、public_agent_groups(10)、schema_migrations(32)、ui_prefs(1)、unattended_lifecycle(42)、users(1)。

## 二、建议合并（按收益/成本排序）

### A 档：结构已重复，建议合并

| # | 现状 | 建议 | 成本 |
|---|---|---|---|
| A1 | **通用事件表写了三遍**：`unattended_lifecycle(event_id,at,kind,detail_json)`、`exchange_task_events(event_id,task_id,at,actor,action,detail_json)`、`qa_u2_attempt_events(event_id,attempt_id,kind,detail_json,created_at)` | 合并为一张 `event_stream(scope, scope_id, kind, actor, at, detail_json)`，按 scope 建索引 | 低（三表全空或仅 lifecycle 有 42 行可搬） |
| A2 | `qa_defect_occurrences(occurrence_id,defect_id,project_id,session_id,run_id,case_key,evidence_refs_json,observed_at)` 与 `qa_defect_events(event_id,defect_id,project_id,sequence,action,from_status,to_status,actor_user_id,reason,evidence_refs_json,…,prev_event_hash,event_hash)` 同挂 defect、结构同构 | occurrences 并入 events，加 `kind='occurrence'\|'status_change'`；**保留 hash 链字段**（审计链语义不变） | 低（两表全空） |
| A3 | `qa_document_index(document_id,project_id,revision_id,revision,content_hash,title,content,indexed_at)` 是 `qa_documents.current_revision_id` + `qa_document_revisions.content` 的**手工冗余副本** | 删表，改为 `qa_document_revisions` 上的 FTS5 虚表/视图，索引随修订写 | 低（空表） |
| A4 | `org_sessions(session_id,project_id,org_id,agent_id,current,trigger_hop)` 与 `org_ticket_sessions(project_id,org_id,ticket_id,session_id,agent_id,trigger_hop)` 结构几乎相同 | 合并为 `org_session_links(session_id,org_id,ticket_id NULL,current,trigger_hop)` | 低（全空） |
| A5 | public_* 里 5 张**同构纯关联表**：`public_role_members`、`public_role_menus`、`public_module_grants`、`public_agent_group_assignments`、`public_plugin_category_assignments`（都是 (X_id,Y_id) 两列） | 合并为 `public_assignments(kind,left_id,right_id)` | 低（全空） |
| A6 | `org_channel_state(project_id,org_id,channel_id,date,offset_bytes)` 与 `org_channel_reads(…,user_id,last_read_id)` 频道进度与已读偏移 | 合并为 `org_channel_progress(channel_id,date,user_id NULL,offset_bytes)` | 低（全空） |

### B 档：同域切片过多，建议随建设收敛（与 Codex 批次 3/4/5 相关，动前对齐）

| # | 现状 | 建议 |
|---|---|---|
| B1 | `qa_u2_*`（execution/case/attempt_events）与 `qa_u3_*`（cancellations/checkpoints/cleanup/fault_injections/interface_coverage/process_verifications/side_effects）共 **10 张**，全部带 attempt_id + evidence_json，是同一「执行尝试」域的两期切片 | 统一命名域 `qa_execution_*`；u3 的七类检查可收敛为 `qa_execution_checks(attempt_id,case_attempt_id,check_kind,payload_json,evidence_json,…)` 一张宽表 + kind 区分，避免每加一种检查就加一张表 |
| B2 | `error_records` 与 `usage_records` 前缀列几乎一致（id,ts,date,project_id,agent_id,session_id,…,status），但专属列不同（error: source/kind/code/message；usage: provider/model_id/cache_read/cache_write/output/total） | 可合并为 `telemetry_records(kind, 公共列…, detail_json)`；若在意查询列裁剪，保留分表也可接受（**不强推**） |
| B3 | `exchange_results(result_id,task_id,outcome,summary_json,evidence_index_json,…)` 本质是一种任务事件；`exchange_outbox` 是投递队列（lease/next_attempt_at），语义独立 | results 并入 exchange_task_events（kind 区分）；**outbox 保留**（队列语义 + 独立生命周期） |

### C 档：看似重复、核实后**不能合**

| # | 表 | 结论 |
|---|---|---|
| C1 | `machine`(singleton,machine_id) vs `machines`(8列) vs `machine_project` | **不是重复**：machine=本机身份（singleton 存本机 ID）、machines=已连接远端机器清单、machine_project=项目↔机器地址映射。代码仍在读写（`src/db/repos/machines.ts`）。保留 |
| C2 | `qa_documents`/`qa_document_revisions` | 主表+修订版本树，语义必需。保留（index 见 A3） |
| C3 | `public_resources`/`public_resource_versions`/`_pins`/`_dependencies` | 资源版本树与钉版本语义，启用后不可缺。保留 |
| C4 | `qa_test_missions`/`qa_test_points`/`qa_test_cases`/`qa_design_batches` | 测试业务主链，一一对应业务实体。保留 |
| C5 | org_budget/calendar/ticket_state | 各自状态机不同，硬合会变 EAV。保留 |

## 三、执行建议

1. **时机**：94 张空表意味着 A 档六项迁移成本≈0（只有 `unattended_lifecycle` 42 行要搬）。这是最便宜的窗口——一旦 exchange/org/public 体系启用，合并就要带数据搬迁和双写。
2. **方式**：全部走 `src/db/migrations/steps/` 追加迁移（runner 已支持），同步更新 `src/db/schema.ts` 与对应 repo 的 SQL；不要直接改旧迁移。
3. **与 Codex 批次的协调**：B1 涉及批次 3/4/5 的执行域表结构，A1 横跨 unattended/exchange/qa 三域——建议把 A 档作为批次间的**独立小批次**插入（半天量级），避免和 Codex 改动同一批 repo 文件产生冲突。
4. 预期效果：A 档全部落地后 111 → **103 张**（-8）；若 B1 也收敛，可到 **95 张左右**，且后续每类执行检查/事件不再增表。

—— 本盘点由沙箱直读 `web.db` sqlite_master + 逐表 schema 生成，代码引用已用 grep 核实（machines 组）。

## 四、补充核查（2026-11-16 下午）：哪些表是「宿主遗留、当前产品用不到」？

对 111 张表做了两层交叉核对：
1. **表名 ↔ 代码引用**（排除 schema.ts 与 migrations 定义层）：110/111 张都有运行时引用——宿主给每张表都写了 repo，**没有一张纯死表**；
2. **功能入口 ↔ 产品可达性**（服务端路由注册 + Web 用户端/管理端实际调用路径）：

| 分类 | 域 | 张数 | 判定 |
|---|---|---|---|
| **整域无调用方**（路由注册了，但 Web 用户端、管理端、CLI、aitestharness-tools 全都不调） | exchange_*（任务交换，外部平台推任务集成） | 8 | **可摘除**：从 platform.ts 摘注册 + 迁移删表；若未来要做外部任务接入再按需重建 |
| 产品有入口、当前实例未启用（数据全空） | public_*（发布/角色/菜单）、org_*（公司模式）、messaging_*（IM 桥）、connectors、trace_*、agent_api、trusted_plugin、plugin_session_pins、browser_extensions、project_management | ~43 | **保留**：功能挂在产品上（公司模式、发布审批、IM 渠道、API 令牌等都有页面），启用即有数据 |
| 建设中（Codex 批次正在接） | qa_* 主链 27 张 | 27 | **保留**：批次 3/4/5 的落点 |
| 核心在用 | users/projects/sessions/auth_sessions/ui_prefs/server_settings/error_records/schedule_state/unattended_lifecycle/machine 组/central_*/model_promotions | ~18 | 保留 |

**结论修正**：「一大半用不到」在**数据层**成立（94/111 空表），但在**代码层**不成立——宿主把全部表都接了 repo，只有 `exchange_*` 一个整域是真正无调用方的遗留集成（8 张）。其余空表属于「有产品入口、未启用」或「建设中」。

**建议动作**：
1. 短期只摘 `exchange_*`（8 张 + task-exchange 路由与 OutboxDispatcher/LocalExchangeExecutor 注册），其余不动——删错表的风险远大于收益；
2. 表数量焦虑的正确解法仍是前文 A/B 档合并（111 → ~95），而不是大规模删表；
3. 如果确定 AITestHarness 永远不做「外部平台任务推送」「IM 渠道」「公司模式」，可再列一个观察名单分批摘除（messaging 2 + org 9 ≈ 11 张），但需要先在产品侧明确砍掉这些功能入口。
