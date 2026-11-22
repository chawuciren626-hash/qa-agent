# 流 B 变更报告（IR 契约 + 提示词 + Skill）— 2026-11-22

- Agent：qoder（Agent 2）
- 分支：`feat/stream-b-ir-prompts`（基于 main `9af26c6` 创建）
- 范围：B1–B11 全部条目；只改 `schemas/`、`penguin/agents/`、`skills/`、`config/`、`aitestharness-ir/` 及 `penguin/agents.json`（skill 安装登记，见 B11 说明）

## 一、修改文件清单

| 条目 | 文件 | 位置 | 动作 |
|---|---|---|---|
| B1 | `schemas/test_point.schema.json` | L54–66 | 新增可选 `end` 字段（string 枚举 web/web_admin/app/miniprogram/desktop/api/空串，空串=未指定） |
| B1 | `schemas/test_case.schema.json` | L338–350 | 同上 |
| B2 | `aitestharness-ir/irval/enums.py` | L29–31、L130–131 | 枚举字典新增 `end`（含空串）；`enum_for_path` 增加根路径 `end` 映射 |
| B2 | `aitestharness-ir/suite/cases.py` | L176–202 | 新增 11 个 V-02 end 用例（8 正例 3 反例） |
| B3 | `penguin/agents/requirement_analysis_agent/AGENTS.md` | L52–56 | 新增「端标签与锚点引用」节 |
| B4 | `penguin/agents/test_point_agent/AGENTS.md` | L32–36 | 新增「端标签与锚点引用」节 |
| B5 | `penguin/agents/test_case_agent/AGENTS.md` | L29–33 | 新增「锚点与资产引用」节 |
| B6 | `penguin/agents/automation_execution_agent/AGENTS.md` | L20–22 | 新增「verified 锚点与资产约束」节 |
| B7 | `penguin/agents/api_automation_agent/AGENTS.md` | L15–17 | 新增「verified 锚点与资产约束」节 |
| B8 | `skills/requirement-analysis/SKILL.md` | L3、L7–8 | frontmatter `tools` 上方加注释说明"阶段收口校验清单"语义；版本 2026.11.02.3 → 2026.11.02.4 |
| B9 | `skills/anchor-verification/SKILL.md` | 新文件（51 行） | 锚点验证 skill |
| B10 | `skills/change-analysis/SKILL.md` | 新文件（49 行） | 变更分析 skill |
| B11 | `penguin/agents.json` | requirement_analysis_agent / test_point_agent 的 skills 数组 | 分别安装 change-analysis / anchor-verification |
| B11 | `config/release-resources.json` | files 白名单（按字母序插入） | 登记两个新 SKILL.md |

## 二、各条目说明

### B1 end 字段
- 可选字段，不进 `required`，旧产物无 end 仍合法（向后兼容）。
- 枚举含空串 `""` 表示"未指定"；两个 schema 的 `description` 注明语义。
- 消费方 `test-point-diagnosis.mjs` / `test-case-diagnosis.mjs`（Ajv2020, strict:false）与 `validate-test-cases-schema.mjs`（按 properties.enum 自动收集枚举检查）无需改动即生效；两 schema 均未设 additionalProperties:false，无破坏面。

### B2 irval 用例
- `end` 枚举进 `enums.py` 唯一权威来源（契约 2.5 原则），校验器不内置第二份。
- 用例覆盖：六个合法端值（tp/case 交替）、空串=未指定、缺省字段合法（v1.0 兼容）、中文端名/自造别名 h5/大小写 Web 三个反例（SCHEMA_ENUM_INVALID）。
- `end` 是 agent 可写业务字段（不在 ownership.py PROGRAM_ONLY），无需分权改动。

### B3–B7 提示词
- 全部为**新增小节**，未删除/改写既有规则。
- 共同纪律：端标签来源未说明不推断；锚点三选一（页面/接口/代码）必须真实存在；挂不上标"暂不可测"不编造；执行角色缺 verified 资产 → blocked + 缺失清单（case_id/资产或锚点 ID/原因）。
- 与既有纪律的衔接：需求角色端/锚点信息记入现有台账字段（不自创字段）；测试点接口锚点用 operation_id；用例资产引用走 asset_refs(id+version)；automation_execution 的 verified 约束限定 lifecycle 脚本链路，独立任务模式仍按既有 snapshot 实时观察纪律，避免与 task 分支冲突。

### B8 tools 语义
- 正文「阶段工具执行协议」已有收口清单说明（stage_finalize 合并调用），本次在 frontmatter 加 YAML 注释使语义在声明处可见；tools 值不变。
- 版本格式遵循验收测试钉死的 `2026.11.02.N` 基线（tests/acceptance/skill-resources.test.mjs L245）。

### B9/B10 新 skill
- 格式参照 test-selection/system-map-exploration：frontmatter name/version/description/task:none/tools:[]/sections 三类分离。
- `tools: []`：当前无对应确定性工具，不绑定 TASK_CONTRACTS；正文不引用任何 tool_id（满足 check-capability-source B3）。
- anchor-verification：按端×环境核对锚点三态（verified/candidate/缺失），输出按端锚定率与缺失清单；只读核对，不晋升资产、不改设计。
- change-analysis：diff → 变更模块（带端）/风险点/测试建议/候选契约更新；候选更新仅建议，走确认门禁，不直接改契约与 verified 资产。

### B11 编排评估结论
- **不做 api_execution 并入 execution**：通道合并涉及 server 路由、structured-actions 与执行引擎（流 C/D 归属），且 `tests/acceptance/skill-resources.test.mjs` L112 断言各阶段 skill 数（api_execution=2，其余=1）、大量验收测试硬编码 dispatch skills 列表（structured-actions.mjs L871 精确匹配保存计划）。改阶段 skills 会破坏这些测试，超出流 B 边界。
- **新 skill 只登记安装（agents.json），不进 workflow stage skills**：agent 安装后可按需读取（AGENTS.md 已写"装有 anchor-verification Skill 时交付前按其自检"）；dispatch 模板与保存计划不受影响，零测试破坏。
- `config/orchestration-workflow.json` 与 `scripts/stage-registry.mjs` **无需改动**（stage-registry 动态读取配置，无结构变化）。
- 若 ZCode 希望新 skill 进入阶段派发清单，需同步更新上述验收测试的 skills 断言——**需要流 C 配合**，由 ZCode 统一协调。

## 三、新增 API 端点或函数

无新端点。新增函数级变更仅 `enum_for_path` 的 `end` 分支；新增枚举键 `ENUMS["end"]`。

## 四、依赖的已有机制

- Ajv2020 schema 校验（test-point/test-case-diagnosis）、properties.enum 自动枚举检查（validate-test-cases-schema）
- irval S 层 V-02 枚举封闭规则与 suite 用例框架（doc 变异器）
- ownership.py 字段分权（end 属 agent 可写业务字段）
- check-skills / skill-resources 的白名单与安装校验、check-capability-source 的 sections 三类分离
- stage_finalize 收口协议（B8 注释所指）、系统地图产出契约（maps/<env>/pages.json、apis.json、coverage.json，B9 核对依据）、config/test-assets.json verified 资产目录（B5–B7 引用约束）

## 五、测试结果

| 检查 | 结果 |
|---|---|
| `node scripts/check-skills.mjs` | PASS（18 skills / 41 resources / 12 agents） |
| `node scripts/check-tool-contract.mjs` | PASS（A1–A4） |
| `cd aitestharness-ir && python -m pytest tests -q` | **125 passed**（原 114 + 新增 11 个 end 用例） |
| `node scripts/check-capability-source.mjs` | 本流新增/修改 skill 全部通过；仅存量 system-map-exploration 幽灵标题失败（见下） |
| Ajv 编译两 schema + end 枚举冒烟 | PASS |
| `node --test tests/acceptance/skill-resources.test.mjs` | 12 pass / 6 fail，与 main 基线（临时 worktree 对照）**完全一致**，本流零新增失败 |

## 六、已知限制与待完善项（含需协调事项）

1. **存量问题（main 上即存在，非本流引入，需 ZCode 协调）**：
   - `check-capability-source.mjs` B4：`skills/system-map-exploration/SKILL.md` frontmatter 声明了正文不存在的「产出契约」「登录与凭据」两个幽灵标题（流 F 归属文件，未动）。
   - `skill-resources.test.mjs` 6 个失败在 main 基线同样复现：agents 数量断言 11 vs 实际 12（env_explorer_agent 注册后未更新）、system-map-exploration 版本 2026.11.21.1 不符合 2026.11.02.N 断言等。
2. **IR 契约文档同步**：`docs/AITestHarness-IR契约规范-v1.md` §2.5 枚举字典尚未列入 `end`（enums.py 已按任务要求新增）。契约文档不在流 B 分配目录内，按附录 A 流程补记——**需要 ZCode 配合**。
3. **锚点字段承载**：测试点/用例 schema 本次只加 `end`；锚点引用按提示词用现有字段（operation_id/来源引用/描述）表达，未新增结构化 anchor 字段。若后续要程序化校验锚点存在性（anchor-verification 工具化），需要 schema 增加锚点字段与对应校验器——留待后续批次。
4. **分支插曲**：本分支工作期间出现非本流提交 `f3adecb`（C1 approve 门禁补跑阶段诊断）与 `e558e16`（C4 修订简报装配器）——ZCode 的流 C 内容落在当前检出分支上。本流提交仅包含上表文件，未触碰这些提交；合并时请 ZCode 留意归属。另：docs/ 为白名单制（.gitignore `/docs/*`），本报告以 `git add -f` 纳入版本控制，未改 .gitignore；如需长期收录请 ZCode 补白名单条目。
5. 新 skill 未绑定确定性工具（tools:[]），锚点核对与 diff 解析目前由 Agent 按 Skill 纪律执行；工具化（如 anchor.verify / change.extract）需中央工具台账登记，属后续批次。