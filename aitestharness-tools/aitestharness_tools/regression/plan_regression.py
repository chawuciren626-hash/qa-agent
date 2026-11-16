"""§13 回归编排：回答回归集必须回答的三个问题（§13.1）。

现有 `selector.py` 与 `impact.py` 各自只答一题——一个是三档选集、一个是五源触发，
但它们**从没被串起来**，中间还缺一环：影响覆盖度。结果是「选了 42 条」这种输出会被
直接质疑「你只跑了 30 条，凭什么叫能上线」。

本文件补的是这个缺口，做一条完整的问答链：

    ① 这次该跑哪些？        plan_regression  → 五源可解释选集 + 三档裁剪
    ② 跑完能不能说没问题？   admission_with_coverage → 需求覆盖 + 影响覆盖 + 资产健康
    ③ 没跑的用例风险是什么？  同上返回 untested_risks（按可靠性排序，逐条给理由）

三条设计纪律：
    · **选集与判定分离**：第五源（历史相似）只选不判，任何"AI 觉得像"都不进结论；
    · **未选中不代表无风险**：输出必须显式列出未测项，否则等于隐瞒；
    · **资产健康度不可用就拒绝给结论**，不拿默认值凑数（§13.4 第三条）。

零 LLM：全部是集合运算与可解释记账。
"""
from __future__ import annotations

from ..common.version import VERSION_CHANGED, stamps_differ

__all__ = ["SOURCE_TRUST", "plan_regression", "impact_coverage",
           "admission_with_coverage", "regression_three_answers"]

# 五源可靠性（§13.2 原文顺序，数字越小越可信）
SOURCE_TRUST = {"explicit": 0, "requirement_change": 1, "code_change": 2,
                "dependency": 3, "history_similar": 4}

# 只有这几个源算「可信影响」，history_similar 只补漏、不计入影响覆盖度分子
_TRUSTED = {"explicit", "requirement_change", "code_change", "dependency"}


def _norm_pages(xs) -> set[str]:
    return {str(x).strip() for x in (xs or []) if str(x).strip()}


def plan_regression(cases: list[dict], *,
                    tier: str = "core",
                    explicit_ids: list[str] | None = None,
                    changed_requirements: list[str] | None = None,
                    changed_modules: list[str] | None = None,
                    changed_fragments: list[str] | None = None,
                    changed_pages: list[str] | None = None,
                    changed_apis: list[str] | None = None,
                    similar_cases: list[str] | None = None,
                    maps_diff: dict | None = None,
                    quarantine_ids: set[str] | None = None,
                    budget_s: int | None = None) -> dict:
    """五源选集 → 三档裁剪，一次性出**可解释的回归计划**。

    cases: [{id, risk, tags, execs, assertions, quarantine, status,
             derived_from_requirements, modules, fragments, touched:{pages,apis}}]

    与单纯调用 select_by_change 的区别（都是实测出来的坑）：
      1. **touched 也算影响源**（§13.5 B 路主路）：代码改了订单接口，用例的 touched
         里有它就该跑——这条最准，因为它来自真实执行轨迹，不需要人维护映射；
      2. **maps_diff 自动并入**：地图里消失的页面/接口 → 用例退场（不是 fail，是不适用）；
      3. 五源选中后**再过三档闸**：否则 smoke 里会混进 flaky 与语义断言用例，
         冒烟集一旦不稳，团队就会绕过它（§13.3 明文）。

    返回：
      {tier, selected, excluded, reasons, coverage_basis, diagnostics}
    """
    cases = cases or []
    quarantine_ids = set(quarantine_ids or set())
    for c in cases:
        if c.get("quarantine") or str(c.get("status") or "").lower() == "quarantined":
            quarantine_ids.add(c.get("id"))

    # ---- ① 五源 + touched 收敛成「受影响集合」 ----
    reasons: dict[str, list[dict]] = {}
    explicit = set(explicit_ids or [])

    def add(cid: str, source: str, why: str):
        if not cid or cid in quarantine_ids:
            return
        reasons.setdefault(cid, []).append(
            {"source": source, "reason": why, "trust": SOURCE_TRUST[source]})

    for cid in explicit:
        add(cid, "explicit", "人工显式指定")

    reqs = set(changed_requirements or [])
    mods = {str(m) for m in (changed_modules or [])}
    frags = {str(f).split("@")[0] for f in (changed_fragments or [])}
    pages = _norm_pages(changed_pages) | _norm_pages((maps_diff or {}).get("pages_added")) \
        | {c["route"] for c in (maps_diff or {}).get("controls_changed") or [] if c.get("route")}
    apis = {str(a) for a in (changed_apis or [])} | _norm_pages((maps_diff or {}).get("apis_added"))
    gone_pages = _norm_pages((maps_diff or {}).get("pages_removed"))
    gone_apis = {str(a) for a in (maps_diff or {}).get("apis_removed") or []}

    retired: dict[str, str] = {}
    for c in cases:
        cid = c.get("id")
        if not cid or cid in quarantine_ids:
            continue
        touched = c.get("touched") or {}
        tp, ta = _norm_pages(touched.get("pages")), {str(x) for x in touched.get("apis") or []}
        hit_gone = (tp & gone_pages) | (ta & gone_apis)
        if hit_gone:
            retired[cid] = f"依赖已消失：{sorted(hit_gone)}（退场，不计 fail）"
            continue
        if cid in explicit:
            continue
        for r in c.get("derived_from_requirements") or []:
            if r in reqs:
                add(cid, "requirement_change", f"source:{r}")
                break
        hit_mod = [m for m in c.get("modules") or [] if str(m) in mods]
        hit_page = sorted(tp & pages)
        hit_api = sorted(ta & apis)
        if hit_mod:
            add(cid, "code_change", f"module:{hit_mod[0]}")
        elif hit_page or hit_api:
            # touched 命中比模块映射更准（来自真实执行轨迹，无需人工维护）
            add(cid, "code_change",
                f"touched:{','.join(hit_page + hit_api)[:60]}")
        for f in c.get("fragments") or []:
            fid = f.get("id") if isinstance(f, dict) else str(f).split("@")[0]
            if str(fid) in frags:
                add(cid, "dependency", f"fragment:{fid}")
                break
    for cid in (similar_cases or []):
        add(cid, "history_similar", "相似用例兜底（只选不判）")

    affected = {cid for cid, rs in reasons.items()
                if any(r["source"] in _TRUSTED for r in rs)}

    # ---- ② 三档裁剪（复用 selector 的闸，不重写规则） ----
    from .selector import select_regression
    pool = [c for c in cases if c.get("id") in reasons]
    trimmed = select_regression(pool, tier=tier, budget_s=budget_s)
    selected = [cid for cid in trimmed["selected"]]
    dropped_by_tier = [cid for cid in reasons if cid not in selected]

    # ---- ③ 未测风险（未选中 + 三轮排除，都要说清楚为什么） ----
    untested = []
    for cid in dropped_by_tier:
        rs = sorted(reasons[cid], key=lambda r: r["trust"])
        untested.append({
            "id": cid,
            "reason": ("超出时长预算" if trimmed.get("budget_s") is not None
                       else "不在本档范围"),
            "trusted_sources": [r["source"] for r in rs if r["source"] in _TRUSTED],
            "risk_note": ("可信影响源命中但本次未跑，须在准入结论中列为未测风险"
                          if any(r["source"] in _TRUSTED for r in rs)
                          else "仅相似兜底命中，可不跑"),
        })
    for ex in trimmed.get("excluded") or []:
        untested.append({"id": ex["id"], "reason": ex["reason"], "trusted_sources": []})

    return {
        "tier": tier,
        "selected": selected,
        "selected_count": len(selected),
        "total_s": trimmed.get("total_s"),
        "budget_s": trimmed.get("budget_s"),
        "excluded": trimmed.get("excluded") or [],
        "retired": retired,
        "reasons": reasons,
        "affected_trusted": sorted(affected),
        "untested_risks": untested,
        "explainable": all(bool(v) for v in reasons.values()),
        "diagnostics": {
            "history_similar_only": sorted(cid for cid, rs in reasons.items()
                                           if all(r["source"] == "history_similar" for r in rs)),
            "quarantined_skipped": sorted(quarantine_ids),
            "quarantine_note": "隔离区用例不进任何档位（§13.3 闸 3）",
        },
    }


def impact_coverage(plan_result: dict) -> dict:
    """影响覆盖度 = 受影响用例中实际执行的比例（分子只算可信源，分母只算可信源）。

    为什么分子分母都剔掉 history_similar：它只补漏不判定（§13.2）。若把它算进分母，
    相似检索多召回几条就会把覆盖度稀释，指标失去意义。
    """
    affected = set(plan_result.get("affected_trusted") or [])
    selected = set(plan_result.get("selected") or [])
    retired = set((plan_result.get("retired") or {}).keys())
    live_affected = affected - retired
    if not live_affected:
        return {"impact_coverage": None, "available": False,
                "reason": "no_affected（本轮无可信影响源命中的用例）",
                "note": "无影响 ≠ 覆盖 100%；此情形下不得给出上线结论"}
    hit = live_affected & selected
    miss = sorted(live_affected - selected)
    return {"impact_coverage": round(len(hit) / len(live_affected), 4),
            "available": True,
            "affected": len(live_affected), "executed": len(hit),
            "untested": miss,
            "advice": ("影响面已全覆盖" if not miss
                       else f"{len(miss)} 条受影响用例未执行，须在结论中列明")}


def _exec_health(records: list[dict]) -> dict:
    """资产健康度：执行用例中非 flaky、非跳过、非长期失败的占比（§13.4）。"""
    if not records:
        return {"asset_health": None, "available": False,
                "reason": "no_exec_records"}
    bad = 0
    for r in records:
        v = str(r.get("verdict") or "").lower()
        if v in ("flaky", "skipped"):
            bad += 1
        elif v == "fail" and int(r.get("consecutive_fail") or 0) >= 3:
            bad += 1                       # 长期失败：用例本身可能已失效
    return {"asset_health": round(1 - bad / len(records), 4),
            "available": True, "sample": len(records),
            "unhealthy": bad}


def admission_with_coverage(plan_result: dict, exec_records: list[dict],
                            changed_requirement_ids: list[str] | None = None,
                            executed_requirement_ids: list[str] | None = None
                            ) -> dict:
    """把三指标凑齐再合成准入结论（这是 §13.1 第 2、3 题的完整答案）。

    与 selector.admission_conclusion 的分工：那个只管"给三个数 → 结论"，
    本函数负责**把三个数算出来**，且缺任何一项就明说缺哪项，不用默认值顶替。
    """
    from .selector import admission_conclusion

    ic = impact_coverage(plan_result)
    health = _exec_health(exec_records)

    req_total = {str(x) for x in (changed_requirement_ids or [])}
    req_done = {str(x) for x in (executed_requirement_ids or [])}
    if req_total:
        req_cov = len(req_total & req_done) / len(req_total)
    else:
        req_cov = None

    missing = [n for n, ok in (("requirement_coverage", req_cov is not None),
                               ("impact_coverage", ic.get("available")),
                               ("asset_health", health.get("available"))) if not ok]
    if missing:
        return {"verdict": "no_conclusion",
                "reason": f"指标缺失：{', '.join(missing)}——缺指标不给结论（不拿默认值凑数）",
                "metrics": {"requirement_coverage": req_cov,
                            "impact_coverage": ic.get("impact_coverage"),
                            "asset_health": health.get("asset_health")},
                "untested_risks": plan_result.get("untested_risks") or []}

    concl = admission_conclusion(req_cov, ic["impact_coverage"], health["asset_health"])
    concl["untested_risks"] = plan_result.get("untested_risks") or []
    concl["retired"] = sorted((plan_result.get("retired") or {}).keys())
    concl["detail"] = {"impact": ic, "asset": health}
    return concl


def regression_three_answers(cases: list[dict], exec_records: list[dict],
                             changed_requirement_ids: list[str] | None = None,
                             **kwargs) -> dict:
    """一次给出三问三答（给人看的那一版，可直接渲染进报告）。

    kwargs 透传给 plan_regression（tier / explicit_ids / changed_* / maps_diff…）。
    """
    plan = plan_regression(cases, **kwargs)
    executed_reqs = kwargs.pop("executed_requirement_ids", None) or \
        sorted({r for c in cases if c.get("id") in set(plan["selected"])
                for r in c.get("derived_from_requirements") or []})
    admission = admission_with_coverage(plan, exec_records,
                                        changed_requirement_ids, executed_reqs)
    return {
        "q1_what_to_run": {
            "tier": plan["tier"], "selected": plan["selected"],
            "count": plan["selected_count"], "total_s": plan["total_s"],
            "budget_s": plan["budget_s"], "reasons": plan["reasons"],
        },
        "q2_can_we_ship": admission,
        "q3_untested_risk": {
            "count": len(plan["untested_risks"]),
            "items": plan["untested_risks"],
            "retired": plan["retired"],
            "statement": (f"未测 {len(plan['untested_risks'])} 条；"
                          f"退场 {len(plan['retired'])} 条（依赖已消失，不计 fail）"),
        },
        "diagnostics": plan["diagnostics"],
    }
