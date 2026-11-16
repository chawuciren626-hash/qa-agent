# 整合判定表（给 codex）

逐文件判定：**能直接用 / 要小修 / 建议跳过**。
判定维度只有两个——**代码可移植性**（能不能直接 copy 进工程）和**业务必要性**（工程是否真需要这块）。
两者都通过才进 A 档。

验收现状：`python3 tests/smoke_tools.py` → 34/34 ALL PASS；`python3 tests/smoke_round4.py` → 9/9 ALL PASS；`irval` 97 用例全绿；拦截率 100%、误杀 0。

> **版本说明**：本表第一~四章的 A/B/C 三档统计基于**第一版工具包 6653 行**。第四轮补建的 7 个模块（1894 行）单独列在**第七章**，并给出各自的整合档位——它们按「没有就没法编排」来判定，档位与第一~四章不可直接相加。

---

## 零、先决条件（决定这张表是否成立）

**全部 8547 行的可用性绑定在一个前提上：工程是否采纳这套 IR / exec IR / DSL 契约。**

| 前提 | 后果 |
|---|---|
| 采纳（IR 契约 v1 + exec IR + 五档 verdict + 五闸） | A 档直接 copy，B 档一天一个，C 档留在仓库当参考实现 |
| 不采纳（工程已有自己的 IR/schema） | **全部降级为参考实现**——价值从「代码」变成「设计决策的物化」，读设计、不抄代码 |

这不是免责声明，是判断依据：这些工具的价值 90% 来自「和契约对齐」，代码本身只是把契约变成可执行断言。契约不认，代码就是一堆有注释的字符串处理。

---

## 一、A 档：直接可用（4441 行，67%）

copy 进工程，接上调用点即可，**不需要改内部逻辑**。

| 文件 | 行 | 依赖 | codex 要做的 |
|---|---|---|---|
| `irval/`（11 文件） | 1536 | 无 | 挂到入库前钩子：`pipeline.run(ir, kind)` → findings。已有同类校验器则整块跳过 |
| `onboard/bootstrap.py` | 625 | requests | **不改也能跑**。可选：requests 换工程 HTTP 层 |
| `onboard/cli.py` + `__main__.py` | 69 | — | 直接当 `新建项目` 的后端入口 |
| `knowledge/extract.py` | 289 | 无（docx 分支需 python-docx） | 无。资料库是 md/docx，正好对口 |
| `knowledge/maps.py` | 190 | 无 | 落盘根目录改成工程的项目目录约定 |
| `common/version.py` | 224 | 无 | 无。**拍板项落地**：版本写 exec IR、执行期冻结、漂移判定 |
| `common/capability.py` | 83 | 无 | 无。三档分发 + 握手协商 |
| `common/context_assembler.py` | 194 | 无 | 可选：`est_tokens` 换真 tokenizer（现在是保守估算，够用） |
| `common/lineage.py` | 115 | 无 | 无。IR 公共头 |
| `common/semantic_diff.py` | 75 | 无 | 需产品确认口径（是否做增量重算），代码不用改 |
| `exec/wait_assert.py` | 187 | 无 | 无。8 类封闭枚举等待 + observe/decide 断言分级 |
| `plan/gates.py` | 153 | 无 | 无。五闸编译期，闸 5 恒 pending 由执行回填 |
| `regression/selector.py` | 261 | 无 | 无。三闸选集 / flaky 判定 / 准入结论 |
| `regression/impact.py` | 76 | 无 | 输入是 touches 列表，与 git 解耦；接 git diff 在调用侧做 |
| `testpoint/coverage.py` | 106 | 无 | 无。V-33 对账（M1 唯一缺的规则） |
| `testpoint/matrix.py` | 120 | 无 | **只做一件事**：`KNOWLEDGE_MAP` 种子表（18 控件×8 维度）让产品过一遍，这是产品判断不是代码问题 |
| `requirement/testability.py` | 46 | 无 | 无。T1~T4 |
| `requirement/acceptance.py` | 96 | 无 | 无。E1/E2/E3/W1 |

**A 档里业务必要性存疑的三个**（技术上能跑，但要先想清要不要）：
- `semantic_diff`：只有做「血缘增量重算」才需要，不做就删
- `context_assembler`：只有接受「按 scope 切片喂模型」才需要；如果坚持每轮灌整份资料库，它没用
- `regression/impact.py`：五触发源里「历史相似」要求有历史执行数据，冷启动阶段只有 4 源有效

---

## 二、B 档：小修（1794 行，27%）

骨架和规则是对的，**接口要换成工程已有的东西**。

| 文件 | 行 | 必须改什么 | 为什么 |
|---|---|---|---|
| `exec/api_engine.py` | 244 | ① `requests` → 工程 HTTP 层（重试/代理/证书/日志）② `_JSONPATH_SIMPLE` 只支持 `$.a.b`，换完整 jsonpath 库 ③ exec 落库结构与工程表对齐 | 现在是最小引擎，真实接口的 jsonpath 和鉴权都比它复杂 |
| `exec/api_ext.py` | 118 | sqlite → 工程 DB 驱动；`AsyncPoller` 同步轮询，MQ 消费要另写 | 原型实现 |
| `exec/login.py` | 165 | 验证码识别接真实服务；session 固化要接浏览器存储 | 策略链逻辑可留，外部能力要接 |
| `exec/infra.py` | 108 | L1/L2/L3 的「执行动作」要接真实 driver 回调 | 现在只判级，不执行 |
| `explore/explorer.py` | 249 | 需要渲染器喂 DOM（Playwright），现在只吃静态 HTML | 规则层（路由四来源/控件提取/预算护栏/危险动作）已验证，缺的是输入 |
| `case/builder.py` | 152 | `DataFactory` 换工程 faker/数据池（现在用 `random` + 固定种子）；骨架模板对齐工程 plan schema | 数据工厂自造容易和真实字段约束脱节 |
| `requirement/parsers.py` | 193 | Figma 分支 M2 关掉；OpenAPI 只解析了 JSON body + path/query required，要补 | 解析器覆盖面 |
| `defect/evidence.py` | 108 | 七分区目录接工程存储（现在只生成结构） | 取证包本体 |
| `defect/tools.py` | 153 | 与工程 issue 系统对齐；**若工程已有缺陷单，这块可以整块删** | 去重指纹和偶发识别有独立价值，CRUD 没有 |
| `report/reviewer.py` | 122 | `REVIEWER_PROMPT` 要给产品改；只取 `extract_facts` + `RiskLedger`，渲染交给工程报告层 | 提示词属服务端下发档 |
| `common/model_capability.py` | 182 | 五类任务的档位映射要按工程实际模型清单校准 | 「LLM 能力取决于用户配置的模型」，档位表是空的就没意义 |

---

## 三、C 档：建议跳过（392 行，6%）

**这些是为了「§11 章节不缺项」建的，不是可复用资产。** 现在没有输入、没有运行时，跑起来就是空转。

| 文件 | 行 | 为什么跳过 | 唯一残留价值 |
|---|---|---|---|
| `exec/native_mini.py` | 109 | 无真机、无 Appium，定位解算和弹窗链没有执行体 | `LocResolver` 的多指纹降级优先级，Web 侧可参考 |
| `exec/hybrid.py` | 112 | 混合 driver 用例 M2 才出现，校验器现在没有输入 | 四条约束（主 driver/≤2 段/context_flow 显式/最弱一环）是可以直接抄的规则 |
| `exec/pools.py` | 83 | 四池调度要有多 driver 才有意义；M1 单驱动串行就够 | 池容量默认值（接口 20~50、Web=CPU 核数、设备 1）有参考价值 |
| `exec/debug.py` | 88 | `DebugController` 是纯状态机，但没 runtime 就没人调它 | 断点/单步/接管三模式的状态机设计，M2 接浏览器时直接复用 |

**处置建议**：不整合进工程，**留在仓库里当参考实现**，M2 做 Web/App 时再取。删掉也行——设计已在方案文档里，代码是复述。

---

## 四、如果只能保留三样

按「不可替代性 × 已验证程度」排：

1. **`onboard/bootstrap.py`（625 行）** —— 实测跑过、修掉 5 个真 bug（中文编码、`captcha.jpg` 判空、`router.push` 漏抓、`/stock/check/T-2026-0001` 未收敛、接口 module 全叫 api）。它直接解掉「给个地址十几分钟跑不完」这个上次演示失败的根因。
2. **`irval/`（1536 行）** —— 97 用例验收过的规则引擎。这是「agent 不许自写 program 字段」「版本戳不许伪造」这些红线的执行体，没有它，所有护栏都只是文档。
3. **`common/version.py`（224 行）** —— 版本写进 exec IR + 执行期冻结。不建这个，「agent 自写 engine_version 洗白 flaky」这个漏洞就关不上。

反过来，**最没必要建的是 C 档那 392 行**。我当时是为了「对照方案 §11 逐项不缺」才补的，属于对文档负责、对工程不负责。

---

## 五、整合顺序建议

按依赖倒序，避免半截状态：

```
第 1 步（无依赖，可立刻进）
  common/lineage.py, common/version.py, irval/
  → 先有 IR 头和校验器，后面所有产物才有地方落、有东西验

第 2 步（依赖第 1 步）
  requirement/*, knowledge/extract.py, testpoint/*
  → 需求进来能变成知识条款和测试点

第 3 步（独立链路，可与 1 并行）
  onboard/bootstrap.py + cli
  → 建档是用户旅程第一步，和需求链路无耦合

第 4 步（依赖 1、2）
  knowledge/maps.py, plan/gates.py, case/builder.py
  → 有知识有地图，才能编译计划

第 5 步（依赖 4）
  exec/*, explore/explorer.py
  → 计划有了才执行

第 6 步
  regression/*, defect/*, report/reviewer.py
  → 有执行结果才有回归、缺陷、报告
```

---

## 六、三条不许改的地方

整合时容易「顺手优化」掉，这三处一改就退回原点：

1. **建档三处硬边界**：bundle 抓取上限（12 文件 / 2MB / 8MB）、编码嗅探顺序（charset → UTF-8 严格 → GB18030）、路由归一化（`/order/123`→`/order/:id`，拼接前缀单列不并入）。放开任一处，「10 秒出清单」立刻退回「十几分钟跑不完」。
2. **版本字段列在 `EXEC_FACT`**（`irval/ownership.py`）：agent 写的版本戳必须被剥离。删掉这条，flaky 判定就能被自证清白。
3. **`run_plan` 内部的 `CapabilityRegistry` 冻结**：执行期任何 register 抛 `VersionFreezeError`。不要在会话中途热加载能力包，否则第一条 exec 记录的版本就是错的。

---

## 七、第四轮补建的 7 个模块（1894 行）该怎么算

这 7 个模块不是「锦上添花」，它们解决的是同一类问题：**前面几轮的产物没有闭环**。需求能抽出来，但没人管它什么时候被确认；用例能生成，但资产改了没人管血缘；回归能选，但选完说不出「没跑的那部分有什么风险」。

判定口径与前四章一致，但这批模块多了一个维度：**是否存在替代写法**。凡「用别的办法也能做，只是会到处散落」的，一律标 A 档——因为整合成本低于分散实现。

### 7.1 A 档：直接可用（1229 行）

| 模块 | 行 | 解决什么 | 整合要做的 |
|---|---|---|---|
| `plan/phases.py` | 300 | 阶段状态机：拦跳步、拦空壳产物、确认只能人签、变更沿血缘作废下游 | 编排层第一步就 `PhaseState()`，别让 agent 自己决定下一步 |
| `agent/tasks.py` | 229 | agent 派发契约：`dispatch` 按 tier/scope 裁上下文，`submit` 剥离越权字段并校验 | 把「调模型」唯一入口改成 `dispatch→模型→submit` 三段 |
| `assets/library.py` | 452 | 元素/片段/数据集三条资产纪律：单点写入、必带 reason、失效不删除、凭据不进明文 | 把工程里任何直接改资产的操作改成 `apply(change, actor, reason)` |
| `regression/plan_regression.py` | 283 | 回归三问：五源选集 + 影响覆盖度 + 未测清单 | 接 `maps_diff`（页面消失即退场，不计 fail） |
| `assets/binding.py` | 152 | 把两块此前没接线的 Skill（`test-asset-management` / `test-selection`）绑到具体 agent+工具 | 无代码改动，接流水后 `binding_audit` 才有结论 |

**为什么这五个是 A 档**（1229 = 300+229+452+283+152；另 12 行为两个 `__init__.py` 的导出层，随包走）：它们内部没有对工程 IR 的假设，输入输出都是普通 dict。唯一耦合点是字段名（如 `phase` / `kind` / `element_ref`），改常量即可，不需要动逻辑。

### 7.2 B 档：要小修（466 行）

| 模块 | 行 | 必须改什么 | 为什么 |
|---|---|---|---|
| `knowledge/incremental.py` | 252 | `normalize_text` 的归一化强度要按工程实际资料库调（中文标点/全半角/数字写法的容忍度） | 现在是 NFKC + 折叠空白，放过格式差异；若工程资料库同义改写多，重算率会偏高 |
| `exec/snapshot.py` | 214 | `build_snapshot` 的入参要接工程探索器的元素模型；`MAX_ELEMENTS=800` 要按目标系统页面复杂度调 | 元素模型字段名（testid/role/label）与探索器必须一致，否则指纹全空 |

### 7.3 这一批里最该先接的三个

按「不接就会出现错误结论」排：

1. **`plan/phases.py`** —— 不接，就等于让 agent 自己判断「这一步能不能做」。所有「不许跳步」的承诺都靠它落地。
2. **`agent/tasks.py`** —— 不接，越权字段（agent 自己写 `approved_by`、自己写 `evidence_ref`）就没人剥。这是演示时最能说服人的护栏。
3. **`regression/plan_regression.py`** —— 不接，「覆盖率」这个词就会继续被误用：没有可信影响源也报个数，用户会以为「测了 90%」。

### 7.4 这 7 个模块各自的诚实边界

写在这里是为了避免 codex 把它们当成「万能件」：

| 模块 | 能做 | 做不到（别指望） |
|---|---|---|
| `assets/library.py` | 算健康分、强制 reason、拦凭据明文 | 健康分**不参与 verdict**；不做元素自动发现；不做并发写锁 |
| `assets/binding.py` | 给应然接线表、按流水算实调 | 无流水时 `covered=0` **不代表未接线** |
| `regression/plan_regression.py` | 五源选集、影响覆盖、未测清单 | `history_similar` 只选不判，**不进覆盖度分子分母**；无可信源时 `available=False` |
| `plan/phases.py` | 拦跳步/空壳/越权确认 | 不替人点确认；`maps` 的 kind 被 `explore` 收口，只跑建档不算数 |
| `agent/tasks.py` | 派发裁 scope、收产物剥越权 | **不发起模型调用**；提示词拼装属编排层 |
| `knowledge/incremental.py` | 放过格式变更（标点/全半角/空白） | 是字符级 hash，**不是语义理解**，认不出同义改写 |
| `exec/snapshot.py` | 结构化 DOM 语义 diff | 不做图像 diff；多 frame 必须自带 `frame_path`，原料采集靠 Playwright（M2） |

### 7.5 对整合顺序的修正

原第五章 6 步顺序不变，但**第 1 步要加两项**：

```
第 1 步（无依赖，可立刻进）
  common/lineage.py, common/version.py, irval/
  + plan/phases.py        ← 新增：状态机必须在写第一条业务代码前就位
  + agent/tasks.py        ← 新增：agent 入口先定契约，后面所有 agent 都照这个写
```

原因：状态机和 agent 契约是**结构性的**。等业务代码写完了再补，等于把已经散落在各处的「我自己决定下一步」「我直接把模型输出写进产物」全找出来改一遍——成本是提前接的十倍。

---

## 八、评审落地项对整合顺序的影响（2026-11-14 增补）

方案 v3.2 的 §25 列了 11 项评审落地（L-1~L-11，约 29.5 人日）。**它们不改变本表 A/B/C 的档位判断，但改变"先接哪个"**：

| 落地项 | 影响哪个已交付模块 | 对整合顺序的影响 |
|---|---|---|
| **L-1** `expected` 收权 | `irval/ownership.py`（分权表） | **必须在 codex 第一次接 agent 写产物之前做**。晚做等于先放开口子再收，已经产生的 `expected` 改动无法追溯 |
| **L-2** `invalidate` 支持子集 | `plan/phases.py` | 若第 1 步就接状态机，**接口签名一次写对**（多传 `artifact_subset` 参数），不要先按阶段级实现、之后再改 |
| **L-6** 采样分层 | `regression/selector.py` | 接回归选集时一起接，1.5 人日，别单独排期 |
| **L-11** 多模块状态机 | `plan/phases.py` | **与 L-2 合并做**，两者改的是同一个文件的同一处结构。分开做会改两遍 |
| L-3 / L-4 | `case/builder.py`、新增 `tests/golden/` | 属 M4 前置，第一条 LLM 调用上线前必须就位。codex 若先做确定性链路，可暂缓 |
| L-5 / L-7 / L-8 / L-9 / L-10 | `onboard` / `agent/tasks` / 新增 `requirement/completeness` / `defect/tools` / 全局 trace | 各自独立，不阻塞主链路，按里程碑排 |

**一句话**：**L-1 要在 agent 层接入前完成；L-2 与 L-11 合并成一次改动；L-6 随回归模块一起接。** 其余按 M2/M3 走。

> 这也是本表第 1 步清单需要更新的原因：原第 1 步是 `common/lineage.py + common/version.py + irval/ + plan/phases.py + agent/tasks.py`，现在应加上「**phases.py 的改造（L-2 + L-11）一次到位**」和「**ownership.py 的 L-1 在 agent 接入前完成**」两个前置条件。
