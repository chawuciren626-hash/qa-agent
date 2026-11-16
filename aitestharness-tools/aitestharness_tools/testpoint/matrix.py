"""10.3 阶段二：测试点分析 —— 矩阵三件套 + 验证方式分配器（Program/Validator，零 LLM）。

v3 §10.3 关键设计：**矩阵由程序算，LLM 只补空格子。**
1. KNOWLEDGE_MAP — 控件类型 × 测试维度 checklist 映射表（v3 建议：结构化映射表，
   不自研向量库；RAG 只用于"相似历史项目"）
2. build_matrix — 维度矩阵生成器：需求项 × 维度 → 待覆盖矩阵
3. matrix_gaps — 覆盖度计算器：哪些格子没填 → 缺口清单
4. assign_verify_mode — 验证方式分配器（v3 §11.6）：业务逻辑→api，呈现交互→ui……强制分配
"""
from __future__ import annotations

__all__ = ["KNOWLEDGE_MAP", "build_matrix", "matrix_gaps", "assign_verify_mode",
           "search_checklist"]

# 控件类型 × 测试维度（种子映射表，M1 用内建表；管理员可经服务端下发档扩充）
# 维度：功能 / 边界 / 异常 / 权限 / 性能 / 兼容 / 数据
KNOWLEDGE_MAP: dict[str, list[str]] = {
    "login":      ["功能", "异常", "边界", "权限", "数据"],
    "input":      ["功能", "边界", "异常", "数据"],
    "textarea":   ["功能", "边界", "异常", "数据"],
    "button":     ["功能", "异常", "权限", "性能"],
    "select":     ["功能", "边界", "异常", "数据"],
    "checkbox":   ["功能", "边界"],
    "radio":      ["功能", "边界"],
    "upload":     ["功能", "边界", "异常", "性能"],
    "download":   ["功能", "异常", "性能"],
    "table":      ["功能", "边界", "性能", "权限"],
    "pagination": ["功能", "边界", "性能"],
    "search":     ["功能", "边界", "异常", "性能"],
    "modal":      ["功能", "异常"],
    "toast":      ["功能", "异常"],
    "datepicker": ["功能", "边界", "异常"],
    "captcha":    ["功能", "异常", "边界", "安全"],
    "file_export": ["功能", "边界", "性能", "数据"],
    "api":        ["功能", "边界", "异常", "权限", "性能", "数据"],
}

# 验证方式分配规则（v3 §11.6）：按测试点类型强制分配，杜绝"全上 UI"
_VERIFY_RULES = [
    # (匹配测试点类型/维度, 分配方式, 理由)
    (("维度", "功能"), "ui", "呈现与交互验证走 UI"),
    (("维度", "边界"), "api", "边界值业务逻辑走接口，最确定"),
    (("维度", "异常"), "api", "异常分支断言在响应码/报文"),
    (("维度", "权限"), "api", "鉴权逻辑必须接口层验证"),
    (("维度", "性能"), "api", "耗时指标从接口取"),
    (("维度", "数据"), "db", "落库正确性走 DB 断言"),
    (("维度", "安全"), "api", "安全用例走接口层"),
    (("控件类型", "toast"), "ui", "提示呈现走 UI"),
]


def search_checklist(control_type: str) -> list[str]:
    """知识库检索：控件类型 → 维度 checklist（结构化映射，不用 RAG）。"""
    return list(KNOWLEDGE_MAP.get((control_type or "").lower(), []))


def build_matrix(requirement_items: list[dict]) -> dict:
    """需求项 × 维度 → 待覆盖矩阵。

    requirement_items: [{id, module, control_types: [...]}]
    每个需求项的每个控件类型，展开 KNOWLEDGE_MAP 的维度为一格。
    格子：{cell_id, req_id, control_type, dimension, test_point_id: None, verify_mode: None}
    """
    cells = []
    for item in requirement_items:
        rid = item.get("id")
        for ct in item.get("control_types") or []:
            for dim in search_checklist(ct):
                cells.append({"cell_id": f"{rid}::{ct}::{dim}",
                              "req_id": rid, "control_type": ct,
                              "dimension": dim,
                              "test_point_id": None, "verify_mode": None})
    return {"cells": cells, "total": len(cells)}


def matrix_gaps(matrix: dict, test_points: list[dict]) -> dict:
    """覆盖度计算器（零 LLM）：矩阵格子 vs 已产出的测试点 → 缺口清单。

    test_points: [{id, req_id, control_type, dimension, verify_mode}]
    测试点回填矩阵（同 req+control+dimension 命中即视为已覆盖）。
    """
    index = {}
    for tp in test_points:
        key = (tp.get("req_id"), (tp.get("control_type") or "").lower(),
               tp.get("dimension"))
        index.setdefault(key, []).append(tp)
    filled = 0
    gaps = []
    for cell in matrix.get("cells") or []:
        key = (cell["req_id"], cell["control_type"], cell["dimension"])
        hits = index.get(key) or []
        if hits:
            filled += 1
            cell["test_point_id"] = hits[0]["id"]
            cell["verify_mode"] = hits[0].get("verify_mode")
        else:
            gaps.append(cell)
    total = len(matrix.get("cells") or [])
    return {"total": total, "covered": filled,
            "coverage": round(filled / total, 4) if total else 1.0,
            "gap_count": len(gaps),
            "gaps": gaps,          # 只把缺口格子交给测试点补齐器（Advisor）
            "unassigned_mode": [c["cell_id"] for c in (matrix.get("cells") or [])
                                if c["test_point_id"] and not c["verify_mode"]]}


def assign_verify_mode(test_points: list[dict]) -> list[dict]:
    """验证方式分配器（v3 §11.6）：按维度规则强制分配 api/ui/db/native/mini。

    返回每条测试点的 {id, verify_mode, reason}；规则不命中默认 ui（呈现交互兜底）。
    """
    results = []
    for tp in test_points:
        mode, reason = "ui", "默认兜底：呈现与交互验证走 UI"
        for (kind, val), m, why in _VERIFY_RULES:
            if kind == "维度" and tp.get("dimension") == val:
                mode, reason = m, why
                break
        results.append({"id": tp.get("id"), "verify_mode": mode, "reason": reason})
    return results
