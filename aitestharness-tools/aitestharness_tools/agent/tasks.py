"""Agent 契约层：把「agent 能干什么、该调什么、越权怎么拦、做不了怎么报」收敛到一处。

为什么需要这一层：
    方案里"权限收窄"散落在 §17.3 / §10.9 / §12.8 / §16.2 好几章，实现却分散在
    ownership / model_capability / context_assembler 三个模块里。编排层要拦一个越权
    的 agent，得自己记住"先剥离字段、再查 gates、还要看版本戳"——这种"记得"就是
    下一个漏洞的来源（§11.10 那次一致性事故就是这么来的）。

本层只做粘合，不新增规则：
    1. TASK_CONTRACTS  —— 任务派发单：输入吃什么、输出哪几个必须字段、可调哪些工具
    2. dispatch         —— 组装一次任务（上下文 + 工具白名单 + 降级说明），agent 拿到即可干活
    3. submit           —— 收产物：剥离越权字段 → 契约校验 → 越权/缺失分开报
    4. explain_degrade  —— 降级必须说出来（§10.9.5），文案在这里统一生成

三条硬纪律：
    · agent **拿不到**不在 `tools` 白名单里的工具（不是"不建议用"，是调用即拒）；
    · agent **写不进** program / exec_fact 字段（剥离 + 留痕，见 ownership）；
    · agent **不必装懂**：`manual` 档直接返回 fallback，不发起模型调用。
"""
from __future__ import annotations

from ..common.context_assembler import assemble
from ..common.model_capability import TaskPlanError, plan_tasks
from ..irval import errors as E
from ..irval.ownership import strip_forbidden

__all__ = ["TASK_CONTRACTS", "CONTRACT_TASKS", "dispatch", "submit",
           "explain_degrade", "contract_of", "task_catalog"]

# 每类任务的派发契约。
#   task        —— 必须是 model_capability.TASKS 里的键（白名单，防随手新增"自由发挥"任务）
#   stage       —— 该任务落在哪个阶段；阶段工具只在对应阶段可调（stage-tool-runtime 硬校验）
#   inputs      —— 输入产物 kind（来自 plan.phases 的产物命名）
#   scope_keys  —— 上下文装配允许的 scope 键（防止 agent 顺手把整库塞进来）
#   tools       —— 允许调用的**阶段工具 id**（= stage-tool-runtime.STAGE_TOOLS 的 key）。
#                  不是 Python 函数名：agent 唯一的调用入口是 `run_stage_tool` 的 tool_id，
#                  写成 `module.func` 的下游一个也调不通（本文件 2026-11-19 之前就是这样，
#                  12 条声明里只有 4 条能对上，其余的在 prompt 里只是噪声）。
#                  真源是 STAGE_TOOLS；`scripts/check-tool-contract.mjs` 的 B1/B2 会断言
#                  「这里 ⊆ STAGE_TOOLS ⊆ MCP tools/list」，漂了 CI 就红。
#   budget_tokens —— 单次派发的 token 上限；on_exceed 是超限行为（degrade 降级给程序兜底 /
#                   abort 中止由人接手）。两者都必须显式写：不写就等于"超了随便"，
#                   而长上下文阶段（报告、归因）的成本失控正是这么来的。
#   must / must_not —— 产物里必须有的 / 绝对不能有的字段（must_not 给的是"会误导下游"的字段）
TASK_CONTRACTS: dict[str, dict] = {
    "requirement_extract": {
        "title": "需求项抽取",
        "agent": "requirement_analysis_agent",
        "budget_tokens": 12000,
        "on_exceed": "degrade",
        "stage": "analysis",
        "inputs": ["条款列表（split_clauses 产出）"],
        "scope_keys": ("modules", "keywords"),
        "tools": ("requirement.testability", "requirement.acceptance", "irval.check"),
        "must": ["items"],
        "must_not": ["approved_by"],          # 批准是人签的
        "notes": "输入只能是条款；每条必须挂原文位置；抽不出位置的丢弃，不要猜",
    },
    "testpoint_fill": {
        "title": "测试点缺口补齐",
        "agent": "test_point_agent",
        "budget_tokens": 8000,
        "on_exceed": "degrade",
        "stage": "test_points",
        "inputs": ["requirements", "matrix（程序算好的空矩阵）"],
        "scope_keys": ("modules", "keywords", "pages"),
        "tools": ("testpoint.coverage", "irval.check"),
        "must": ["items"],
        "must_not": ["matrix", "coverage"],   # 矩阵与覆盖度是程序算的，agent 不许改
        "notes": "只填 gaps 列的格子；不许新增格子；验证方式由程序按矩阵分配",
    },
    "case_step_fill": {
        "title": "用例步骤补全",
        "agent": "test_case_agent",
        "budget_tokens": 10000,
        "on_exceed": "degrade",
        "stage": "test_cases",
        "inputs": ["testpoints", "skeleton（骨架，含断言占位）"],
        "scope_keys": ("pages", "apis", "modules"),
        "tools": ("plan.gates", "irval.check"),
        "must": ["items"],
        "must_not": ["gates"],                # 闸由编译器写
        "notes": "只补 steps 的 intent/action；断言字段一律保留骨架里的引用，不许改写预期",
    },
    "failure_attribution": {
        "title": "失败归因",
        "agent": "defect_analysis_agent",
        "budget_tokens": 12000,
        "on_exceed": "degrade",
        "stage": "defects",
        "inputs": ["exec（含取证包引用）"],
        "scope_keys": ("pages", "apis"),
        "tools": ("defect.evidence", "defect.tools", "irval.check"),
        "must": ["items"],
        "must_not": ["evidence_ref", "verdict"],   # 证据与结论是执行进程的
        "notes": "取证包由程序组装；只写 category 与 confidence；低置信标 low 转人工",
    },
    "report_insight": {
        "title": "报告洞察",
        "agent": "test_report_agent",
        "budget_tokens": 16000,
        "on_exceed": "degrade",
        "stage": "report",
        "inputs": ["facts（程序生成，只读）", "risk_ledger"],
        "scope_keys": ("modules",),
        "tools": ("report.reviewer", "regression.select", "regression.impact", "irval.check"),
        "must": ["insights"],
        "must_not": ["facts", "verdict"],     # 数字与结论只读（§16.2 第一条）
        "notes": "允许空 insights；每条洞察必须挂 facts 引用，否则视为套话",
    },
}

CONTRACT_TASKS = tuple(TASK_CONTRACTS)


def contract_of(task: str) -> dict:
    """取任务契约；不认识的任务直接抛（与 plan_tasks 的白名单同源）。"""
    if task not in TASK_CONTRACTS:
        raise TaskPlanError(
            f"任务 {task!r} 不在契约白名单 {CONTRACT_TASKS}——"
            f"编排层不得随手新增「让 LLM 自由发挥」的任务（§10.9）")
    return TASK_CONTRACTS[task]


def dispatch(task: str, *, tier: str = "A", scope: dict | None = None,
             knowledge: dict | None = None, maps: dict | None = None,
             budget_tokens: int = 8000, calibrated: dict | None = None) -> dict:
    """组装一次 agent 任务。

    返回 {task, mode, runnable, prompt_brief, tools, inputs, context, context_refs,
          constraints, degrade_note}

    `runnable=False` 时**不要调用模型**——直接走 fallback（manual 档）。
    这是产品诚实性的关键：配弱模型的用户在第一步就卡死然后弃用工具，原因就是
    "流程默认 LLM 一定能干"。
    """
    spec = contract_of(task)
    plan = plan_tasks(tier, calibrated)
    mode = (plan.get("tasks") or {}).get(task) or {}
    runnable = mode.get("mode") in ("auto", "assisted")

    scope = scope or {}
    unknown = [k for k in scope if k not in spec["scope_keys"]]
    ctx = assemble(scope={k: v for k, v in scope.items() if k in spec["scope_keys"]},
                   knowledge=knowledge, maps=maps, budget_tokens=budget_tokens)

    constraints = [spec["notes"]]
    if mode.get("mode") == "assisted":
        constraints.append(
            f"assisted 档：只能从候选集里选择，不自由生成"
            f"（候选由程序拼入提示词：动作类型 / 等待类型 / 定位策略白名单 / 维度清单）")
    if mode.get("constraint"):
        constraints.append(str(mode["constraint"]))
    constraints.append(f"必须字段 {spec['must']}；禁止写 {spec['must_not']}（会被剥离并留痕）")

    return {
        "task": task,
        "agent": spec["agent"],
        "stage": spec["stage"],
        "tier": tier,
        "mode": mode.get("mode"),
        "runnable": runnable,
        "inputs": spec["inputs"],
        "tools": list(spec["tools"]),
        "budget_tokens": spec["budget_tokens"],
        "on_exceed": spec["on_exceed"],
        "context": ctx.get("context"),
        "context_refs": ctx.get("context_refs"),
        "context_dropped": ctx.get("dropped") or [],
        "constraints": constraints,
        "degrade_note": explain_degrade(task, plan),
        "ignored_scope_keys": unknown,
        "fallback": mode.get("fallback") or spec.get("fallback"),
    }


def submit(task: str, payload: dict, *, writer: str) -> dict:
    """收 agent 产物：先剥离越权字段，再做契约校验。

    返回 {accept, cleaned, stripped, missing, findings, advice}
      accept=False 时编排层必须阻塞（不是告警，不是"先入库后修"）。

    为什么剥离而不是拒绝：拒绝会让 agent 反复重试同一个错；剥离 + 明确告知
    "这个字段你没权限"能让它自己修正。但**必须留痕**，否则越权尝试就没人知道。
    """
    spec = contract_of(task)
    if not str(writer).startswith("agent:"):
        return {"accept": False, "cleaned": payload, "stripped": [], "missing": [],
                "findings": [], "advice": f"submit 只收 agent 产物，收到 {writer!r}"}

    cleaned, perm = strip_forbidden(dict(payload or {}), writer)
    stripped = [f.field for f in perm.findings] if not perm.accepted else []

    missing = [k for k in spec["must"]
               if k not in cleaned or cleaned[k] is None or cleaned[k] == ""]
    bad = [k for k in cleaned if k in spec["must_not"]]
    # must_not 同时是越权字段的子集时已剥离，剩下的是"字段本身合法但不该由你写"
    for k in bad:
        cleaned.pop(k, None)

    findings = [
        {"code": "STRIPPED_BY_PERMISSION", "field": f,
         "message": f"`{f}` 是程序/人工专属字段，已剥离（越权尝试已记录）"}
        for f in stripped
    ] + [
        {"code": "FIELD_NOT_OWNED", "field": k,
         "message": f"`{k}` 不属于 {spec['agent']} 的产出边界，已移除（下游会被误导）"}
        for k in bad
    ]

    accept = not missing
    return {
        "accept": accept,
        "task": task,
        "agent": writer,
        "cleaned": cleaned,
        "stripped": stripped,
        "missing": missing,
        "findings": findings,
        "advice": ("产物通过契约校验，可入下一阶段"
                   if accept else
                   f"缺必需字段 {missing}：阻塞，不允许进入下一阶段（§5.3）"),
        "blocked": accept is False,
    }


def explain_degrade(task: str, plan: dict | None = None) -> str | None:
    """降级说明文案（§10.9.5：降级必须写在报告里，不能静默发生）。

    不写这句话的后果很实：用户以为"AI 分析了"，实际拿到半成品，
    最后结论是"这工具不准"——而真相是模型不够，跟工具无关。
    """
    if plan is None:
        return None
    t = (plan.get("tasks") or {}).get(task)
    if not t or t.get("mode") == "auto":
        return None
    if t.get("mode") == "manual":
        return (f"本次「{TASK_CONTRACTS.get(task, {}).get('title', task)}」为**人工模式**："
                f"当前模型在该任务能力不足（{t.get('reason') or '未达基准'}）。"
                f"建议：换用在线模型，或按 fallback 手动完成——{t.get('fallback')}")
    return (f"本次「{TASK_CONTRACTS.get(task, {}).get('title', task)}」为**强约束模式**："
            f"只能从候选集选择（{t.get('reason') or '能力差一项'}）。"
            f"结果需人工复核，原因：{t.get('constraint')}")


def task_catalog() -> list[dict]:
    """给管理端 / 文档用的任务清单（agent、输入、工具、禁写字段、LLM 任务键）。"""
    return [{"task": k, "title": v["title"], "agent": v["agent"],
             "inputs": v["inputs"], "tools": list(v["tools"]),
             "must": v["must"], "must_not": v["must_not"],
             "notes": v["notes"]} for k, v in TASK_CONTRACTS.items()]
