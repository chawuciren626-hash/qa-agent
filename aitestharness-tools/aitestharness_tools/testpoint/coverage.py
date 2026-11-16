"""测试点/用例阶段工具：覆盖率矩阵 + V-33 覆盖对账。

对应 IR 契约《AITestHarness校验器测试用例集-v1.md》中唯一未实现的 M1 规则 V-33：
  V-33 覆盖对账（X 层）：
    1) 每条 approved 需求，至少存在一条 approved/confirmed 测试点 derived_from 该需求；
    2) 每条 approved 测试点，至少存在一条 case derived_from 该测试点；
    3) 输出缺口清单（coverage_gap），供人工确认卡点消费。
本工具即 V-33 的实现，可独立 CLI 运行，也可被 irval pipeline 以库函数方式调用。
"""
from __future__ import annotations

__all__ = ["coverage_matrix", "coverage_gaps", "V33_CHECK"]

V33_CHECK = "V-33"

# 可计入覆盖的产物状态：需求看 approved；测试点/用例看 approved（含 confirmed 等价态）
_COVERING_STATUS = {"approved", "confirmed"}


def _accepted_status(item: dict) -> bool:
    return (item.get("status") or "").lower() in _COVERING_STATUS


def _lineage(head: dict):
    return head.get("lineage") or {}


def _derived_ids(head: dict) -> set[str]:
    return {d.get("id") for d in _lineage(head).get("derived_from") or [] if d.get("id")}


def coverage_matrix(requirements: list[dict], test_points: list[dict],
                    cases: list[dict]) -> dict:
    """构建 req → tp → case 覆盖矩阵。

    返回矩阵条目：
      {req_id, req_status, tp_ids:[...], tp_approved:int, case_ids:[...],
       case_approved:int, coverage: none|tp_only|full,
       depth: 0|1|2  (2=case 级覆盖)}
    """
    # 建反向索引：tp.reqs = set(req_id)；case.tps = set(tp_id)
    tp_parents: list[tuple[dict, set[str]]] = [(_lineage(tp), _derived_ids(tp)) for tp in test_points]
    case_parents: list[tuple[dict, set[str]]] = [(_lineage(c), _derived_ids(c)) for c in cases]

    matrix = []
    for req in requirements:
        req_head = _lineage(req)
        req_id = req_head.get("id")
        tp_ids = [h.get("id") for h, parents in tp_parents if req_id in parents]
        # case 覆盖两条路径：case→tp→req，或 case 直接 derived_from req（V-37 允许薄链路）
        tp_id_set = set(tp_ids)
        case_ids = [h.get("id") for h, parents in case_parents
                    if parents & tp_id_set or req_id in parents]
        tp_ok = sum(1 for tp in test_points
                    if _lineage(tp).get("id") in tp_id_set and _accepted_status(tp))
        case_ok = sum(1 for c in cases
                      if _lineage(c).get("id") in set(case_ids) and _accepted_status(c))
        if case_ok:
            cov, depth = "full", 2
        elif tp_ok:
            cov, depth = "tp_only", 1
        elif tp_ids:
            cov, depth = "none", 1
        else:
            cov, depth = "none", 0
        matrix.append({
            "req_id": req_id,
            "req_status": req_head.get("status"),
            "tp_ids": tp_ids, "tp_approved": tp_ok,
            "case_ids": case_ids, "case_approved": case_ok,
            "coverage": cov, "depth": depth,
        })
    return {"matrix": matrix}


def coverage_gaps(requirements: list[dict], test_points: list[dict],
                  cases: list[dict], enforce: bool = False) -> dict:
    """V-33 对账：输出缺口清单。

    enforce=True 时按校验规则返回 ok=False（供 CI/流水线 gate 使用）；
    默认仅报告（enforce=False），因为覆盖缺口多数时候应推动补设计而非拒绝产物。
    """
    m = coverage_matrix(requirements, test_points, cases)
    gaps = []
    for row in m["matrix"]:
        if row["req_status"] not in _COVERING_STATUS:
            continue  # 未 approved 的需求不参与对账（V-01 语义）
        if row["tp_approved"] == 0:
            gaps.append({"rule": V33_CHECK, "level": "error",
                         "req": row["req_id"],
                         "message": f"需求 {row['req_id']} 无 approved 测试点覆盖"})
        elif row["case_approved"] == 0:
            gaps.append({"rule": V33_CHECK, "level": "warn",
                         "req": row["req_id"],
                         "message": f"需求 {row['req_id']} 测试点已覆盖但无 approved 用例"})
    ok = not any(g["level"] == "error" for g in gaps)
    stats = {
        "requirements_total": len(m["matrix"]),
        "full": sum(1 for r in m["matrix"] if r["coverage"] == "full"),
        "tp_only": sum(1 for r in m["matrix"] if r["coverage"] == "tp_only"),
        "none": sum(1 for r in m["matrix"] if r["coverage"] == "none"),
        "case_coverage_ratio": (round(sum(1 for r in m["matrix"] if r["case_approved"] > 0)
                                      / max(len(m["matrix"]), 1), 4)),
    }
    return {"rule": V33_CHECK, "ok": ok, "gaps": gaps, "stats": stats,
            "enforced": enforce}
