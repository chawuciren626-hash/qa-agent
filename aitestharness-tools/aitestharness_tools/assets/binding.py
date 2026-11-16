"""§17.4 两块未接线 Skill 的接线层：把 skill 的「策略描述」落到可执行资产。

背景（§17.4 原话）：`test-asset-management` 与 `test-selection` 定义了但**从未绑定任何
Agent**，缺的不是设计，是接线。本文件就是那根线——它不新增规则，只做两件事：

    1. 把现成工具产出的资产汇总成一份**可核对的状态**（资产清单 + 健康度 + 待办）；
    2. 给出**接线检查**：哪些 agent 应当调用哪些资产接口，实际有没有调。

为什么需要一个单独文件而不是散在各处：
    「skill 接上了没有」这件事如果没有代码承载，就永远只能靠人记得。而 skills 的价值
    恰恰在于"每轮都被用到"，不被调用的 skill 等于不存在（现有工程 15 个 skill 里就有
    两个是这样）。

零 LLM：只读资产、算健康度、列缺口。
"""
from __future__ import annotations

from ..assets.library import (DataSetStore, ElementLibrary, FragmentLibrary,
                              health_score)

__all__ = ["ASSET_SKILL_BINDINGS", "asset_health_report", "binding_audit",
           "knowledge_to_assets"]

# 「哪个角色应当用哪个资产接口」——写成表而不是写进提示词，
# 因为写进提示词就会被 agent 各自解释（§5.5：重叠的根因是规则散在提示词里）。
ASSET_SKILL_BINDINGS: dict[str, list[dict]] = {
    "test-asset-management": [
        {"agent": "test_case_agent", "tool": "assets.ElementLibrary.resolve",
         "why": "步骤里的元素必须是 element_ref，禁止内联指纹（改一处全生效）"},
        {"agent": "test_case_agent", "tool": "assets.DataSetStore.get",
         "why": "用例只记 dataset_ref，不内嵌数据值"},
        {"agent": "automation_execution_agent", "tool": "assets.ElementLibrary.record_hit",
         "why": "定位命中第几个指纹必须记账（降级必留痕，§12.3）"},
        {"agent": "automation_execution_agent", "tool": "assets.ElementLibrary.resolve",
         "why": "运行时由库展开指纹序列，环境变体自动生效"},
        {"agent": "defect_analysis_agent", "tool": "assets.ElementLibrary.get",
         "why": "归因时判断是元素失效还是业务 bug"},
        {"agent": "default_agent(探索)", "tool": "assets.FragmentLibrary.register",
         "why": "探索沉淀登录/流程为片段，而非每次重录"},
    ],
    "test-selection": [
        {"agent": "test_agent", "tool": "regression.plan_regression.plan_regression",
         "why": "回归计划必须五源可解释，不能只说 AI 选了 42 条"},
        {"agent": "test_agent", "tool": "regression.plan_regression.admission_with_coverage",
         "why": "准入结论需要影响覆盖度，而它依赖选集结果"},
    ],
}


def asset_health_report(elements: ElementLibrary | None = None,
                        fragments: FragmentLibrary | None = None,
                        datasets: DataSetStore | None = None) -> dict:
    """资产库体检：给「资产健康度」这一指标提供真实输入（§13.4 三指标之一）。

    没有真实资产时**必须返回 None 而不是默认值**——用 0 或不填会让准入结论
    「看似有依据」，这比不给结论更危险。
    """
    el_list = elements.listing() if elements is not None else []
    scores = [health_score(e)["score"] for e in el_list]
    poor = [e["id"] for e in el_list if health_score(e)["grade"] == "poor"]
    warn = [e["id"] for e in el_list if health_score(e)["grade"] == "warn"]

    frag_json = fragments.to_json() if fragments is not None else {"fragments": {}}
    frags = frag_json.get("fragments") or {}
    no_contract = [f["key"] for f in frags.values()
                   if f.get("inputs") is None or f.get("outputs") is None]

    ds_json = datasets.to_json() if datasets is not None else {"datasets": {}}
    ds = ds_json.get("datasets") or {}

    if not el_list and not frags and not ds:
        return {"asset_health": None,
                "available": False,
                "reason": "no_asset（资产库为空，不能拿默认值参与准入判定）",
                "advice": "先跑建档与探索沉淀资产，再谈准入结论"}

    # 综合健康度：元素权重最高（它是执行期最先崩的一环）
    parts, weights = [], []
    if scores:
        parts.append(sum(scores) / len(scores) / 100)
        weights.append(0.6)
    if frags:
        parts.append(1 - len(no_contract) / len(frags))
        weights.append(0.2)
    if ds:
        parts.append(1.0)          # 能进库说明已过凭据检查
        weights.append(0.2)
    total_w = sum(weights)
    health = sum(p * w for p, w in zip(parts, weights)) / total_w

    return {
        "asset_health": round(health, 4),
        "available": True,
        "elements": {"count": len(el_list), "avg_score":
                     round(sum(scores) / len(scores), 1) if scores else None,
                     "poor": poor, "warn": warn},
        "fragments": {"count": len(frags), "missing_contract": no_contract},
        "datasets": {"count": len(ds)},
        "advice": ("资产可用" if health >= 0.7 else
                   "资产健康度偏低：先修 poor 元素与缺契约片段，再看准入结论"),
    }


def binding_audit(call_log: list[dict] | None = None) -> dict:
    """接线检查：应当被调用的资产接口，实际被调过没有。

    call_log: [{agent, tool, at}]（编排层把工具调用记成流水；空则只能给出应然清单）
    返回 {missing, covered, note}

    用途：M1 第 1、2 步验收——「接上了」不能靠口头确认，得有一张对不上的表。
    """
    require = [(b["agent"], b["tool"]) for items in ASSET_SKILL_BINDINGS.values()
               for b in items]
    called = {(c.get("agent"), c.get("tool")) for c in (call_log or [])}
    missing = [{"agent": a, "tool": t, "why": why}
               for items in ASSET_SKILL_BINDINGS.values()
               for b in items
               for a, t, why in [(b["agent"], b["tool"], b["why"])]
               if (a, t) not in called]
    return {
        "required": len(require),
        "covered": len(require) - len(missing),
        "missing": missing,
        "note": ("未提供调用流水，以下仅为应然清单" if not call_log
                 else ("全部接线" if not missing else f"{len(missing)} 处未接线")),
    }


def knowledge_to_assets(knowledge: dict) -> dict:
    """知识层 → 资产层的可机器消费视图（不改知识库本身）。

    为什么要转：knowledge 里是「人写的业务真相」，资产层需要的是「按控件类型归拢的
    约束」。测试点矩阵消费的是后者。直接让 agent 现读 knowledge 会每轮重复解释一遍。
    """
    by_control: dict[str, list[dict]] = {}
    for it in knowledge.get("items") or []:
        tags = {str(t) for t in it.get("tags") or []}
        for t in tags:
            if t in ("input", "select", "button", "table", "upload", "datepicker",
                     "captcha", "textarea", "checkbox", "radio", "login", "api"):
                by_control.setdefault(t, []).append({
                    "knowledge_id": it["id"], "type": it["type"],
                    "name": it["name"], "statement": it["statement"],
                })
    return {
        "by_control_type": by_control,
        "control_types_covered": sorted(by_control),
        "unused_knowledge": [it["id"] for it in knowledge.get("items") or []
                             if not ({str(t) for t in it.get("tags") or []}
                                     & set(by_control))],
        "note": "本视图只做索引，不复制正文；正文以 knowledge/**/*.json 为准",
    }
