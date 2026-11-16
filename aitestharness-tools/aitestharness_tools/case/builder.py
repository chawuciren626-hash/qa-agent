"""10.4 阶段三：用例生成 —— Program 四件套（零 LLM）。

1. build_case_skeleton — 用例骨架生成器：测试点 → 计划模板（步骤占位+断言占位）
2. DataFactory — 数据工厂：按字段约束生成边界数据，产出数据集 ID（与用例分离）
3. check_case_budget — 用例预算校验器：N+1 条硬限制（防 agent 铺用例失控）
4. reconcile_enumeration — 枚举清单对账器：需求能力项 ↔ 用例 双向 diff 找漏

分工纪律（v3 §10.4）：骨架/数据由程序生成；步骤让 LLM 补（不写断言）；
断言必须从测试点的预期结果来——本包通过 plan/gates.compile_gates 闸 4 强制对账。
"""
from __future__ import annotations

import hashlib
import random
import re
import string

__all__ = ["build_case_skeleton", "DataFactory", "check_case_budget", "reconcile_enumeration"]

# 骨架模板按 verify_mode 区分（断言占位必须回指测试点，闸 4 消费）
_SKELETONS = {
    "api": {"steps": [
        {"intent": "调用 {endpoint}，前置满足", "driver": "api",
         "request": "__STEP_FILL__", "payload": {},
         "assert": [{"__FROM_TEST_POINT__": True, "decide": True}]},
    ]},
    "ui": {"steps": [
        {"intent": "打开 {page}", "driver": "web", "action": "navigate",
         "target": "__STEP_FILL__", "assert": []},
        {"intent": "执行 {operation}", "driver": "web", "action": "__STEP_FILL__",
         "locators": [{"type": "__STEP_FILL__", "value": "__STEP_FILL__"}],
         "assert": [{"__FROM_TEST_POINT__": True, "decide": True}]},
    ]},
    "db": {"steps": [
        {"intent": "执行业务动作后查询落库结果", "driver": "db", "action": "db_query",
         "query": "__STEP_FILL__",
         "assert": [{"__FROM_TEST_POINT__": True, "decide": True}]},
    ]},
}


def build_case_skeleton(tp: dict, variant: str = "api") -> dict:
    """测试点 → 用例骨架。断言占位 {__FROM_TEST_POINT__: True} 由 Advisor
    （断言生成器）从 tp.expected 填，不得从鼠标动作反推（v3 §10.4 纪律）。"""
    tpl = _SKELETONS.get(variant)
    if tpl is None:
        raise ValueError(f"unknown verify_mode variant: {variant!r}")
    import copy
    steps = copy.deepcopy(tpl["steps"])
    case = {
        "case_id": tp.get("id", "tp-0000").replace("tp-", "case-") + "c",
        "lineage": {"derived_from": [{"id": tp.get("id"), "version": tp.get("version", 1)}]},
        "title": f"[{variant.upper()}] {tp.get('title') or tp.get('dimension', '')}",
        "verify_mode": variant,
        "preconditions": tp.get("preconditions", ""),
        "steps": steps,
        "assertions": [],   # 由断言生成器从 tp.expected 填，并登记 source 供闸 4 对账
        "data_set_id": None,  # 由数据工厂填
    }
    return case


class DataFactory:
    """按字段约束生成边界数据；产出数据集 ID，与用例分离（可复用、可版本化）。

    field: {name, type: string|int|decimal|phone|email, constraints: {min,max,required,...}}
    生成组：正常值 / 边界下 / 边界上 / 边界外-下 / 边界外-上 / 空(可选)
    """

    BOUNDARY_LABELS = ("normal", "min", "max", "min_out", "max_out", "empty")

    def __init__(self, seed: int = 42):
        self.rnd = random.Random(seed)   # 固定种子：同约束同数据，可复现

    def build_dataset(self, fields: list[dict], name: str = "ds") -> dict:
        rows = {}
        for label in self.BOUNDARY_LABELS:
            row = {}
            for f in fields:
                row[f["name"]] = self._value_for(f, label)
            rows[label] = row
        ds_id = "ds-" + hashlib.sha1(
            (name + str(sorted((f['name'], str(f.get('constraints'))) for f in fields))
             ).encode()).hexdigest()[:8]
        return {"data_set_id": ds_id, "rows": rows}

    def _value_for(self, f: dict, label: str):
        t = f.get("type", "string")
        cons = f.get("constraints") or {}
        if cons.get("required") and label == "empty":
            return None
        if t in ("string", "phone", "email"):
            lo, hi = int(cons.get("min", 0)), int(cons.get("max", 32))
            if label == "empty":
                return ""
            n = {"min": lo, "max": hi, "min_out": max(lo - 1, 0),
                 "max_out": hi + 1}.get(label, min(max((lo + hi) // 2, 1), hi))
            n = max(n, 1) if t == "email" else n
            body = "".join(self.rnd.choice(string.ascii_lowercase) for _ in range(n))
            if t == "email":
                return f"{body or 'a'}@t.local"
            if t == "phone":
                return ("138" + body)[:11].ljust(11, "0")
            return body
        # 数值一律字符串十进制（决议 #7）
        lo, hi = cons.get("min", 0), cons.get("max", 100)
        if isinstance(lo, str):
            lo, hi = float(lo), float(hi)
        val = {"min": lo, "max": hi, "min_out": lo - 1, "max_out": hi + 1}.get(
            label, (lo + hi) / 2)
        if float(val).is_integer():
            return str(int(val))
        return f"{val:.2f}"


def check_case_budget(case_count: int, per_requirement: dict | None = None,
                      max_total: int = 200, max_per_req: int = 30) -> dict:
    """用例预算校验器：N+1 条硬限制（N=每需求配额，+1=防铺量的全局上限）。
    per_requirement: {req_id: count}"""
    problems = []
    if case_count > max_total:
        problems.append({"rule": "BUDGET_TOTAL", "level": "error",
                         "message": f"用例总数 {case_count} 超过全局上限 {max_total}，"
                                    f"疑似 agent 铺用例失控"})
    for rid, cnt in (per_requirement or {}).items():
        if cnt > max_per_req:
            problems.append({"rule": "BUDGET_PER_REQ", "level": "error", "item": rid,
                             "message": f"需求 {rid} 生成 {cnt} 条用例，超过单需求上限 {max_per_req}"})
    return {"ok": not problems, "problems": problems}


def reconcile_enumeration(capability_items: list[dict], cases: list[dict]) -> dict:
    """枚举清单对账器：需求能力项 ↔ 用例，双向 diff 找漏。

    capability_items: [{id, key}]（key 为需求能力项的稳定标识，如 'login.sms'）
    cases: [{id, covered_capabilities: [key...]}]
    """
    cap_keys = {c["key"]: c["id"] for c in capability_items}
    covered: dict[str, list[str]] = {}
    unknown = []
    for c in cases:
        for k in c.get("covered_capabilities") or []:
            if k in cap_keys:
                covered.setdefault(k, []).append(c.get("id"))
            else:
                unknown.append({"case": c.get("id"), "key": k})
    missing = [{"capability": k, "req_item": cap_keys[k]}
               for k in cap_keys if k not in covered]
    return {"ok": not missing and not unknown,
            "missing_in_cases": missing,          # 需求有、用例没有 → 漏
            "unknown_in_cases": unknown,          # 用例引了不存在的能力项 → 多（或拼错）
            "covered_count": len(covered), "capability_total": len(cap_keys)}
