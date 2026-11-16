"""计划/固化阶段工具：
1. extract_touched — 从 plan 步骤自动提取 touched.pages/apis（重放时刷新同一函数）
2. compile_gates — 固化编译五道硬闸
   （v3 方案第 8 章；与 irval 的 V-14~V-19 呼应，但这是编译期实现而非校验器）
   五闸：locator_unique / assertion_decidable / data_no_hardcode / traceable / replay_verified
   replay_verified 无法在编译期完成——输出 pending 状态，由执行引擎重放成功后回填。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

__all__ = ["extract_touched", "compile_gates", "GateResult"]

# locator 类型指纹优先级（多指纹策略：css > aria > text > xpath）
_LOCATOR_TYPES = {"css", "aria", "text", "xpath", "id"}
_API_RE = re.compile(r"^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$", re.I)
_DATA_REF_RE = re.compile(r"\$\{data\.([A-Za-z0-9_.]+)\}")


def extract_touched(plan: dict) -> dict:
    """提取 touched：{pages: [...], apis: [...]}（去重排序，稳定输出便于 diff）。

    - steps[].action 含 navigate/open → page
    - steps[].driver == api 或 request 字段 → api（只记 method+path，决议 #2）
    - fragments 引用展开：由调用方传入 fragment 展开后的 steps
    """
    pages, apis = set(), set()
    for step in plan.get("steps") or []:
        action = str(step.get("action") or step.get("intent") or "")
        if any(k in action.lower() for k in ("navigate", "open", "goto", "跳转", "打开")):
            page = step.get("target") or step.get("url") or step.get("page")
            if page:
                pages.add(str(page))
        api_match = _API_RE.match(str(step.get("request") or step.get("call") or ""))
        if api_match or (step.get("driver") == "api" and step.get("endpoint")):
            if api_match:
                apis.add(f"{api_match.group(1).upper()} {api_match.group(2)}")
            else:
                method = str(step.get("method") or "GET").upper()
                apis.add(f"{method} {step['endpoint']}")
    return {
        "pages": sorted(pages),
        "apis": sorted(apis),
    }


@dataclass
class GateResult:
    name: str
    passed: bool
    state: str = "hard"      # hard（已判定）/ pending（待重放回填）
    violations: list = field(default_factory=list)


def compile_gates(plan: dict, case: dict | None = None,
                  allow_step_budget_raise: bool = False) -> list[GateResult]:
    """对一份固化 plan 执行五闸检查，返回五份 GateResult。

    闸 1 locator_unique：每步 target 须给出 ≥1 个 locator，且无两个同名指纹指向不同值；
    闸 2 assertion_decidable：每条断言 matcher ∈ 白名单（与 V-35 同表），数值须字符串十进制；
    闸 3 data_no_hardcode：凭据类数据必须走 ${data.*} 引用（与 V-18/V-05 呼应）；
    闸 4 traceable：plan.steps[].assert[].source 必须回指 case.assertions（或 fragment）；
    闸 5 replay_verified：编译期恒为 pending，由执行引擎 N=3 通过后置 passed。
    """
    results: list[GateResult] = []
    steps = plan.get("steps") or []

    # ---- 闸 1：locator_unique ----
    viol = []
    for i, step in enumerate(steps):
        locs = step.get("locators") or ([{"type": "id", "value": step["target"]}]
                                        if step.get("target") else [])
        if not locs:
            viol.append(f"step[{i}] 无任何 locator")
            continue
        types = [l.get("type") for l in locs]
        if "xpath" in types and len([t for t in types if t != "xpath"]) == 0:
            viol.append(f"step[{i}] 仅含 xpath 单指纹（脆弱，须补 css/aria/text 指纹）")
        seen_types = {}
        for l in locs:
            t = l.get("type")
            if t in _LOCATOR_TYPES and t in seen_types and seen_types[t] != l.get("value"):
                viol.append(f"step[{i}] 两个 {t} 指纹值不同")
            seen_types[t] = l.get("value")
    results.append(GateResult("locator_unique", not viol, violations=viol))

    # ---- 闸 2：assertion_decidable ----
    from ..irval.enums import ENUMS
    matchers = set(ENUMS["matcher"])  # 白名单唯一来源，避免两处维护
    viol = []
    for i, step in enumerate(steps):
        for j, a in enumerate(step.get("assert") or []):
            m = a.get("matcher")
            if m not in matchers:
                viol.append(f"step[{i}].assert[{j}] matcher '{m}' 不在白名单")
            for key in ("expected", "value", "range"):
                v = a.get(key)
                if isinstance(v, float):
                    viol.append(f"step[{i}].assert[{j}].{key} 为 float，须字符串十进制")
    results.append(GateResult("assertion_decidable", not viol, violations=viol))

    # ---- 闸 3：data_no_hardcode ----
    viol = []
    data_refs = set()
    for i, step in enumerate(steps):
        raw = str(step.get("input") or "") + str(step.get("data") or "")
        data_refs |= set(_DATA_REF_RE.findall(raw))
        # 凭据字段出现在明文中（启发式：字段名含 password/token/secret）
        blob = (str(step.get("input") or "") + str(step.get("payload") or "")).lower()
        for kw in ("password", "passwd", "token", "secret"):
            if kw in blob and f"${{data." not in blob:
                viol.append(f"step[{i}] 疑似硬编码凭据（含 '{kw}' 且未走 ${{data.*}}）")
                break
    if plan.get("data") and not data_refs:
        viol.append("plan.data 已声明但无任何步骤引用（死数据）")
    results.append(GateResult("data_no_hardcode", not viol, violations=viol))

    # ---- 闸 4：traceable ----
    viol = []
    if case is not None:
        case_sources = {a.get("source") for a in (case.get("assertions") or [])
                        if isinstance(a, dict)}
        for i, step in enumerate(steps):
            for j, a in enumerate(step.get("assert") or []):
                src = a.get("source")
                if not src:
                    viol.append(f"step[{i}].assert[{j}] 断言无 source（断言来源链断裂）")
                elif case_sources and src not in case_sources:
                    viol.append(f"step[{i}].assert[{j}].source '{src}' 未在 case.assertions 中登记")
    else:
        viol.append("未传入 case，traceable 无法对账（需 case.assertions 来源）")
    results.append(GateResult("traceable", not viol, violations=viol))

    # ---- 闸 5：replay_verified ----
    state = plan.get("replay") or {}
    if state.get("verified") is True and state.get("consistency") == "pass":
        results.append(GateResult("replay_verified", True, state="hard"))
    else:
        results.append(GateResult("replay_verified", False, state="pending",
                                  violations=["等待执行引擎重放验证后回填"]))
    return results


def gates_summary(results: list[GateResult]) -> dict:
    """五闸汇总：all_passed / pending / failed —— 固化卡点的判定依据。"""
    if any(r.state == "pending" and not r.passed for r in results):
        return {"verdict": "pending",
                "pending": [r.name for r in results if r.state == "pending"]}
    if all(r.passed for r in results):
        return {"verdict": "pass", "pending": []}
    return {"verdict": "fail",
            "failed": {r.name: r.violations for r in results if not r.passed}}
