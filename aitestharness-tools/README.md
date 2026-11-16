# AITestHarness 阶段工具包（交付给 codex 整合用）

各阶段确定性工具集合，对应《AITestHarness测试平台架构重构方案-v3》第 10/24 章。
**原则：工具全部零 LLM，只做结构化/校验/计算；LLM 的活由 agent 层调用这些工具完成。**

## 目录与模块地图

| 阶段 | 模块 | 内容 | 对应方案章节 |
|---|---|---|---|
| 公共层 | `common/lineage.py` | ID 生成、content_hash、血缘头构造/校验、语义指纹 | v3 §6，IR 契约公共头 |
| 公共层 | `common/semantic_diff.py` | 语义 diff：表述变更 vs 语义变更；决定是否触发下游重算 | v3 §6 血缘增量重算 |
| 公共层 | `common/capability.py` | 能力分发三档 + 版本协商（EngineVersion / negotiate / PolicySnapshot） | v3 §24 |
| 公共层 | `common/version.py` | **运行时版本戳**：`runtime_stamp()` 产 `engine_version/schema_version/capability_versions`；`CapabilityRegistry.frozen_scope()` 把"执行期禁止更新"变成机制（违规抛 `VersionFreezeError`）；`stamps_differ()` 判版本漂移；`manifest_compat()` 是能力包兼容性门（含签名必填） | v3 §24.6/§24.7 |
| 公共层 | `common/model_capability.py` | **模型能力画像**：`plan_tasks(tier)` 把五类 LLM 任务分配到 auto/assisted/manual（**任意档位都有确定性兜底**）；`detect_signals()`+`calibrate()` 按实测信号只降不升；`split_required` 标长上下文分片 | v3 §10.9 |
| 公共层 | `common/context_assembler.py` | **上下文装配器**：按 scope 切片喂模型（替代"每轮灌整份资料库"），预算裁剪高优先级优先，产出 `context_refs`（知识版本+地图 hash+装载量）写入 plan.lineage | v3 §10.10 |
| 知识层 | `knowledge/extract.py` | 资料库（md/docx）→ 结构化项目知识：条款化（段落/列表/表格）、**无原文位置即丢弃**、按 statement 去重、知识缺口检查（默认不猜中文名词）、引用反查 | v3 §10.10 |
| 知识层 | `knowledge/maps.py` | **环境事实资产**：`build_maps` 路由+控件+接口+登录 → maps IR（只有路由无控件=未建档）；`diff_maps`+`affected_cases` 地图变更→重跑/退场；`scope_coverage` 执行前报未建档；`maps_staleness` 14 天过期提示 | v3 §10.10 |
| **建档链路** | `onboard/bootstrap.py` + `onboard/cli.py` | **用户旅程第一步**：给一个地址 → maps IR + 建档报告（**全程零 LLM**）。含 bundle 硬限流抓取、`extract_routes`(支持编程式跳转)/`normalize_route`、登录与验证码探测、OpenAPI 自动发现（6 个常见路径）、危险文案扫描、编码嗅探、报告渲染、原子落盘。CLI：`python -m aitestharness_tools.onboard --url ... --project ... --out ...` | v3 §10.10 / §15.2 |
| 需求 | `requirement/parsers.py` | **Parser 三件套**（v3 §10.2）：文档解析器（md/docx，章节树+条款带原文位置）、OpenAPI 解析器（→接口清单 IR+module 标签，零 LLM）、原型解析器（Figma 导出→控件清单）；另含 Advisor 输出钩子 `check_location`（无原文位置的需求项丢弃） | v3 §10.2 |
| 需求 | `requirement/testability.py` | 可测性检查器四项：T1 无预期 / T2 无边界 / T3 缺前置 / T4 表述歧义 | v3 §10.2 |
| 需求 | `requirement/acceptance.py` | 验收标准可观察性检查（E1/E2/E3/W1）+ 需求变更影响分析 | v3 §10，断言来源链第一环 |
| 测试点 | `testpoint/matrix.py` | **矩阵三件套**（v3 §10.3）：知识库检索（控件×维度映射表，非 RAG）、维度矩阵生成器、覆盖度计算器（缺口格子才交给 Advisor 补）；+ 验证方式分配器（业务逻辑→api、呈现→ui、落库→db） | v3 §10.3/§11.6 |
| 测试点/用例 | `testpoint/coverage.py` | req→tp→case 覆盖矩阵 + **V-33 覆盖对账（M1 唯一缺的规则，本工具即实现）** | IR 用例集 V-33 |
| 用例 | `case/builder.py` | **Program 四件套**（v3 §10.4）：用例骨架生成器（断言占位必须回指测试点）、数据工厂（边界六组、固定种子可复现、数值字符串十进制、数据集 ID 与用例分离）、用例预算校验器（N+1 硬限制防铺量）、枚举清单对账器（双向 diff 找漏） | v3 §10.4 |
| 固化 | `plan/gates.py` | `extract_touched`（touched.pages/apis 自动提取，重放复用同函数）+ `compile_gates`（五闸）+ `gates_summary` | v3 §8/§13 |
| 执行 | `exec/api_engine.py` | 接口自动化最小执行引擎：DSL→HTTP→exec IR，verdict 五档、observe/decide 断言分级、N=3 一致性 | v3 §11/§12 |
| 执行 | `exec/wait_assert.py` | **§11.3 共用**：等待条件库（封闭枚举+超时上限，禁 driver 专有写法）、断言引擎（decide/observe 两级） | v3 §11.3 |
| 执行 | `exec/infra.py` | **§11.3 共用**：自愈分级判定器（L1 重试/L2 换指/L3 人工，断言失败永 L3）、凭证与环境中心（环境切换+token 刷新，禁止硬编码进计划） | v3 §11.3/§15 |
| 执行 | `exec/api_ext.py` | **§11.4 接口专有**：响应契约校验器（schema 子集）、异步结果轮询器、变量提取传递（$.a.b→ctx）、数据库断言器（sqlite 原型） | v3 §11.4 |
| 执行 | `exec/native_mini.py` | **§11.4 Web/App/小程序专有**：多指纹定位规则（白名单+降级序列）、设备串行队列（按 §11.4 建议不做池化）、弹窗策略链（App 权限弹窗/小程序宿主弹窗，未命中默认 abort 防误授权） | v3 §11.4 |
| 执行 | `exec/hybrid.py` | **§11.5/11.6**：混合 driver 四条约束校验器（主 driver/≤2 段不切回/context_flow 显式/最弱一环）、验证方式分配审计闸（接口可验证但分了 UI >30% 触发） | v3 §11.5/§11.6 |
| 执行 | `exec/pools.py` | **§11.7 调度分池**：接口/Web(CPU 核数)/设备(1)/小程序(1) 四池，混合用例进主 driver 池+辅助资源记账 | v3 §11.7 |
| 执行 | `exec/login.py` | **§12.6 登录器与验证码策略链**：零 LLM 探测（password input+相邻 input）、验证码五分类、策略链按项目成功率排序、**≤1 次重试防锁号**、会话固化（复用是终极解法） | v3 §12.6 |
| 执行 | `exec/debug.py` | **§12.10 单步调试**：断点/单步/继续/查看状态、接管会话（阻塞/断点/修正三模式） | v3 §12.7/§12.10 |
| 缺陷 | `defect/evidence.py` | **§12.5 取证包七分区**（context/visual/dom/network/console/trace/history）+ 与上次成功的 diff；**§12.7 接管状态重对齐三步** | v3 §12.5/§12.7 |
| 回归 | `regression/impact.py` | **§13.2 选集五触发源**（显式/需求变更/代码变更/片段依赖/历史相似）+ 可解释性（每条给理由） | v3 §13.2 |
| 回归 | `regression/selector.py`（追加） | 冒烟集约束（flaky 率 0 + 语义断言禁入）、三指标+准入结论合成、首次执行通过率、flaky 可疑信号 | v3 §13.3/§13.4/§14.3/§14.5 |
| 探索 | `explore/explorer.py` | **§15 探索器**：JS 路由表解析（零 LLM，快百倍）、技术栈识别、控件规则提取、硬预算护栏、危险动作白名单、探索度报告、控件→首版测试点 | v3 §15 |
| 回归/flaky | `regression/selector.py` | smoke/core/full 三闸选集、N 次样本→verdict 判定、隔离区纪律检查 | v3 §13/§14 |
| 缺陷 | `defect/tools.py` | **四件套**（v3 §10.5）：取证包组装器（入参只入 evidence 有保留期）、缺陷去重器（指纹=失败断言+目标元素+异常签名+环境键）、缺陷单渲染器（builtin/jira 模板）、**偶发 bug 识别器**（verdict 不稳定+actual 多样→上报真实偶发缺陷，勿自动修脚本） | v3 §10.5/§12.5 |
| 报告 | `report/reviewer.py` | `extract_facts`（数字只读）+ `RiskLedger`（风险台账状态机，洞察必须挂引用）+ `REVIEWER_PROMPT`（审阅者提示词包，服务端下发档） | v3 §16 |
| **资产库** | `assets/library.py` | **§9 三条资产纪律的代码承载**：`ElementLibrary`（多指纹/环境变体/**失效历史**/健康度评分，plan 只写 `element_ref` 不内联指纹→改一处全生效）、`FragmentLibrary`（契约化 inputs/outputs 强制 + 改动必升版 + 循环依赖拦截）、`DataSetStore`（数据集与用例分离 + **凭据明文一律拒**）。唯一写入口 `apply(change, actor, reason)`，**无 reason 即拒**（不允许悄悄改资产） | v3 §9 / §7.4 |
| **资产接线** | `assets/binding.py` | **§17.4 两块未接线 Skill 的接线层**：`ASSET_SKILL_BINDINGS`（哪个 agent 该调哪个资产接口，写成表不写进提示词）+ `binding_audit`（应然 vs 实调对账）+ `asset_health_report`（**空资产返回 None 而非默认值**，不拿 0 凑准入结论） | v3 §17.4 / §13.4 |
| **回归编排** | `regression/plan_regression.py` | **§13.1 三问三答**：`plan_regression`（五源 + **touched 主路** + maps_diff 自动并入 → 三档裁剪，逐条给理由、显式列未测风险与退场）、`impact_coverage`（分子分母只算可信源，无可信影响则 **available=False** 而非报 100%）、`admission_with_coverage`（**缺指标不给结论**）、`regression_three_answers`（可直接渲染进报告） | v3 §13.1~§13.5 |
| **阶段编排** | `plan/phases.py` | **§5.4/§5.5 状态机**：九阶段定义（agent/LLM 调用数/前置产物/确认点）、`check_prereq`（缺前置**拒绝执行**，空壳产物视为未产出）、`PhaseState`（start/finish/confirm，**agent 不能签确认、不能跳步**）、`invalidate`（上游变更 → 下游 stale，产物保留） | v3 §5.4/§5.5 |
| **Agent 契约** | `agent/tasks.py` | **派发单 + 收产物闭环**：`TASK_CONTRACTS`（5 类任务，白名单外直接抛）、`dispatch`（上下文按 scope 切片 + 工具白名单 + **manual 档不发起模型调用**）、`submit`（剥离越权字段并留痕 + 契约校验，缺必需字段即阻塞）、`explain_degrade`（降级必须说出来） | v3 §17.3/§10.9 |
| **知识增量** | `knowledge/incremental.py` | **§6.2/§6.3 增量重算**：`diff_knowledge`（**表述变更只更新指纹、不触发重算**）、`lineage_closure`（沿 derived_from 求闭包 + **orphan 检测**）、`incremental_plan`（重算范围 + **显式列出不动项**，证明没全量重跑） | v3 §6.2/§6.3 |
| **DOM 快照** | `exec/snapshot.py` | **§11.4 Web 可形式化部分**：`build_snapshot`（扁平 DOM 原料→结构化快照，**iframe/shadow 显式标注 frame_path**、只留必要属性、超 800 元素截断）、`diff_snapshot`（空白差异不报、语义差异必报）、`snapshot_to_controls`（桥接探索器，避免两套控件清单漂移） | v3 §11.4 |

校验器完整实现在 `aitestharness_tools/irval/`（从原型仓库整体迁入，S/M/X 三层管线、97 用例全绿），所有白名单/枚举以 `irval/enums.py` 为唯一来源（如五闸闸 2 的 matcher 表直接引用它）。

## 运行

```bash
python3 tests/smoke_tools.py     # 34 项冒烟：全链路（含本地 HTTP 实测执行引擎与建档链路）
python3 tests/smoke_round4.py    # 9 项冒烟：第四轮补建的资产库/回归编排/阶段状态机/agent 契约/知识增量/DOM 快照
# irval 校验器原验收（必须在原型仓库 /workspace/aitestharness-ir 根目录跑，suite/ 在那里）：
# cd /workspace/aitestharness-ir && PYTHONPATH=/workspace/aitestharness-tools:. python3 -m aitestharness_tools.irval suite -q
```

当前状态：**43 项冒烟全绿**（34 + 9）；irval **97/97 通过、反例拦截 62/62 = 100%、正例误杀 0**。

## 方案一致性（重要）

§10~§15 已做两轮逐条核查，结论与偏差记录在方案文档 **§11.10 方案—代码一致性核查**：
第一轮补齐 §10 清单（14 项）；第二轮发现漏建 8 项（探索器、验证码策略链、取证包七分区、接管重对齐、选集五源、准入结论、flaky 指标、单步调试）、实现偏差 6 处（等待枚举、自愈分级、定位多命中、断言分级、冒烟约束、flaky 定义），**已全部按方案修正**。

**第三轮（2026-11-14，按"工具都建了但它们接上了吗"复查）补齐 7 项、1894 行**——这七项此前不是"没设计"，而是**设计散在文档里没有代码承载，链路接不起来；去掉它，方案里某条承诺就变成空话**：

| 缺口 | 表现（不做会怎样） | 补建位置 | 依据 |
|---|---|---|---|
| 资产库三件套 | 元素指纹内联在每个 step 里，改一个按钮要改 40 条用例；片段各写一份 | `assets/library.py` | §9 |
| 两块 Skill 未接线 | `test-asset-management` / `test-selection` 定义了但没有任何 agent 调 | `assets/binding.py` | §17.4 |
| 回归三问只答一问 | 只有"选哪些"，没有影响覆盖度 → 不能说"没问题" | `regression/plan_regression.py` | §13.1 |
| 阶段可单跑但无前置校验 | 直接点执行，agent 自己编计划跑 40 分钟 | `plan/phases.py` | §5.4 |
| 权限收窄散在五章 | 编排层要自己记住"剥离+查闸+看版本"，记漏就是下一个漏洞 | `agent/tasks.py` | §17.3 |
| 资料库变更无增量 | 改一句措辞就全量重审，一个月内机制被弃用 | `knowledge/incremental.py` | §6.3 |
| DOM 快照无规则层 | iframe 里同一 css 命中两次 → 假失败（Web 自动化最大坑） | `exec/snapshot.py` | §11.4 |

结论与逐项诚实边界记录在方案文档 **§11.11 方案—代码一致性核查（第三轮）**；codex 整合时的档位判定见 `INTEGRATION.md` **第七章**（5 项 A 档 / 2 项 B 档，并说明为什么这批模块的结构性部分必须在写第一条业务代码前就位）。

## codex 整合要点

1. **依赖**：仅 `pyyaml`、`requests`（执行引擎）；无其他第三方依赖。
2. **接入点（agent 编排层 ↔ 工具）**：
   - 需求 agent 输出 requirement IR 后 → 调 `check_acceptance_observable`，error 级 Finding 必须修复才能进入人工确认卡点；
   - 需求变更事件 → 调 `change_impact`，输出 `affected[]` 作为下游 agent 重算队列（人工确认后执行）；
   - 用例设计 agent 输出后 → 调 `coverage_gaps`（V-33），缺口清单进人工确认卡点；
   - 固化编译 agent → 调 `compile_gates`，`gates_summary` verdict 为 pass 才允许 plan 入库（pending 的闸 5 由执行引擎回填）；
   - 执行引擎 → `run_plan(plan, base_url, data)` 直接产出 exec IR 正文，上层补 lineage 后交给 irval 校验入库；
   - 回归调度 → `select_regression(tier=...)`；执行完成 → **优先用 `judge_samples(execs)`**（带版本前置，返回原因码），需要裸 verdict 时才用 `verdict_of_samples`，flaky 入隔离区前跑 `quarantine_check`；
   - 报告 agent（审阅者）→ 系统提示词用 `REVIEWER_PROMPT`，facts 只准来自 `extract_facts`，风险入 `RiskLedger`。
3. **权限红线**：`make_lineage(actor=...)` 区分 human/agent；agent 不得写 program 字段（分权表在 `irval/ownership.py`），违反会被校验器 `PERM_AGENT_WROTE_PROGRAM_FIELD` 拦截——这是演示时最有说服力的护栏证据。
4. **能力分发**：策略类内容（分权表、放宽配置、审阅提示词、阈值）走服务端下发档；客户端用 `negotiate(engine_version, server_policies, builtin)` 握手，degraded 时用内置快照并在报告标注"策略非最新"。
5. **更新通道（§24.6）**：代码只走整包，只有纯数据/提示词/声明走能力包热更。能力包安装前必须过 `manifest_compat()`（区间 + 签名），**不允许为内网离线包开免校验后门**；安装用 staging → 校验 → 双目录指针原子切换，保留上一版可回滚。
6. **执行期版本冻结（§24.7）**：`run_plan` 内部已把 `CapabilityRegistry` 冻结，执行期间任何 register 都抛 `VersionFreezeError`。整合时**不要**在会话中途热加载能力包，否则第一条 exec 记录的版本就可能是错的。
7. **版本**：工具包与 IR 契约 v1 对齐；契约升级时只增不改（97 用例回归纪律同样适用于本包）。发版时 `common/version.py` 的 `ENGINE_VERSION` / `SCHEMA_VERSION` 必须与 DSL schema、IR 契约**同时**升级——三者单独升级视为非法。
8. **模型可降级（§10.9）**：LLM 能力取决于用户配置的模型，编排层**必须先调 `plan_tasks(tier)`** 再决定怎么调模型——`manual` 的任务不要强行喂给模型（会产出无法校验的垃圾），直接走 fallback + 人工；`assisted` 的任务必须把 `enum` 候选拼进提示词，禁止自由生成。降级原因要写进报告，否则用户会以为"AI 分析过了"。
9. **上下文按 scope 装配（§10.10）**：**不要**每轮把项目资料库整篇塞给模型。先 `split_clauses` + LLM 逐条抽取 → `build_knowledge` 落 `knowledge/`，环境探测 → `build_maps` 落 `maps/{env}/`，每次对话用 `assemble(scope, knowledge, maps)` 取切片，并把返回的 `context_refs` 写进 `plan.lineage`。装配前先看 `coverage`：有未建档页面就先跑建档（零 LLM，10 秒级），否则执行期会现找元素。
10. **知识与地图不许混放**：`knowledge/` 只放人写的业务真相（规则/术语/实体，带原文位置，无位置即丢弃）；`maps/` 只放探测得到的事实（页面/接口/控件/登录），会过期需重探。把"登录页有验证码"写进 knowledge 是典型错误——版本一变就永远错。
11. **建档是会话的前置动作（§10.10）**：用户「新建项目」时先跑 `bootstrap(project, env, url)`，产出 maps 与报告；**每次会话开始前检查 `maps_staleness`**，超过 14 天或检测到版本变更就重跑（零 LLM，10 秒级）。`bootstrap` 返回的 `report["next_steps"]` 可直接渲染成用户向导文案。注意：建档拿到的是路由与接口，**控件清单要等探索阶段②**，别在 UI 上承诺"已识别全部控件"。
12. **建档三处硬边界不要被改动**：bundle 抓取上限（12 文件/2MB/8MB）、编码嗅探顺序（charset 声明 → UTF-8 严格 → GB18030）、路由归一化（`/order/123` → `/order/:id`，拼接前缀单列不并入路由）。这三处都是为了"10 秒出不失真的清单"，放开任何一处都会退回上次的十几分钟。
13. **验证码判定的两个陷阱**：① 线索在 `<img src="/captcha.jpg">` 和 class（滑块常在 div 上）里，只扫可见文本会判成 `none`，导致登录器不启用策略链、会话固化失败；② 把 dom 喂给 `detect_captcha_type` 前必须剥离本模块新增的 `captcha_imgs` / `classes` 键——键名自带 `captcha`/`img`，会让通用识别函数自污染（已踩，有回归用例）。
14. **编排层怎么串（第四轮补建后的推荐接法）**：
    ```
    PhaseState()                        # 1 先建状态机，别让 agent 自己决定下一步
      .start("onboard") → bootstrap()   # 2 建档（零 LLM）
      .start("requirement") → agent.dispatch("requirement_extract") → submit(...)
      .confirm("requirement", by="human:xx")     # 确认只能人签
      ... testpoint / case / plan / execute ...
    invalidate(state, "requirement", only=[...])  # 3 需求变更 → 只作废受影响子集
    ```
    任一 `start` 返回 `prereq_failed` 时**阻塞并提示用户补前置**，不要重试、不要让 agent"想办法"。
15. **agent 一律走 `dispatch` / `submit`，不要直连模型**：`dispatch` 已包含 scope 切片、工具白名单、manual 档短路；`submit` 已包含越权剥离与字段校验。直连模型等于跳过这三道，回到"agent 说什么就是什么"。
16. **资产写入必须走 `ElementLibrary.apply(change, actor, reason)`**：无 reason 直接拒；`add` 遇已存在要拒（不许覆盖）；`retire` 只进历史不删除。资产被绕过写入，等于 §9 纪律 3 失效。

## 已知边界（诚实声明）

- `api_engine` 是**最小引擎**：json_path 仅支持 `$.a.b`，登录态/token 回写、重试、并发批次未实现（M2 范围）；
- `compile_gates` 的闸 5（replay_verified）编译期恒 pending，由执行引擎 N=3 通过后回填；
- locator 检查为静态规则，实际元素定位由 Driver Adapter 在执行期完成；
- `coverage.py` 的 `case_coverage_ratio` 是 case 级口径，与 V-33 的 error/warn 分级一起使用；
- Advisor 类工具（需求项抽取器/测试点补齐器/步骤补全器/断言生成器/归因器）**按 v3 §10 设计就不在本包**——它们是 LLM 的活，属 agent 层；本包只提供其输出的校验钩子（check_location、五闸闸 4、check_testability 等）；
- `KNOWLEDGE_MAP` 是种子映射表（18 控件类型 × 8 维度），后续走服务端下发档扩充（v3 §24）；
- docx 解析依赖 python-docx（可选安装），md/OpenAPI/Figma 原生支持；OpenAPI 只解析 JSON body 与 path/query 参数的 required；
- §11 四类 Adapter 只有 api 先行落地；web/native/miniprogram 的运行时（Playwright/Appium/宿主）按 v3 §11.9 标记为 M2，本包交付的是其编译期规则（等待枚举、定位指纹、弹窗策略链、四池调度、混合四约束）；
- AsyncPoller 为同步轮询原型；MQ 消费模式 M2 接入；
- DatabaseAsserter 仅 sqlite 原型，MySQL/PG 同接口接入（M2）；
- **`irval` 暂未把"exec 缺版本戳"列为硬错误**：97 条用例的 fixtures 还没补字段，现在加强制校验会让全部正例变红。M2 升契约（schema 1.0→1.1）时同步补 fixtures + 新增 S 层规则，届时缺版本戳直接拒绝入库。
- **建档链路只做静态抓取**：能拿到「路由 + 接口 + 登录特征 + 危险文案」，**拿不到控件清单**（需真实渲染），所以 `pages_registered` 恒为 0，报告会如实标"未建档 N 页"——这是设计上的诚实，不是缺陷。控件补探属探索阶段②（需 Playwright，M2）。
- 建档的 bundle 抓取有硬上限（12 个文件 / 单文件 2MB / 总量 8MB），超限记入 `skipped` 并在报告提示。故意不做无限抓取：上次演示"十几分钟跑不完"就是因为没有预算边界。
- 会话固化（真跑登录、存 storageState）未实现，`login.session_saved` 恒 false，待登录器接入浏览器后回填。
- **资产健康度是启发式评分，不参与 verdict**：`health_score()` 的输出只用于排序（先修差的）、告警（低于阈值提醒补指纹）和准入参考。它**不是**判定依据——一条用例失败时不会因为「元素健康度 good」而被判为环境问题。另外本库不做元素自动发现（指纹由探索器或 `exec/snapshot` 提供），也不做并发写锁（资产库假定由本地服务主进程独占读写）。
- **`binding_audit` 无流水时只给应然清单**：`covered=0` 只表示「没喂调用日志」，**不代表未接线**。要拿真实结论必须先把编排层的工具调用流水传进来。
- **`history_similar` 只选不判**：历史相似用例作为回归选集的第五来源，可以进选集，但**不计入影响覆盖度的分子与分母**。否则多召回一条就稀释一次指标，最后「覆盖率 60%」到底意味着什么都没人说得清。同时：无可信影响源时 `impact_coverage` 返回 `available=False`，此时**不许报告覆盖率**（报 100% 是最坏的做法）。
- **`maps` 产物 kind 由 `explore` 收口**：`onboard` 与 `explore` 都产出 `maps`，`KIND_TO_PHASE["maps"]` 取两者中**更强的契约**（`explore`）。所以只跑过建档、没跑探索时，`maps` 会被判定为「不满足 explore 契约」——这是故意的，防止拿半成品地图直接进入需求分析。
- **`agent/tasks.py` 不发起任何模型调用**：本层只做三件事——派发前算 `runnable`、派发时裁 scope、收产物时剥离越权字段并校验。实际提示词拼装、上下文装配、模型选择都在编排层。把它当「agent 本体」会误判它的职责。
- **`knowledge/incremental.py` 的语义指纹是字符级规范化 hash，不是语义理解**：它靠 NFKC + 折叠空白 + 标点归一判断「表述是否只变了格式」，能放过「改标点/改全半角/改空格」，但**识别不了**「满100减10」与「消费百元立减十元」是同一条规则。这类改写仍会触发重算。宁可多算一次，不可漏算。
- **`exec/snapshot.py` 只做结构化 diff**：不比对截图/图像，不做视觉回归。iframe 与 shadow DOM 的原料采集依赖 Playwright（M2），当前 `frame_path_of` / `fingerprints_of` 只负责把已有元素标注成「在哪个上下文、按什么优先级定位」——**没有 frame_path 的定位器在多 frame 页面必然假失败**，这一点在 M2 接浏览器前不会有改善。

## 第四轮边界速查（给 codex 的一句话版）

| 模块 | 能用，但别指望它 |
|---|---|
| `assets/library.py` | 会算健康分，不会告诉你哪条用例该判失败 |
| `regression/plan_regression.py` | 会选会算覆盖，没有可信影响源时会直接说「不知道」 |
| `plan/phases.py` | 会拦跳步和空壳产物，不会替人点确认 |
| `agent/tasks.py` | 会拦住越权字段，不会替你调模型 |
| `knowledge/incremental.py` | 能放过格式变更，认不出同义改写 |
| `exec/snapshot.py` | 能比结构，不能比长相；多 frame 要自己带 `frame_path` |
| `assets/binding.py` | 能给应然接线表，要结论得喂调用日志 |
