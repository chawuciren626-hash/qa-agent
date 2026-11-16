"""M 层校验规则（V-14~V-21、V-35、V-37）：单产物内的语义检查。

这一层是"防假通过"的主力：
- V-14 不可判定的预期（只能靠模型看图判断）
- V-15 没有 decide 断言（跑出来永远 pass，等于没测）
- V-17 五闸可被自标为 pass
- V-20 verdict 与断言矛盾
- V-21 inconclusive 无原因（会被当成"没跑"，掩盖环境问题）
"""

from __future__ import annotations

import re
from typing import Any

from . import errors as E
from .enums import MATCHER_REQUIRES_ARGS
from .store import Store

GATES = [
    "locator_unique",
    "assertion_decidable",
    "data_no_hardcode",
    "traceable",
    "replay_verified",
]

#: 不需要独立 value 的 matcher：
#: - null/not_null 只判存在性
#: - between/in_set 的范围本身由 matcher_args 给出，再要一个 value 是冗余
NO_VALUE_MATCHERS = {"null", "not_null", "between", "in_set"}

#: 定位里出现"层级索引"即视为绝对路径（判据是依赖层级，不是用不用 xpath）
ABSOLUTE_INDEX = re.compile(r"/[a-zA-Z*][\w-]*\[\d+\]")

#: 危险正则：嵌套量词 / 无上限重复（能让 worker 挂死）
UNSAFE_REGEX = [
    re.compile(r"\([^)]*[+*]\)[+*]"),
    re.compile(r"\[[^\]]*\]\{,\d{3,}\}"),
]

#: 固定等待阈值：超过则说明同步策略没学对，而非"等得久一点"
MAX_IDLE_MS = 2000


def _steps(doc: dict) -> list[dict]:
    s = doc.get("steps")
    return [x for x in s if isinstance(x, dict)] if isinstance(s, list) else []


# ------------------------------------------------------------------ 预期判定


def check_matcher(doc: dict, findings: list[E.Finding]) -> None:
    """V-35 matcher 白名单 + 参数配套 + 正则安全。

    注意：matcher 的"是否在枚举内"**不交给 V-02**。
    原因：matcher 需要配套参数校验，若 V-02 先按枚举拦，
    同一个变异会同时命中两条规则，破坏"一个用例一个错误码"的正交性。
    """
    from .enums import ENUMS

    whitelist = set(ENUMS["matcher"])
    for i, exp in enumerate(doc.get("expected") or []):
        if not isinstance(exp, dict):
            continue
        m = exp.get("matcher")
        if m is None:
            continue
        if m not in whitelist:
            findings.append(E.Finding(
                "V-35", E.SEM_MATCHER_NOT_WHITELISTED, f"expected[{i}].matcher",
                f"`{m}` 不在白名单内（禁自由表达式：自由表达式让校验器无法在编译期判定断言有无意义）",
                action=E.ACTION_REJECT, layer="M",
                extra={"allowed": sorted(whitelist)},
            ))
            return
        required = MATCHER_REQUIRES_ARGS.get(m)
        if required:
            args = exp.get("matcher_args") or {}
            missing = [k for k in required if k not in args]
            if missing:
                findings.append(E.Finding(
                    "V-35", E.SEM_MATCHER_ARGS_MISSING, f"expected[{i}].matcher_args",
                    f"matcher={m} 缺少参数 {missing}",
                    layer="M", extra={"missing": missing},
                ))
                return
            if m == "regex":
                pat = str(args.get("pattern", ""))
                if any(p.search(pat) for p in UNSAFE_REGEX):
                    findings.append(E.Finding(
                        "V-35", E.SEM_REGEX_UNSAFE, f"expected[{i}].matcher_args.pattern",
                        f"正则 `{pat}` 含嵌套量词/无上限重复，可能造成灾难性回溯",
                        layer="M",
                    ))
                    return


def check_expectation_decidable(doc: dict, findings: list[E.Finding]) -> None:
    """V-14 预期必须可判定（observable + matcher + value）。"""
    for i, exp in enumerate(doc.get("expected") or []):
        if not isinstance(exp, dict):
            continue
        if not exp.get("observable"):
            findings.append(E.Finding(
                "V-14", E.SEM_EXPECTATION_NOT_DECIDABLE, f"expected[{i}].observable",
                "预期缺少 observable：只能靠模型看图判断 → 不可复现",
                action=E.ACTION_REJECT, layer="M",
            ))
            return
        m = exp.get("matcher")
        if not m:
            findings.append(E.Finding(
                "V-14", E.SEM_EXPECTATION_NOT_DECIDABLE, f"expected[{i}].matcher",
                "预期缺少 matcher", layer="M", extra={"missing": "matcher"},
            ))
            return
        if m not in NO_VALUE_MATCHERS and "value" not in exp:
            findings.append(E.Finding(
                "V-14", E.SEM_EXPECTATION_NOT_DECIDABLE, f"expected[{i}].value",
                "预期缺少 value", layer="M", extra={"missing": "value"},
            ))
            return


# ------------------------------------------------------------------ 用例


def check_decide_assert(doc: dict, findings: list[E.Finding]) -> None:
    """V-15 至少一条 decide 断言（无断言不算通过）。"""
    if doc.get("type") != "case":
        return
    asserts = doc.get("assertions") or []
    if not any(isinstance(a, dict) and a.get("level") == "decide" for a in asserts):
        findings.append(E.Finding(
            "V-15", E.SEM_NO_DECIDE_ASSERT, "assertions",
            "没有任何 decide 级断言：这条用例跑出来永远 pass，等于没测",
            layer="M",
        ))


def check_step_budget(doc: dict, findings: list[E.Finding]) -> None:
    """V-16 步骤数预算。"""
    if doc.get("type") != "case":
        return
    budget = doc.get("budget") or {}
    limit = budget.get("max_steps")
    if not isinstance(limit, int):
        return
    n = len(_steps(doc))
    if n > limit:
        findings.append(E.Finding(
            "V-16", E.SEM_STEP_BUDGET_EXCEEDED, "steps",
            f"步骤数 {n} 超过预算 {limit}：应拆分（通常意味着测了太多事，失败难归因）",
            action=E.ACTION_SPLIT_CASE, layer="M",
            extra={"steps": n, "limit": limit},
        ))


# ------------------------------------------------------------------ 计划


def check_gates(doc: dict, findings: list[E.Finding]) -> None:
    """V-17 五闸全绿，且 replay_verified 必须有真实执行记录。"""
    if doc.get("type") != "plan":
        return
    # 只对 approved 生效：draft 阶段闸可以尚未跑完（否则编译中途的产物存不下来）
    if doc.get("status") != "approved":
        return
    gates = doc.get("gates") or {}
    for name in GATES:
        gate = gates.get(name) or {}
        if gate.get("pass") is not True:
            findings.append(E.Finding(
                "V-17", E.SEM_GATE_NOT_PASSED, f"gates.{name}",
                f"闸 `{name}` 未通过：计划只能停在 draft",
                layer="M", extra={"gate": name},
            ))
            return
    replay = gates.get("replay_verified") or {}
    if not replay.get("exec_ref"):
        findings.append(E.Finding(
            "V-17", E.SEM_GATE_EVIDENCE_MISSING, "gates.replay_verified.exec_ref",
            "replay_verified 无 exec_ref：闸可以是人工标的，但没有真实执行记录的 pass 不算数",
            layer="M",
        ))


def check_wait(doc: dict, findings: list[E.Finding]) -> None:
    """V-18 禁止固定时长等待（sleep 已由 V-02 拦，这里管"结构合法但语义是硬等"）。"""
    for i, step in enumerate(_steps(doc)):
        # 显式固定时长动作
        if step.get("action") == "wait" and isinstance(step.get("ms"), (int, float)):
            findings.append(E.Finding(
                "V-18", E.SEM_SLEEP_FORBIDDEN, f"steps[{i}].ms",
                "禁止固定时长等待：应改为类型化等待条件（元素就绪/网络空闲/请求完成）",
                layer="M", extra={"ms": step.get("ms")},
            ))
            return
        # 等待参数过长
        for j, w in enumerate(step.get("wait") or []):
            if not isinstance(w, dict):
                continue
            idle = w.get("idle_ms")
            if isinstance(idle, int) and idle > MAX_IDLE_MS:
                findings.append(E.Finding(
                    "V-18", E.SEM_WAIT_TOO_LONG, f"steps[{i}].wait[{j}].idle_ms",
                    f"等待 {idle}ms 超过 {MAX_IDLE_MS}ms：说明同步策略没学对（flaky 头号来源）",
                    layer="M", extra={"idle_ms": idle, "limit": MAX_IDLE_MS},
                ))
                return


def check_locator(doc: dict, findings: list[E.Finding]) -> None:
    """V-19 禁坐标与层级索引路径。"""
    for i, step in enumerate(_steps(doc)):
        target = step.get("target") or {}
        for j, loc in enumerate(target.get("locators") or []):
            if not isinstance(loc, dict):
                continue
            base = f"steps[{i}].target.locators[{j}]"
            if "coord" in loc:
                findings.append(E.Finding(
                    "V-19", E.SEM_COORDINATE_FORBIDDEN, f"{base}.coord",
                    "禁止坐标定位：分辨率/布局一变即失效",
                    layer="M",
                ))
                return
            for key in ("css", "xpath", "selector"):
                v = loc.get(key)
                if isinstance(v, str) and (v.startswith("/html") or ABSOLUTE_INDEX.search(v)):
                    findings.append(E.Finding(
                        "V-19", E.SEM_ABSOLUTE_PATH_FORBIDDEN, f"{base}.{key}",
                        f"禁止依赖层级索引的定位 `{v}`：加一层 div 就失效",
                        layer="M",
                    ))
                    return


def check_plan_uniqueness(doc: dict, findings: list[E.Finding],
                          store: Store | None = None) -> None:
    """V-37 一个 case 只允许一份 plan（环境差异入 variants/）。"""
    if doc.get("type") != "plan" or store is None:
        return
    if doc.get("is_variant"):
        return
    case_ref = doc.get("case_ref")
    if not case_ref:
        return
    others = [p for p in store.plans_of_case(case_ref) if p.get("id") != doc.get("id")]
    if others:
        findings.append(E.Finding(
            "V-37", E.SEM_MULTIPLE_PLANS_PER_CASE, "case_ref",
            f"{case_ref} 已有计划 {[p['id'] for p in others]}："
            "环境差异必须落在 variants/，否则血缘分裂、重算×环境数",
            action=E.ACTION_USE_VARIANT, layer="M",
        ))


# ------------------------------------------------------------------ 结果


def check_verdict(doc: dict, findings: list[E.Finding]) -> None:
    """V-20 verdict 必须与 decide 断言一致。"""
    if doc.get("type") != "exec":
        return
    if doc.get("verdict") != "pass":
        return
    failed = [
        a for a in (doc.get("assertions") or [])
        if isinstance(a, dict) and a.get("level") == "decide" and a.get("result") != "pass"
    ]
    if failed:
        findings.append(E.Finding(
            "V-20", E.SEM_VERDICT_CONTRADICTS_ASSERT, "verdict",
            f"verdict=pass 但 decide 断言失败 {[a.get('id') for a in failed]}：强制改判 fail",
            action=E.ACTION_FORCE_FAIL, layer="M",
        ))


def check_inconclusive(doc: dict, findings: list[E.Finding]) -> None:
    """V-21 inconclusive 必须有原因；非 inconclusive 不得带原因。"""
    if doc.get("type") != "exec":
        return
    verdict = doc.get("verdict")
    kind = doc.get("inconclusive_kind")
    if verdict == "inconclusive" and not kind:
        findings.append(E.Finding(
            "V-21", E.SEM_INCONCLUSIVE_NO_KIND, "inconclusive_kind",
            "verdict=inconclusive 必须给 inconclusive_kind，否则会被当成没跑，掩盖环境问题",
            layer="M",
        ))
    elif verdict != "inconclusive" and kind:
        findings.append(E.Finding(
            "V-21", E.SEM_KIND_ON_PASS, "inconclusive_kind",
            f"verdict={verdict} 不应携带 inconclusive_kind（状态机写串了会让环境问题统计虚高）",
            layer="M",
        ))


RULES = [
    check_matcher,            # V-35 先于 V-14：matcher 非法时给出更精确的码
    check_expectation_decidable,
    check_decide_assert,
    check_step_budget,
    check_gates,
    check_wait,
    check_locator,
    check_verdict,
    check_inconclusive,
]


def run(doc: Any, store: Store | None = None) -> list[E.Finding]:
    findings: list[E.Finding] = []
    for rule in RULES:
        rule(doc, findings)
        if findings:
            return findings
    check_plan_uniqueness(doc, findings, store)
    return findings
