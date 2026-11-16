"""§13.2 回归选集：五个触发源 + 可解释性（每条选中必须给理由）。

触发源按可靠性排序：
  ① 显式指定（人勾选）  ② 需求变更溯源  ③ 代码变更影响  ④ 依赖传递（片段）  ⑤ 历史相似（只选不判）

关键原则（§13.2）：选集结果必须可解释——不能只说"AI 帮你选了 42 条"，
要给出每条理由（source:REQ-045 / fragment:login@1 / module:order-service）。
"""
from __future__ import annotations

__all__ = ["select_by_change", "SOURCES_BY_RELIABILITY"]

SOURCES_BY_RELIABILITY = ("explicit", "requirement_change", "code_change",
                          "dependency", "history_similar")


def select_by_change(explicit_ids: list[str] | None = None,
                     changed_requirements: list[str] | None = None,
                     changed_modules: list[str] | None = None,
                     changed_fragments: list[str] | None = None,
                     similar_cases: list[str] | None = None,
                     cases: list[dict] | None = None,
                     quarantine_ids: set[str] | None = None) -> dict:
    """按五个触发源选集，并输出可解释的选中理由。

    cases: [{id, derived_from_requirements: [...], modules: [...],
             fragments: [{"id": "frag-login", "version": 1}], quarantine?}]
    返回 {selected: [ids], reasons: {id: [{source, reason, reliability}]}, unselected_risk}
    """
    cases = cases or []
    quarantine_ids = quarantine_ids or set()
    reasons: dict[str, list[dict]] = {}

    def add(cid: str, source: str, reason: str):
        if cid in quarantine_ids:
            return
        reasons.setdefault(cid, []).append(
            {"source": source, "reason": reason,
             "reliability": SOURCES_BY_RELIABILITY.index(source)})

    explicit = set(explicit_ids or [])
    for cid in explicit:
        add(cid, "explicit", "人工显式指定")
    reqs = set(changed_requirements or [])
    mods = set(changed_modules or [])
    frags = {f.split("@")[0] for f in (changed_fragments or [])}
    for c in cases:
        cid = c.get("id")
        if cid in explicit:
            continue
        for r in c.get("derived_from_requirements") or []:
            if r in reqs:
                add(cid, "requirement_change", f"source:{r}")
                break
        hit_mods = [m for m in c.get("modules") or [] if m in mods]
        if hit_mods:
            add(cid, "code_change", f"module:{hit_mods[0]}")
        for f in c.get("fragments") or []:
            fid = f.get("id") if isinstance(f, dict) else str(f).split("@")[0]
            if fid in frags:
                add(cid, "dependency", f"fragment:{fid}"
                    f"@{f.get('version') if isinstance(f, dict) else '?'}")
                break
    for cid in (similar_cases or []):
        add(cid, "history_similar", "相似用例兜底（只选不判）")

    return {
        "selected": sorted(reasons.keys()),
        "reasons": reasons,
        "explainable": all(bool(v) for v in reasons.values()),
        "unselected_risk": {
            "note": "未选中用例不代表无风险；影响覆盖度按本结果计算（§13.4）",
            "total_cases": len(cases),
            "selected_count": len(reasons),
        },
    }
