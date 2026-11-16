/**
 * 工具模块（工具管理）。
 *
 * 「一个工具」= 一个可被 agent 调用的**能力单元**，不是 `read_file` 那类内置函数：
 * 它对应架构方案里的一条纪律（如 irval 校验链、资产库写入纪律、回归选集编排），
 * 因此字段里除了参数契约，还要有「属于哪个阶段」「读还是写」「被哪些 Agent 引用」
 * 「是否启用」——这四样是演示时唯一答得上来的东西。
 *
 * 存储独立成表，不进 `public_resources`：
 * 工具是运行期能力的登记与开关，不参与「发布/回滚/版本包」那套资源治理；混进去会让
 * `KINDS`、依赖解析、bundle 校验都被迫接受一种没有 draft/publish 语义的资源。
 *
 * 三条纪律（与资产库同源）：
 * 1. 唯一写入口是 POST/PUT，且冻结时校验 revision，冲突就拒；
 * 2. 每次变更写一条 `central_tool_audit`，不允许静默改；
 * 3. 内置工具不可删除，只可停用——删掉等于把方案的依据弄丢了，停用才是真实语义。
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpError } from "./errors.js";
import type { AppEnv } from "../auth/middleware.js";
import type { ControlStore } from "./control-plane.js";

/** 与技能同名的阶段分类：同一个人在同一套后台里看到的两处分类必须一致。 */
const STAGES: ReadonlyArray<readonly [string, string]> = [
  ["common", "通用"], ["req", "需求分析"], ["design", "测试设计"], ["case", "用例生成"],
  ["web", "Web 自动化"], ["api", "接口自动化"], ["app", "App 自动化"], ["mini", "小程序自动化"],
  ["report", "测试报告"], ["defect", "缺陷管理"],
];

/**
 * 首批内置工具。`implemented:false` 的按「规划中」入库并默认停用——
 * 后台里出现一个灰着的条目，比出现一个假的可点条目诚实。
 */
type Seed = {
  name: string; displayName: string; summary: string; description: string;
  categoryId: string; permissions: "read" | "write"; implemented: boolean;
  parameters: Record<string, unknown>; returns: Record<string, unknown>; agents: string[];
};
const SEED: Seed[] = [
  {
    name: "irval.check", displayName: "IR 校验链", categoryId: "common", permissions: "read", implemented: true,
    summary: "23 条规则校验 IR 的字段、枚举、血缘与版本戳，反例必须被拦下",
    description: "对上游产物做结构化硬校验：字段缺失、枚举越界、血缘断裂、版本戳伪造。校验不过即阻塞，不允许下游继续。验收基线：97 个正例全过、62 个反例 100% 拦截、0 误杀。",
    parameters: { type: "object", required: ["kind", "payload"], properties: { kind: { type: "string", enum: ["requirement", "testpoint", "case", "plan"] }, payload: { type: "object" }, strict: { type: "boolean", default: true } } },
    returns: { type: "object", properties: { ok: { type: "boolean" }, violations: { type: "array", items: { type: "object", properties: { rule: { type: "string" }, path: { type: "string" }, message: { type: "string" } } } } } },
    agents: ["requirement_analysis_agent", "test_point_agent", "test_case_agent", "automation_execution_agent"],
  },
  {
    name: "assets.library", displayName: "资产库（元素/片段/数据）", categoryId: "web", permissions: "write", implemented: true,
    summary: "元素、片段、数据集三条资产纪律：单点写入、必带理由、失效进历史可复活",
    description: "改元素库一处，全用例生效（plan 只写 element_ref）；所有改动必须带 reason 并留 diff，禁止运行期悄悄修改；失效不是删除，进 retired 历史可复活；凭据明文一律拒，只允许 ${secret.xxx}。",
    parameters: { type: "object", required: ["change", "actor", "reason"], properties: { change: { type: "object", description: "element_ref 的目标状态" }, actor: { type: "string" }, reason: { type: "string", minLength: 4 } } },
    returns: { type: "object", properties: { applied: { type: "boolean" }, diff: { type: "object" }, health: { type: "object", description: "启发式评分，仅用于排序与告警，不参与 verdict" } } },
    agents: ["test_case_agent", "automation_execution_agent"],
  },
  {
    name: "regression.select", displayName: "回归选集编排", categoryId: "report", permissions: "read", implemented: true,
    summary: "按 Profile 与用例元数据选用例，逐条记录入选/排除原因与预算影响",
    description: "当前实现：读 config/test-selection-policy.json 的 Profile（smoke/core_regression/regression/full/targeted），按模块、标签、风险、成本、数据影响、环境依赖打分选入，依据或假设未确认的用例直接排除并记原因，预算超限同样记录，产出 selection/test-selection.json。尚未实现方案要求的「五源按可信度排序」「影响覆盖度」「未测清单」与 available=false 口径——此时不报覆盖率这件事，本工具目前还管不到。",
    parameters: { type: "object", required: ["tier"], properties: { tier: { type: "string", enum: ["core", "full", "smoke"] }, changed_modules: { type: "array", items: { type: "string" } }, changed_requirements: { type: "array", items: { type: "string" } }, maps_diff: { type: "object" }, budget_s: { type: "number" } } },
    returns: { type: "object", properties: { selected: { type: "array" }, sources: { type: "object" }, coverage: { type: "object" }, untested: { type: "array" }, retired: { type: "array" } } },
    agents: ["test_agent", "test_report_agent"],
  },
  {
    name: "plan.phases", displayName: "阶段状态机与确认门", categoryId: "common", permissions: "read", implemented: true,
    summary: "拦跳步、拦空壳产物、确认只能人签、变更沿血缘作废下游",
    description: "九阶段前置契约：缺上游产物即拒绝执行，不允许 LLM 现场编造上游；产物存在但必需字段为空判 invalid；确认动作 agent_cannot_confirm；需求变更时下游标 stale，产物保留但不再作为依据。",
    parameters: { type: "object", required: ["phase", "action"], properties: { phase: { type: "string", enum: ["onboard", "explore", "requirement", "testpoint", "case", "plan", "execute", "defect", "report"] }, action: { type: "string", enum: ["can_run", "start", "finish", "confirm", "invalidate"] }, artifacts: { type: "object" } } },
    returns: { type: "object", properties: { ok: { type: "boolean" }, blocked_by: { type: "array" }, blocked_by_confirm: { type: "array" }, stale: { type: "array" } } },
    agents: ["requirement_analysis_agent", "test_point_agent", "test_case_agent", "automation_execution_agent", "defect_analysis_agent", "test_report_agent"],
  },
  {
    name: "agent.contract", displayName: "Agent 派发契约", categoryId: "common", permissions: "read", implemented: true,
    summary: "派发时按能力档位裁上下文，收产物时剥离越权字段并校验",
    description: "五类任务的输入输出契约：dispatch 按 tier/scope 裁上下文并给出 runnable；submit 先剥离越权字段（approved_by / gates / evidence_ref / verdict）再校验 must 与 must_not。本层不发起任何模型调用。",
    parameters: { type: "object", required: ["task", "action"], properties: { task: { type: "string", enum: ["requirement_extract", "testpoint_fill", "case_step_fill", "failure_attribution", "report_insight"] }, action: { type: "string", enum: ["dispatch", "submit"] }, tier: { type: "string", enum: ["S", "A", "B", "N"] }, scope: { type: "object" }, payload: { type: "object" } } },
    returns: { type: "object", properties: { runnable: { type: "boolean" }, accepted: { type: "boolean" }, stripped: { type: "array" }, violations: { type: "array" } } },
    agents: ["requirement_analysis_agent", "test_point_agent", "test_case_agent", "defect_analysis_agent", "test_report_agent"],
  },
  {
    name: "knowledge.incremental", displayName: "知识增量重算", categoryId: "req", permissions: "write", implemented: true,
    summary: "语义变更重算闭包，表述变更只更新指纹，未受影响的产物一个字节不动",
    description: "对资料库做指纹 diff：NFKC + 折叠空白后指纹一致判为表述变更，不触发重算；id 同指纹异判语义变更，触发受影响用例闭包；改一句话就全量重审的系统没人用第二次，所以这条宁可放宽。",
    parameters: { type: "object", required: ["old", "new"], properties: { old: { type: "array", items: { type: "object" } }, new: { type: "array", items: { type: "object" } }, rename_threshold: { type: "number", default: 0.86 } } },
    returns: { type: "object", properties: { changed: { type: "array" }, wording_only: { type: "array" }, closure: { type: "object" }, untouched: { type: "array" } } },
    agents: ["requirement_analysis_agent", "test_point_agent"],
  },
  {
    name: "dom.snapshot", displayName: "DOM 快照与基线 diff", categoryId: "web", permissions: "read", implemented: true,
    summary: "结构化元素快照、frame/shadow 路径标注、按指纹集合做语义 diff",
    description: "按 testid→role→label→text→css→xpath 优先级提取指纹；多 frame 页面必须带 frame_path，否则同一条 css 会在两个上下文各命中一次——这是 Web 自动化最大的假失败来源。只做结构化 diff，不做图像比对。",
    parameters: { type: "object", required: ["page_url"], properties: { page_url: { type: "string" }, max_elements: { type: "number", default: 800 }, baseline_id: { type: "string" } } },
    returns: { type: "object", properties: { snapshot_id: { type: "string" }, elements: { type: "array" }, frames: { type: "array" }, diff: { type: "object" } } },
    agents: ["automation_execution_agent"],
  },
  {
    name: "expected.provenance", displayName: "预期结果溯源校验", categoryId: "case", permissions: "read", implemented: true,
    summary: "预期结果必须带来源与状态；全 unverified 时 verdict 上限为 inconclusive",
    description: "把 analysis 阶段已有的溯源纪律延伸到 case 阶段：expected 带 source{type,ref,quote} 与 state{verified,unverified,drifted}；无源即 unverified 且不进冒烟集；整条用例无 verified 断言时不判 pass。对应方案 §6.4，落在 scripts/expected-source.mjs（R1~R5）与 scripts/execution-verdict.mjs（把上限接到执行结论上，fail 不折算）。",
    parameters: { type: "object", required: ["cases"], properties: { cases: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { verdict_ceiling: { type: "string" }, unverified: { type: "array" }, drifted: { type: "array" } } },
    agents: ["test_case_agent", "automation_execution_agent"],
  },
  {
    name: "requirement.completeness", displayName: "需求完备性检查", categoryId: "req", permissions: "read", implemented: true,
    summary: "五类检查扫知识库，产出缺失项并修正需求覆盖率的分母",
    description: "五类检查：实体 CRUD 完整性、状态流转（含非法流转）、数值边界、权限矩阵、外部依赖失败路径。V-33 只对「需求→测试点」，没人对「业务真相→需求」对账，而缺陷逃逸主要来自后者。已落地：scripts/requirement-completeness.mjs（B3），unknown 不进分母，全 unknown 时 score=null。对应方案 §25.4。",
    parameters: { type: "object", required: ["knowledge"], properties: { knowledge: { type: "object" }, modules: { type: "array", items: { type: "string" } } } },
    returns: { type: "object", properties: { covered: { type: "array" }, missing: { type: "array" }, score: { type: "number" } } },
    agents: ["requirement_analysis_agent"],
  },
  {
    name: "requirement.parse", displayName: "文档/接口规格解析器", categoryId: "req", permissions: "read", implemented: true,
    summary: "文档解析器（docx/md → 章节树 + 条款）与接口规格解析器（OpenAPI → 接口 IR），全程零 LLM",
    description: "aitestharness_tools/requirement/parsers.py。文档解析保留原文位置（页码/段落）供溯源；接口规格解析零 LLM，结构化程度最高、优先使用。",
    parameters: { type: "object", required: ["source"], properties: { source: { type: "string", description: "文件路径或 URL" }, kind: { type: "string", enum: ["markdown", "docx", "openapi"] } } },
    returns: { type: "object", properties: { sections: { type: "array" }, clauses: { type: "array" }, endpoints: { type: "array" } } },
    agents: ["requirement_analysis_agent"],
  },
  {
    name: "requirement.testability", displayName: "可测性检查器", categoryId: "req", permissions: "read", implemented: true,
    summary: "四项纯规则检查：无预期结果 / 无边界 / 缺前置 / 表述歧义",
    description: "aitestharness_tools/requirement/testability.py（Validator，纯规则零 LLM）。不可测的需求在进入测试点之前被拦下。",
    parameters: { type: "object", required: ["requirements"], properties: { requirements: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { findings: { type: "array" }, score: { type: "number" } } },
    agents: ["requirement_analysis_agent"],
  },
  {
    name: "requirement.acceptance", displayName: "验收标准可观察性检查", categoryId: "req", permissions: "read", implemented: true,
    summary: "验收标准必须落到可观察字段，否则不可机判",
    description: "aitestharness_tools/requirement/acceptance.py。与 expected[].observable 同源纪律：不可观察的验收标准等于没有标准。",
    parameters: { type: "object", required: ["acceptance"], properties: { acceptance: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { observable: { type: "array" }, unobservable: { type: "array" } } },
    agents: ["requirement_analysis_agent"],
  },
  {
    name: "testpoint.matrix", displayName: "维度矩阵生成器", categoryId: "design", permissions: "read", implemented: true,
    summary: "矩阵由程序算，LLM 只补空格子：实体 × 操作 × 数据形态 × 权限",
    description: "aitestharness_tools/testpoint/matrix.py + 验证方式分配器（按测试点类型强制分配 api/ui/native/mini/db，§11.6）。",
    parameters: { type: "object", required: ["entities"], properties: { entities: { type: "array", items: { type: "object" } }, assignments: { type: "boolean", default: true } } },
    returns: { type: "object", properties: { matrix: { type: "array" }, gaps: { type: "array" }, assignments: { type: "array" } } },
    agents: ["test_point_agent"],
  },
  {
    name: "testpoint.coverage", displayName: "枚举清单对账器（V-33）", categoryId: "design", permissions: "read", implemented: true,
    summary: "需求枚举值 ↔ 测试点逐一对账，漏一个枚举就是漏一条用例",
    description: "aitestharness_tools/testpoint/coverage.py。IR 契约 V-33：枚举清单与测试点覆盖对账，差异逐条列出。",
    parameters: { type: "object", required: ["requirement", "test_points"], properties: { requirement: { type: "object" }, test_points: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { matched: { type: "array" }, missing: { type: "array" }, extra: { type: "array" } } },
    agents: ["test_point_agent", "test_case_agent"],
  },
  {
    name: "plan.gates", displayName: "计划校验器（五道闸）", categoryId: "design", permissions: "read", implemented: true,
    summary: "touched 提取 + 五闸编译：结构/引用/资源/副作用/预算，过闸才允许下发",
    description: "aitestharness_tools/plan/gates.py（extract_touched + compile_gates）。重放时刷新同一提取函数，保证 touched 与 plan 步骤一致。",
    parameters: { type: "object", required: ["plan"], properties: { plan: { type: "object" } } },
    returns: { type: "object", properties: { ok: { type: "boolean" }, gates: { type: "array" }, touched: { type: "object" } } },
    agents: ["test_case_agent", "automation_execution_agent"],
  },
  {
    name: "exec.api_engine", displayName: "接口执行引擎", categoryId: "api", permissions: "write", implemented: true,
    summary: "DSL（YAML plan）→ HTTP → exec IR；断言预声明、回执留痕、无重试通过率",
    description: "aitestharness_tools/exec/api_engine.py 与 qa/scripts/api-engine.mjs（同构实现，后者已接 M1 一致性与 duration_ms 汇总）。重定向不跟随、凭据只走引用通道。",
    parameters: { type: "object", required: ["plan"], properties: { plan: { type: "object" }, prior: { type: "object", description: "中断恢复用的既有回执" } } },
    returns: { type: "object", properties: { cases: { type: "array" }, receipts: { type: "object" }, statistics: { type: "object" } } },
    agents: ["automation_execution_agent"],
  },
  {
    name: "exec.pools", displayName: "调度分池", categoryId: "api", permissions: "read", implemented: true,
    summary: "接口/Web/设备/小程序四池；混合用例进主 driver 池；超容量排队不并发",
    description: "aitestharness_tools/exec/pools.py（§11.7）。默认容量：接口 20~50、Web=CPU 核心数、设备 1~2、小程序 1~2。",
    parameters: { type: "object", required: ["cases"], properties: { cases: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { pools: { type: "object" }, queue: { type: "array" } } },
    agents: ["automation_execution_agent"],
  },
  {
    name: "regression.impact", displayName: "回归影响选集", categoryId: "report", permissions: "read", implemented: true,
    summary: "五个触发源按可信度排序，每条选中必须给理由",
    description: "aitestharness_tools/regression/impact.py + qa/scripts/regression-sampling.mjs（采样分层 L-6）。触发源：变更血缘 / 元素失效 / 历史失败 / 冒烟集 / 周期全量。",
    parameters: { type: "object", required: ["changed"], properties: { changed: { type: "object" }, tier: { type: "string", enum: ["smoke", "core_regression", "regression", "full"] } } },
    returns: { type: "object", properties: { selected: { type: "array" }, reasons: { type: "object" } } },
    agents: ["test_agent", "test_report_agent"],
  },
  {
    name: "report.reviewer", displayName: "报告审阅（facts 抽取）", categoryId: "report", permissions: "read", implemented: true,
    summary: "报告 Agent = 审阅者不是写手：facts 纯数字抽取，agent 不可编造段落",
    description: "aitestharness_tools/report/reviewer.py + qa/scripts/report-fact-body.mjs / report-runtime-sections.mjs（运行时事实六段：工具降级、桩、完备性、聚类、覆盖度、数据生命周期）。",
    parameters: { type: "object", required: ["run_dir"], properties: { run_dir: { type: "string" } } },
    returns: { type: "object", properties: { facts: { type: "object" }, runtime_sections: { type: "string" }, review_notes: { type: "array" } } },
    agents: ["test_report_agent"],
  },
  {
    name: "defect.tools", displayName: "缺陷四件套（归因/去重/渲染/偶发识别）", categoryId: "defect", permissions: "write", implemented: true,
    summary: "归因下沉到执行末端；去重 display_only 不并单；偶发识别不折算失败率",
    description: "aitestharness_tools/defect/tools.py（§10.5）+ qa/scripts/normalize-defects.mjs / defect-cluster.mjs（merge_safety=display_only）/ defect-severity.mjs。",
    parameters: { type: "object", required: ["failure"], properties: { failure: { type: "object" }, defects: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { attribution: { type: "object" }, duplicates: { type: "array" }, flaky_suspects: { type: "array" } } },
    agents: ["defect_analysis_agent"],
  },
  {
    name: "defect.evidence", displayName: "取证包组装器", categoryId: "defect", permissions: "read", implemented: true,
    summary: "固定 7 分区（context/visual/dom/network/console/trace/history）+ 与历史基线 diff",
    description: "aitestharness_tools/defect/evidence.py（§12.5/§12.7）。失败那一刻取证包还在手上——归因因此下沉到执行末端。",
    parameters: { type: "object", required: ["run_id"], properties: { run_id: { type: "string" }, case_id: { type: "string" } } },
    returns: { type: "object", properties: { package_path: { type: "string" }, sections: { type: "object" } } },
    agents: ["automation_execution_agent", "defect_analysis_agent"],
  },
  {
    name: "onboard.bootstrap", displayName: "项目建档链路", categoryId: "common", permissions: "write", implemented: true,
    summary: "给一个地址 → maps IR + 建档报告，全程零 LLM",
    description: "aitestharness_tools/onboard/bootstrap.py（§10.10/§15.2 阶段①）：限流抓取 → 路由提取归一化 → 登录/验证码探测 → OpenAPI 发现 → 危险文案扫描 → 原子落盘。",
    parameters: { type: "object", required: ["target_url"], properties: { target_url: { type: "string" }, options: { type: "object" } } },
    returns: { type: "object", properties: { maps_ir: { type: "object" }, report: { type: "object" } } },
    agents: ["test_agent"],
  },
  {
    name: "trace.view", displayName: "全链路 trace 查询", categoryId: "common", permissions: "read", implemented: true,
    summary: "每个 action 一条 jsonl（O_APPEND 并发安全），可按 run/stage/action/成败过滤",
    description: "qa/scripts/trace.mjs（B1，L-10）。凭据脱敏（命中键整值 [redacted]）；attempt 由读取端编号；入口被拒也留 trace。无 trace 时 available=false，不据此判断「没有调用」。",
    parameters: { type: "object", properties: { run_id: { type: "string" }, action: { type: "string" }, stage: { type: "string" }, fail: { type: "boolean" }, limit: { type: "number", default: 50 } } },
    returns: { type: "object", properties: { rows: { type: "array" }, summary: { type: "object" }, available: { type: "boolean" } } },
    agents: ["test_agent"],
  },
  {
    name: "defects.cluster", displayName: "缺陷根因聚类", categoryId: "defect", permissions: "read", implemented: true,
    summary: "error_type + (堆栈帧|接口) 聚类；只改展示分组，不合并缺陷单",
    description: "qa/scripts/defect-cluster.mjs（B2，L-9）。merge_safety=display_only：聚类前后缺陷单数不变，40 张单仍各自可流转。",
    parameters: { type: "object", required: ["run_id"], properties: { run_id: { type: "string" }, min_size: { type: "number", default: 2 } } },
    returns: { type: "object", properties: { clusters: { type: "array" }, stats: { type: "object" }, merge_safety: { type: "string" } } },
    agents: ["defect_analysis_agent"],
  },
  {
    name: "release.probe", displayName: "发版探针", categoryId: "report", permissions: "read", implemented: true,
    summary: "按资源指纹判发版；S1/P0→smoke→其余抽样 20 条；失败率超阈值 blocked 不出全量报告",
    description: "qa/scripts/release-probe.mjs（B4，L-5）。整数比较避浮点；inconclusive 不进失败率；无 baseline 明确 no_baseline 不假绿。",
    parameters: { type: "object", required: ["build_id"], properties: { build_id: { type: "string" }, assets: { type: "array", items: { type: "object" } }, size: { type: "number", default: 20 }, threshold: { type: "number", default: 0.2 } } },
    returns: { type: "object", properties: { verdict: { type: "string" }, gate: { type: "object" }, plan: { type: "array" } } },
    agents: ["test_agent"],
  },
  {
    name: "golden.run", displayName: "golden set 回放", categoryId: "common", permissions: "read", implemented: true,
    summary: "六类结构断言（schema/数量区间/关键词/幻觉/引用/越权字段），与基线比退化",
    description: "qa/scripts/golden-runner.mjs + tests/golden/（B5，L-4）。replay 用录制基线、live 传 produce；无 baseline 明确 no_baseline；pending 点如实登记不硬凑。",
    parameters: { type: "object", properties: { task: { type: "string" }, all: { type: "boolean", default: true }, record: { type: "boolean", default: false } } },
    returns: { type: "object", properties: { rates: { type: "object" }, comparison: { type: "object" }, failures: { type: "array" } } },
    agents: ["test_agent"],
  },
  {
    name: "execution.stub", displayName: "外部依赖桩策略", categoryId: "api", permissions: "read", implemented: true,
    summary: "有 stub 声明的依赖不可用 → 该步 inconclusive（downgradable=false 不许转 fail）；无声明仍 fail",
    description: "qa/scripts/execution-stub.mjs + execution-summary.mjs（B6，P1-5）。无 stubs 声明时行为与原实现逐字节一致。",
    parameters: { type: "object", required: ["results"], properties: { results: { type: "array", items: { type: "object" } }, stubs: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { cases: { type: "array" }, downgraded: { type: "array" }, kept_fail: { type: "array" } } },
    agents: ["automation_execution_agent"],
  },
  {
    name: "coverage.split", displayName: "覆盖度拆分", categoryId: "report", permissions: "read", implemented: true,
    summary: "「已执行」与「仅分配」两个口径并排；blocked/skipped 不算已执行",
    description: "qa/scripts/coverage-split.mjs（B8，P2-4）。报表不再把「分配了」当成「测过了」；两口径差异逐条列原因。",
    parameters: { type: "object", required: ["cases"], properties: { cases: { type: "array", items: { type: "object" } }, results: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { coverage_rate: { type: "number" }, optimistic_rate: { type: "number" }, by_layer: { type: "object" }, warnings: { type: "array" } } },
    agents: ["test_report_agent"],
  },
  {
    name: "m1.consistency", displayName: "M1 一致性验收报告", categoryId: "report", permissions: "read", implemented: true,
    summary: "§18.2 四条：N=3 一致率 / 取证包定位 / 耗时记录 / 可读 diff（恒 manual）",
    description: "qa/scripts/consistency-report.mjs（B9）。零失败=not_applicable（不等于满分）；overall 三态 ready / ready_pending_manual / not_ready。真实 run 验证过：not_ready 如实报，不编造通过。",
    parameters: { type: "object", required: ["run_id"], properties: { run_id: { type: "string" }, repeats: { type: "number", default: 3 } } },
    returns: { type: "object", properties: { overall: { type: "string" }, checks: { type: "array" } } },
    agents: ["test_report_agent"],
  },
  {
    name: "data.lifecycle", displayName: "数据生命周期纪律", categoryId: "common", permissions: "read", implemented: true,
    summary: "setup/teardown 强制声明；清理失败进 data_residue 不许静默；无 teardown 只许只读",
    description: "qa/scripts/data-lifecycle.mjs（B11，P1-6）。persistent 基础数据不许用例级增删改；写语义判不出时归 unknown_mutation 列出不计违规。",
    parameters: { type: "object", properties: { datasets: { type: "array", items: { type: "object" } }, plan: { type: "object" }, teardown_results: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { data_residue: { type: "array" }, findings: { type: "array" }, counts: { type: "object" } } },
    agents: ["automation_execution_agent", "test_case_agent"],
  },
  {
    name: "confirm.gate", displayName: "确认卡点三件套", categoryId: "common", permissions: "read", implemented: true,
    summary: "差异聚焦（只审与上版不同）+ 抽样审核（10% 深审，超阈值退回全审）+ 风险加权（P0 全审）",
    description: "qa/scripts/confirm-gate.mjs（B12，P2-2）。抽样确定性可复现（sha256(seed+id)）；缺风险字段按强制全审对待；反绕过核对缺口退出码 1。",
    parameters: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object" } }, previous: { type: "array", items: { type: "object" } }, mode: { type: "string", enum: ["all", "diff", "sample"] }, rate: { type: "number", default: 0.1 }, seed: { type: "string" }, confirmed: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { must_review: { type: "array" }, inherit: { type: "array" }, sampled: { type: "array" }, completion: { type: "object" } } },
    agents: ["test_agent", "requirement_analysis_agent", "test_point_agent", "test_case_agent"],
  },
  {
    name: "expectation.audit", displayName: "预期变更审计", categoryId: "case", permissions: "read", implemented: true,
    summary: "预期结果是资产：改动留 diff 与理由，漂移进报告，与元素库同纪律",
    description: "qa/scripts/expectation-audit.mjs（L-1）。V-40 漂移口径：同一 case 预期一个版本周期改 ≥2 次必须标 drifted 且不进冒烟集（契约 v1.1）。",
    parameters: { type: "object", required: ["case_id"], properties: { case_id: { type: "string" }, history: { type: "array", items: { type: "object" } } } },
    returns: { type: "object", properties: { drifts: { type: "array" }, verdict_cap: { type: "object" } } },
    agents: ["test_case_agent"],
  },
  {
    name: "login.captcha_chain", displayName: "登录与验证码策略链", categoryId: "web", permissions: "read", implemented: true,
    summary: "六类验证码封闭枚举（none/image/slider/click_select/sms/unknown）→ 策略链（万能码→OCR→打码平台→人工）；失败最多重试 1 次防风控锁号",
    description: "aitestharness_tools/exec/login.py（§12.6）+ onboard/bootstrap.py 登录探测。探测零 LLM（DOM 特征规则）；策略执行器为外部服务档位（打码平台/OCR 需项目配置），自动策略用尽即转人工接管（qa 人工接管链路 human-action 已落地）；SessionCache 会话固化是终极解法。",
    parameters: { type: "object", required: ["project", "dom_summary"], properties: { project: { type: "string" }, dom_summary: { type: "object" }, executors: { type: "object" } } },
    returns: { type: "object", properties: { captcha_type: { type: "string" }, status: { type: "string" }, attempts: { type: "array" } } },
    agents: ["automation_execution_agent"],
  },
];

const fail = (message: string): never => { throw new HttpError(400, "invalid_tool", message); };
const notFound = (message: string): never => { throw new HttpError(404, "tool_not_found", message); };

function toolName(value: unknown): string {
  // 点号分隔：工具名要能直接当 agent 的调用标识，且与「分类.能力」的读法一致。
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) return fail("工具名称无效：小写字母开头，可含数字、下划线、点与短横线，最多 64 字符。");
  return value;
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string") return fail(`${label}无效。`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return fail(`${label}无效：不能为空且不超过 ${max} 字符。`);
  return trimmed;
}
function jsonObject(value: unknown, label: string): string {
  if (value === undefined || value === null) return "{}";
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value) as unknown; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(`${label}必须是 JSON 对象。`); return JSON.stringify(parsed); }
    catch { return fail(`${label}不是合法 JSON。`); }
  }
  if (typeof value !== "object" || Array.isArray(value)) return fail(`${label}必须是 JSON 对象。`);
  const encoded = JSON.stringify(value);
  if (encoded.length > 20000) return fail(`${label}过大。`);
  return encoded;
}

type ToolRow = {
  id: string; name: string; display_name: string; summary: string; description: string;
  category_id: string; permissions: string; parameters: string; returns: string;
  version: number; revision: number; enabled: number; builtin: number;
  created_at: string; updated_at: string;
};

export function centralToolRoutes(store: ControlStore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS central_tools(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      summary TEXT NOT NULL, description TEXT NOT NULL, category_id TEXT NOT NULL,
      permissions TEXT NOT NULL CHECK(permissions IN ('read','write')),
      parameters TEXT NOT NULL DEFAULT '{}', returns TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS central_tool_categories(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, builtin INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS central_tool_agents(
      tool_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(tool_id, agent_id));
    CREATE TABLE IF NOT EXISTS central_tool_audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT, tool_id TEXT NOT NULL, action TEXT NOT NULL,
      actor TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  `);
  const seedCategories = db.prepare("INSERT OR IGNORE INTO central_tool_categories(id,name,builtin,deleted,created_at) VALUES (?,?,1,0,'builtin')");
  for (const [id, name] of STAGES) seedCategories.run(id, name);

  // 阶段按 STAGES 的书写顺序排（内置在前），不用 created_at：内置行的插入时间并不表达顺序。
  const stageOrder = new Map(STAGES.map(([id], index) => [id, index]));
  const categories = () => {
    const rows = db.prepare("SELECT id,name,builtin FROM central_tool_categories WHERE deleted=0").all() as { id: string; name: string; builtin: number }[];
    return rows.sort((a, b) => b.builtin - a.builtin || (stageOrder.get(a.id) ?? 99) - (stageOrder.get(b.id) ?? 99));
  };
  const agentMap = () => {
    const rows = db.prepare("SELECT tool_id,agent_id FROM central_tool_agents ORDER BY agent_id").all() as { tool_id: string; agent_id: string }[];
    const map = new Map<string, string[]>();
    for (const row of rows) map.set(row.tool_id, [...(map.get(row.tool_id) ?? []), row.agent_id]);
    return map;
  };
  const stageOf = (id: string) => categories().some(item => item.id === id) ? id : STAGES[0]![0];

  const serialize = (row: ToolRow, agents: Map<string, string[]>) => ({
    id: row.id, name: row.name, displayName: row.display_name, summary: row.summary,
    description: row.description, categoryId: stageOf(row.category_id), permissions: row.permissions,
    parameters: row.parameters, returns: row.returns, version: row.version, revision: row.revision,
    enabled: row.enabled === 1, builtin: row.builtin === 1,
    agents: agents.get(row.id) ?? [], createdAt: row.created_at, updatedAt: row.updated_at,
  });

  // 首启把内置工具登记进来；已存在的行只补「引用关系」，不覆盖管理员改过的字段。
  const seedTools = () => {
    const insert = db.prepare("INSERT OR IGNORE INTO central_tools(id,name,display_name,summary,description,category_id,permissions,parameters,returns,version,revision,enabled,builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,1,?,?)");
    const link = db.prepare("INSERT OR IGNORE INTO central_tool_agents(tool_id,agent_id) VALUES (?,?)");
    for (const item of SEED) {
      const now = new Date().toISOString();
      const id = `tool_${item.name.replace(/[^a-z0-9]/g, "_")}`;
      insert.run(id, item.name, item.displayName, item.summary, item.description, item.categoryId, item.permissions,
        JSON.stringify(item.parameters), JSON.stringify(item.returns), item.implemented ? 1 : 0, item.implemented ? "2026-01-01T00:00:00.000Z" : now, now);
      const row = db.prepare("SELECT id FROM central_tools WHERE name=?").get(item.name) as { id: string } | undefined;
      if (row) for (const agent of item.agents) link.run(row.id, agent);
    }
    // 「规划中 → 已落地」补登记：早期按 implemented:false 入库（默认停用）的工具，
    // 代码落地后刷新 builtin 行的文案与启停状态。只刷新 summary 仍是「（规划中）」模板的行——
    // 管理员改过描述或手动停用的行不动，避免覆盖管理员操作。
    const refresh = db.prepare("UPDATE central_tools SET display_name=?,summary=?,description=?,enabled=1,updated_at=? WHERE name=? AND builtin=1 AND summary LIKE '（规划中）%'");
    for (const item of SEED) refresh.run(item.displayName, item.summary, item.description, new Date().toISOString(), item.name);
  };

  const admin = (c: { var: { user: { isAdmin: boolean } } }) => { if (!c.var.user.isAdmin) throw new HttpError(403, "admin_required", "仅管理员可以管理工具。"); };
  const row = (id: string): ToolRow => {
    const found = db.prepare("SELECT * FROM central_tools WHERE id=?").get(id) as ToolRow | undefined;
    return found ?? notFound("工具不存在。");
  };
  /**
   * 引用关系只接受两类 id：中央已有该 Agent 资源，或本工具当前已引用它。
   * 后者是必要的——内置工具的内置引用（如 `test_agent`）在设计上先于资源导入存在，
   * 若不允许保留，管理员一打开编辑器保存就会把这些引用清空。
   */
  const validAgents = (value: unknown, current: string[] = []): string[] | null => {
    if (value === undefined) return null;
    if (!Array.isArray(value)) return fail("引用 Agent 必须是数组。");
    const known = new Set(store.list(true).filter(resource => resource.kind === "agents").map(resource => String(resource.payload.agentId ?? "")).filter(Boolean));
    const unique = [...new Set(value.map(item => typeof item === "string" ? item : fail("引用 Agent 无效。")) )];
    const unknown = unique.filter(id => !known.has(id) && !current.includes(id));
    if (unknown.length) return fail(`未知的 Agent：${unknown.join("、")}。`);
    return unique;
  };
  const setAgents = (toolId: string, agents: string[]) => {
    db.prepare("DELETE FROM central_tool_agents WHERE tool_id=?").run(toolId);
    const link = db.prepare("INSERT OR IGNORE INTO central_tool_agents(tool_id,agent_id) VALUES (?,?)");
    for (const agent of agents) link.run(toolId, agent);
  };
  const audit = (actor: string, toolId: string, action: string, detail: string) =>
    db.prepare("INSERT INTO central_tool_audit(tool_id,action,actor,detail,created_at) VALUES (?,?,?,?,?)").run(toolId, action, actor, detail, new Date().toISOString());

  /**
   * 引擎根目录。管理后台和引擎同机部署时，它就是那个能跑 `project-action.mjs` 的目录。
   *
   * 只认环境变量，不做「猜一下 cwd」这种推断：猜错的时候会把停用状态写到一个没人读的地方，
   * 表现是「后台点了停用，agent 照样跑」——这比不同步更难查。
   */
  const engineRoot = (): string => (process.env.AITEST_ENGINE_ROOT ?? "").trim();
  const statePath = () => join(engineRoot(), "config", "tool-runtime-state.json");
  const usagePath = () => join(engineRoot(), "output", "runtime", "tool-usage.jsonl");

  /**
   * 把「哪些工具被停用」写给引擎。
   *
   * 这是工具模块从台账变成开关的那一步：`scripts/tool-gate.mjs` 在执行 action 前读这个文件，
   * 硬依赖被停用就拒绝执行。不同步的话，后台的停用按钮只是个画画。
   *
   * 停用列表决定闸门，版本映射写入执行回执，便于与后台契约对账。
   * 写失败不抛错——后台的一次保存不该因为引擎目录不可写而整单回滚，但要留痕。
   */
  const syncRuntimeState = (): void => {
    const root = engineRoot();
    if (!root) return;
    try {
      const tools = db.prepare("SELECT name,version,enabled FROM central_tools ORDER BY name").all() as { name: string; version: number; enabled: number }[];
      const disabled = tools.filter(item => item.enabled === 0).map(item => item.name);
      const versions = Object.fromEntries(tools.map(item => [item.name, item.version]));
      const path = statePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ version: 1, updated_at: new Date().toISOString(), disabled, versions }, null, 2)}\n`, "utf8");
    } catch (error) {
      console.warn(`[tools] 运行期状态未同步到引擎：${(error as Error).message}`);
    }
  };

  /**
   * 每条工具在运行期管着哪些 action——由引擎侧的 `scripts/tool-gate.mjs` 给出。
   *
   * 这份映射只有一份，放在执行路径上。后台再抄一份必然会漂：改了代码忘了改后台，
   * 于是后台显示「这条工具管 12 个 action」，实际只管 8 个，比不显示更糟。
   * 所以在同机部署下直接读引擎的模块导出；读不到就返回 null，前端不显示这一块。
   */
  let bindingCache: { at: number; value: Record<string, { hard: string[]; soft: string[] }> | null } | null = null;
  const loadBindings = async (): Promise<Record<string, { hard: string[]; soft: string[] }> | null> => {
    const root = engineRoot();
    if (!root) return null;
    // 30 秒缓存：模块本身是纯常量，不必每次请求都重新加载，但要短到改完代码能看见。
    if (bindingCache && Date.now() - bindingCache.at < 30_000) return bindingCache.value;
    try {
      const module = await import(pathToFileURL(join(root, "scripts", "tool-gate.mjs")).href) as {
        bindingSummary?: () => Record<string, { hard: string[]; soft: string[] }>;
      };
      const value = typeof module.bindingSummary === "function" ? module.bindingSummary() : null;
      bindingCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      console.warn(`[tools] 读取引擎绑定表失败：${(error as Error).message}`);
      bindingCache = { at: Date.now(), value: null };
      return null;
    }
  };

  /** 读回引擎侧的调用流水，聚合后给后台展示。读不到就当没有——观测数据不参与风控。 */
  const readUsage = (): { total: number; per_tool: Record<string, number>; per_action: Record<string, number>; last_at: string | null } => {
    const empty = { total: 0, per_tool: {}, per_action: {}, last_at: null };
    const root = engineRoot();
    if (!root || !existsSync(usagePath())) return empty;
    const perTool: Record<string, number> = {};
    const perAction: Record<string, number> = {};
    let total = 0;
    let lastAt: string | null = null;
    try {
      for (const line of readFileSync(usagePath(), "utf8").split("\n")) {
        if (!line.trim()) continue;
        let row: { kind?: unknown; receipt?: unknown; at?: unknown; action?: unknown; tools?: unknown };
        try { row = JSON.parse(line); } catch { continue; }
        if (row.kind !== "execution" || typeof row.receipt !== "string" || typeof row.at !== "string") continue;
        total += 1;
        if (!lastAt || row.at > lastAt) lastAt = row.at;
        for (const name of Array.isArray(row.tools) ? row.tools : []) {
          if (typeof name === "string") perTool[name] = (perTool[name] ?? 0) + 1;
        }
        if (typeof row.action === "string") perAction[row.action] = (perAction[row.action] ?? 0) + 1;
      }
    } catch { return empty; }
    return { total, per_tool: perTool, per_action: perAction, last_at: lastAt };
  };

  // 启动时同步一次：库里已经停用的工具，引擎侧可能还没有状态文件（比如刚部署完）。
  seedTools();
  syncRuntimeState();

  app.get("/admin", async c => {
    admin(c);
    seedTools();
    const agents = agentMap();
    const bindings = await loadBindings();
    const usage = readUsage();
    const rows = db.prepare("SELECT * FROM central_tools ORDER BY builtin DESC, created_at, name").all() as ToolRow[];
    // 每条工具带上「管着哪些 action」和「被调了多少次」——
    // 这两列是回答「停用它会发生什么」「它到底有没有用」的唯一依据。
    return c.json({
      enforced: engineRoot() !== "" && existsSync(statePath()),
      engine_configured: engineRoot() !== "",
      bindings_available: bindings !== null,
      tools: rows.map(item => ({
        ...serialize(item, agents),
        bindings: bindings?.[item.name] ?? null,
        calls: usage.per_tool[item.name] ?? 0,
      })),
      categories: categories(),
    });
  });

  /**
   * 工具在运行面被调用的次数。
   *
   * 台账能回答「有没有登记」，只有这个能回答「有没有用」。一条纪律型工具挂了三个月没人调用，
   * 说明它不在任何阶段的必经路径上——那才是真问题。
   */
  app.get("/admin/usage", c => {
    admin(c);
    const usage = readUsage();
    return c.json({
      ...usage,
      enforced: engineRoot() !== "" && existsSync(statePath()),
      engine_configured: engineRoot() !== "",
      note: engineRoot() === "" ? "未配置 AITEST_ENGINE_ROOT，工具状态与调用次数都无法与引擎同步；此时后台的启停不会拦住 Agent。" : null,
    });
  });

  app.get("/admin/:id/executions", c => {
    admin(c);
    const target = row(c.req.param("id"));
    if (!engineRoot() || !existsSync(usagePath())) return c.json({ entries: [] });
    const entries: { at: string; runId: string | null; stage: string | null; receipt: string; implementationSha256: string | null }[] = [];
    try {
      for (const line of readFileSync(usagePath(), "utf8").split("\n")) {
        if (!line.trim()) continue;
        let item: Record<string, unknown>;
        try { item = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (item.kind !== "execution" || !Array.isArray(item.tools) || !item.tools.includes(target.name)
          || typeof item.at !== "string" || typeof item.receipt !== "string") continue;
        entries.push({ at: item.at, runId: typeof item.run_id === "string" ? item.run_id : null,
          stage: typeof item.stage === "string" ? item.stage : null, receipt: item.receipt,
          implementationSha256: typeof item.implementation_sha256 === "string" ? item.implementation_sha256 : null });
      }
    } catch { return c.json({ entries: [] }); }
    return c.json({ entries: entries.slice(-50).reverse() });
  });


  app.get("/admin/:id", c => {
    admin(c);
    return c.json(serialize(row(c.req.param("id")), agentMap()));
  });

  app.get("/admin/:id/audit", c => {
    admin(c);
    const target = row(c.req.param("id"));
    const rows = db.prepare("SELECT action,actor,detail,created_at FROM central_tool_audit WHERE tool_id=? ORDER BY id DESC LIMIT 50").all(target.id) as { action: string; actor: string; detail: string; created_at: string }[];
    return c.json({ entries: rows.map(item => ({ action: item.action, actor: item.actor, detail: item.detail, createdAt: item.created_at })) });
  });

  app.post("/admin", async c => {
    admin(c);
    const data = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data) return fail("请求体无效。");
    const name = toolName(data.name);
    if (db.prepare("SELECT 1 FROM central_tools WHERE name=?").get(name)) throw new HttpError(409, "tool_exists", "工具名称已存在。");
    const permissions = data.permissions === "write" ? "write" : data.permissions === "read" ? "read" : fail("权限只能是 read 或 write。");
    const now = new Date().toISOString();
    const id = `tool_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    db.prepare("INSERT INTO central_tools(id,name,display_name,summary,description,category_id,permissions,parameters,returns,version,revision,enabled,builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,0,?,?)")
      .run(id, name, text(data.displayName, 60, "显示名称"), text(data.summary, 200, "摘要"), text(data.description ?? data.summary, 4000, "说明"),
        stageOf(String(data.categoryId ?? "")), permissions, jsonObject(data.parameters, "参数契约"), jsonObject(data.returns, "返回结构"),
        data.enabled === false ? 0 : 1, now, now);
    const agents = validAgents(data.agents, []);
    if (agents) setAgents(id, agents);
    audit(c.var.user.userId, id, "create", name);
    syncRuntimeState();
    return c.json(serialize(row(id), agentMap()), 201);
  });

  app.put("/admin/:id", async c => {
    admin(c);
    const target = row(c.req.param("id"));
    const data = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data) return fail("请求体无效。");
    if (typeof data.revision === "number" && data.revision !== target.revision) throw new HttpError(409, "revision_conflict", "工具已变化，请刷新后重试。");
    const permissions = data.permissions === "write" ? "write" : data.permissions === "read" ? "read" : target.permissions;
    const nextDescription = data.description === undefined ? target.description : text(data.description, 4000, "说明");
    const nextSummary = data.summary === undefined ? target.summary : text(data.summary, 200, "摘要");
    const nextDisplay = data.displayName === undefined ? target.display_name : text(data.displayName, 60, "显示名称");
    const nextParameters = data.parameters === undefined ? target.parameters : jsonObject(data.parameters, "参数契约");
    const nextReturns = data.returns === undefined ? target.returns : jsonObject(data.returns, "返回结构");
    const nextCategory = data.categoryId === undefined ? stageOf(target.category_id) : stageOf(String(data.categoryId));
    // 启停既可从编辑页保存，也可从卡片开关切换：两条入口落到同一列，审计里分开记。
    const nextEnabled = data.enabled === undefined ? target.enabled : data.enabled === true ? 1 : 0;
    // 版本只在「Agent 读得到的东西」变了时递增：说明、参数、返回、阶段、权限。
    // 显示名称与摘要只影响后台展示，改它们不该推高版本号——否则版本列全是噪声。
    const changed = nextDescription !== target.description
      || nextParameters !== target.parameters || nextReturns !== target.returns || nextCategory !== target.category_id || permissions !== target.permissions;
    // 版本只在「契约或语义变了」时递增；单纯改引用关系或启停不动版本，否则版本号会被噪声淹没。
    db.prepare("UPDATE central_tools SET display_name=?,summary=?,description=?,category_id=?,permissions=?,parameters=?,returns=?,enabled=?,version=version+?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
      .run(nextDisplay, nextSummary, nextDescription, nextCategory, permissions, nextParameters, nextReturns, nextEnabled, changed ? 1 : 0, new Date().toISOString(), target.id, target.revision);
    const agents = validAgents(data.agents, (agentMap().get(target.id) ?? []));
    if (agents) setAgents(target.id, agents);
    if (nextEnabled !== target.enabled) audit(c.var.user.userId, target.id, nextEnabled ? "enable" : "disable", "");
    audit(c.var.user.userId, target.id, changed ? "update" : "touch", changed ? `v${target.version + 1}` : "");
    // 编辑页也能改启停，两个入口都必须同步，否则从这条路径关掉的工具在引擎侧还开着。
    if (nextEnabled !== target.enabled || changed) syncRuntimeState();
    return c.json(serialize(row(target.id), agentMap()));
  });

  app.post("/admin/:id/toggle", async c => {
    admin(c);
    const target = row(c.req.param("id"));
    const next = target.enabled === 1 ? 0 : 1;
    db.prepare("UPDATE central_tools SET enabled=?, revision=revision+1, updated_at=? WHERE id=?").run(next, new Date().toISOString(), target.id);
    audit(c.var.user.userId, target.id, next ? "enable" : "disable", "");
    // 同步到引擎：这一步才让按钮真的生效，`tool-gate.mjs` 靠它决定要不要放行 action。
    syncRuntimeState();
    return c.json(serialize(row(target.id), agentMap()));
  });

  app.delete("/admin/:id", c => {
    admin(c);
    const target = row(c.req.param("id"));
    // 内置工具删掉，方案里的那条纪律就在后台失去了登记处；停用才是「不生效」的正确表达。
    if (target.builtin === 1) throw new HttpError(409, "builtin_tool", "内置工具不可删除，可将其停用。");
    if ((agentMap().get(target.id) ?? []).length) throw new HttpError(409, "tool_in_use", "仍有 Agent 引用此工具，请先解除引用。");
    db.prepare("DELETE FROM central_tools WHERE id=?").run(target.id);
    db.prepare("DELETE FROM central_tool_audit WHERE tool_id=?").run(target.id);
    audit(c.var.user.userId, target.id, "delete", target.name);
    syncRuntimeState();
    return c.json({ ok: true });
  });

  app.post("/categories", async c => {
    admin(c);
    const data = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = text(data?.name, 40, "分类名称");
    const id = `tcat_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try { db.prepare("INSERT INTO central_tool_categories(id,name,builtin,deleted,created_at) VALUES (?,?,0,0,?)").run(id, name, new Date().toISOString()); }
    catch { throw new HttpError(409, "category_exists", "分类名称已存在。"); }
    return c.json({ id, name }, 201);
  });

  app.put("/categories/:id", async c => {
    admin(c);
    const data = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = text(data?.name, 40, "分类名称");
    try {
      const result = db.prepare("UPDATE central_tool_categories SET name=? WHERE id=? AND deleted=0").run(name, c.req.param("id"));
      if (!result.changes) throw new HttpError(404, "category_missing", "分类不存在。");
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(409, "category_exists", "分类名称已存在。"); }
    return c.json({ ok: true });
  });

  app.delete("/categories/:id", c => {
    admin(c);
    const id = c.req.param("id");
    const found = db.prepare("SELECT builtin FROM central_tool_categories WHERE id=? AND deleted=0").get(id) as { builtin: number } | undefined;
    if (!found) throw new HttpError(404, "category_missing", "分类不存在。");
    if (found.builtin) throw new HttpError(409, "builtin_category", "内置阶段不可删除。");
    if (db.prepare("SELECT 1 FROM central_tools WHERE category_id=?").get(id)) throw new HttpError(409, "category_not_empty", "请先移走此分类下的工具。");
    db.prepare("UPDATE central_tool_categories SET deleted=1 WHERE id=?").run(id);
    return c.json({ ok: true });
  });

  /**
   * 运行期消费口：只给已启用的工具，且不带审计与内部字段。
   *
   * `enforced` 是这次接入的关键信息：它说明引擎侧的状态文件确实写下去了，
   * 停用在这个部署里是**真的会拦住调用**，而不只是后台变个颜色。
   */
  app.get("/catalog", c => {
    const agents = agentMap();
    const rows = db.prepare("SELECT * FROM central_tools WHERE enabled=1 ORDER BY category_id, name").all() as ToolRow[];
    return c.json({
      enforced: engineRoot() !== "" && existsSync(statePath()),
      tools: rows.map(item => ({
        name: item.name, displayName: item.display_name, summary: item.summary, description: item.description,
        categoryId: stageOf(item.category_id), permissions: item.permissions, version: item.version,
        parameters: item.parameters, returns: item.returns, agents: agents.get(item.id) ?? [],
      })),
    });
  });

  return app;
}
