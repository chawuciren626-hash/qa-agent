"""模型能力画像（v3 §10.9）：LLM 能力由**用户自己配置的模型**决定。

为什么需要这个模块：
    方案里"LLM 只做四类不可形式化的事"是**架构边界**，但每件事具体交给模型多少，
    取决于用户配的是哪档模型——8B 本地模型和 GPT/Claude 顶级模型能承担的量差一个
    数量级。如果流程写死"必须让 LLM 补齐测试点/自动生成步骤"，配小模型的用户会
    在第一步就卡死，然后把工具弃用。

破局办法：把 LLM 的活全部改成**可降级任务**——
    - 强模型：Advisor 自动产出，人工只审；
    - 弱模型：程序给结构化强约束（枚举候选、骨架、模板），LLM 只做选择/填空，
      甚至直接关掉（`manual_only`），由人工在骨架里填。
    无论哪档，**下游契约与校验链完全相同**（IR 不变、五闸不变、分权表不变）——
    模型只影响"谁来填这些字段"，不影响"字段必须满足什么"。

设计约束：
    - 本模块是确定性策略计算，零 LLM、零网络；
    - 只决定"任务怎么做"，不决定"产物长什么样"（那是 IR 契约的事）；
    - 模型每次回复都可能不同，能力画像由**实测标定**得出，不是自报。
"""
from __future__ import annotations

__all__ = [
    "TIERS", "TASKS", "PROFILES", "detect_signals", "calibrate",
    "profile_for", "plan_tasks", "TaskPlanError",
]

# ---- 能力档位：按"能否稳定完成指令跟随 + 结构化输出"划分，不按参数规模 ----
TIERS = {
    "S": "强（在线顶级模型）：可承担开放式抽取与归因，输出结构自洽",
    "A": "中（主流在线模型）：结构化任务可靠，开放式任务需强约束+重试",
    "B": "弱（小参数/量化/本地模型）：仅能在受限候选集里选择，长上下文易丢约束",
    "N": "不可用（未配置/离线/调用失败）：全部退化为人工或纯规则",
}

# ---- LLM 承担的四类任务（与方案"LLM 只在四处出现"对应），每类含三个能力位 ----
#   extract：从大段文本里抽取并归一化（指令跟随 + 引用能力）
#   reasoning：多步推理与归因（逻辑链长度）
#   structured：稳定输出符合 schema 的结构（JSON/YAML 严格性）
#   long_ctx：长上下文不丢中段约束
TASKS = {
    "requirement_extract": {          # §10.2 Advisor：需求项抽取
        "needs": {"extract": 3, "structured": 3, "long_ctx": 4},
        "fallback": "条款切分后逐条人工确认 / 规则模板抽取（有 OpenAPI 时优先解析器）",
    },
    "testpoint_fill": {               # §10.3 Advisor：测试点补齐（只补矩阵缺口格）
        "needs": {"reasoning": 2, "structured": 3},
        "fallback": "知识库映射直接产出 + 人工按缺口清单勾选",
    },
    "case_step_fill": {               # §10.4 Advisor：步骤补全（禁止写断言）
        "needs": {"structured": 3, "extract": 2},
        "fallback": "骨架+枚举候选（动作/等待类型/定位策略白名单）让 LLM 只选；弱档转人工填骨架",
    },
    "failure_attribution": {          # 失败归因（product_bug/script/env/data/flaky）
        "needs": {"reasoning": 3, "structured": 2},
        "fallback": "按 §14.3 可疑信号规则表做确定性归因，人工复核",
    },
    "report_insight": {               # §16 报告审阅：洞察（数字只读、必须挂引用）
        "needs": {"extract": 2, "reasoning": 3, "long_ctx": 3},
        "fallback": "只出 facts（程序生成）+ 风险台账机械汇总，洞察留空（允许空输出）",
    },
}

# ---- 档位 → 能力位得分（1~4）。实测标定默认值，可被 calibrate() 覆盖 ----
PROFILES = {
    "S": {"extract": 4, "reasoning": 4, "structured": 4, "long_ctx": 4},
    "A": {"extract": 3, "reasoning": 3, "structured": 4, "long_ctx": 3},
    "B": {"extract": 2, "reasoning": 2, "structured": 2, "long_ctx": 1},
    "N": {"extract": 1, "reasoning": 1, "structured": 1, "long_ctx": 1},
}


class TaskPlanError(ValueError):
    """任务名不在 TASKS 白名单（防止编排层随手加"让 LLM 自由发挥"的任务）。"""


def _score(profile: dict, needs: dict) -> int:
    """任务适配分 = 最短板（LLM 任务几乎都是 weakest-link 决定成败）。"""
    return min(profile.get(k, 1) for k in needs)


def profile_for(declared: str, calibrated: dict | None = None) -> dict:
    """取生效画像：实测标定优先于声明档位。

    为什么要实测：模型会更新、量化版本会退化、API 会限流降级。管理员自报"我配的是
    强模型"而实际被降级，会导致流程按 S 档跑但产出质量按 B 档——最难排查的故障。
    """
    base = dict(PROFILES.get((declared or "N").upper(), PROFILES["N"]))
    if calibrated:
        for k, v in calibrated.items():
            if k in base:
                base[k] = max(1, min(4, int(v)))
    return base


def detect_signals(responses: list[dict]) -> dict:
    """从历史交互里提取确定性退化信号（零 LLM，纯统计）。

    responses: [{"task": str, "ok": bool, "schema_valid": bool | None,
                 "citation_ok": bool | None, "latency_ms": int | None, "error": str | None}]
    返回 {"degraded": bool, "reasons": [...], "suggest_tier": "S|A|B|N", "sample": n}
    """
    n = len(responses or [])
    if n == 0:
        return {"degraded": True, "reasons": ["no_sample"], "suggest_tier": "N",
                "sample": 0}
    errors = [r for r in responses if r.get("error")]
    schema_bad = [r for r in responses if r.get("schema_valid") is False]
    cite_bad = [r for r in responses if r.get("citation_ok") is False]
    ok_rate = sum(1 for r in responses if r.get("ok")) / n
    reasons = []
    if len(errors) / n >= 0.3:
        reasons.append("high_error_rate")
    if len(schema_bad) / n >= 0.2:
        reasons.append("schema_instability")
    if len(cite_bad) / n >= 0.2:
        reasons.append("citation_missing")
    if ok_rate < 0.6:
        reasons.append("low_success_rate")
    if reasons:
        # 有失败但还能出结果 → 降一档（B）；连结果都出不来 → N
        tier = "N" if ok_rate < 0.3 or len(errors) / n >= 0.5 else "B"
        return {"degraded": True, "reasons": reasons, "suggest_tier": tier,
                "sample": n, "ok_rate": round(ok_rate, 3)}
    return {"degraded": False, "reasons": [], "suggest_tier": None,
            "sample": n, "ok_rate": round(ok_rate, 3)}


def calibrate(declared: str, responses: list[dict]) -> dict:
    """标定结果：声明档位 + 实测信号 → 生效画像。

    退化时**只降不升**：实测只能证明"比声明的更差"，无法证明更好（样本可能太简单）。
    """
    base_tier = (declared or "N").upper()
    sig = detect_signals(responses)
    tier = base_tier
    if sig["degraded"] and sig["suggest_tier"]:
        order = ["N", "B", "A", "S"]
        idx = min(order.index(base_tier) if base_tier in order else 0,
                  order.index(sig["suggest_tier"]))
        tier = order[idx]
    return {"declared": base_tier, "effective": tier, "signals": sig,
            "profile": profile_for(tier)}


def plan_tasks(effective_tier: str, calibrated: dict | None = None) -> dict:
    """按生效档位为五类任务分配执行模式。

    每类任务返回四要素：
      mode       —— auto（LLM 自动）/ assisted（强约束下 LLM 辅助）/ manual（人工）
      constraint —— assisted/auto 下的约束强度（给编排层拼提示词用）
      needs      —— 该任务的能力要求（可解释"为什么降级"）
      fallback   —— manual 时的确定性替代路径
      reason     —— 一句话说明（进报告，让用户知道"为什么这一步要我自己填"）
    """
    prof = profile_for(effective_tier, calibrated)
    out = {}
    for task, spec in TASKS.items():
        needs = spec["needs"]
        score = _score(prof, needs)
        short = [k for k in needs if prof.get(k, 1) < needs[k]]
        if score >= 3:
            mode, constraint = "auto", "schema_only"
        elif score == 2:
            mode, constraint = "assisted", "strict_candidates"
        else:
            mode, constraint = "manual", "skeleton"
        out[task] = {
            "mode": mode, "constraint": constraint, "needs": needs,
            "score": score, "short_of": short,
            "fallback": spec["fallback"],
            "reason": ("能力满足，自动产出（仍需人工确认卡点）" if mode == "auto"
                       else f"能力不足项 {short}，改为{('强约束辅助' if mode == 'assisted' else '人工填骨架')}"),
        }
    n_auto = sum(1 for v in out.values() if v["mode"] == "auto")
    # 长上下文缺口 → 强制分片（不改 mode，改喂法：能力够但一次喂不下）
    split = {t: (prof.get("long_ctx", 1) < spec["needs"]["long_ctx"])
             for t, spec in TASKS.items() if "long_ctx" in spec["needs"]}
    return {"tier": effective_tier, "profile": prof, "tasks": out,
            "auto_count": n_auto, "split_required": split,
            "summary": f"{effective_tier} 档：{n_auto}/{len(out)} 类任务可自动产出，"
                       f"其余走强约束辅助或人工（产物契约与校验链不变）"}
