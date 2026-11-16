"""契约 2.5 节：全局枚举字典（封闭）。

原则：新增枚举值 = 契约变更，必须走附录 A 流程。
本模块是**唯一权威来源**，校验器不得内置第二份枚举。
"""

from __future__ import annotations

import re

ENUMS: dict[str, list[str]] = {
    # 公共头
    "type": [
        "requirement", "test_point", "case", "plan",
        "exec", "defect", "report", "risk",
    ],
    "status": ["draft", "reviewing", "approved", "deprecated", "archived"],
    "actor_prefix": ["program", "agent", "human"],
    # 需求
    "requirement_kind": ["functional", "constraint", "non_functional", "compliance"],
    "source_type": ["prd", "openapi", "figma", "ticket", "reverse_engineering", "manual"],
    "priority": ["P0", "P1", "P2", "P3"],
    # 测试点
    "dimension": [
        "functional", "boundary", "exception", "permission", "compatibility",
        "performance", "security", "data_consistency", "usability",
    ],
    "driver_kind": ["web", "api", "native", "miniprogram", "db"],
    "control_type": [
        "input_text", "input_number", "input_date", "select", "radio", "checkbox",
        "button", "link", "table", "upload", "rich_text", "iframe", "canvas", "map",
    ],
    # 执行
    "verdict": ["pass", "fail", "flaky", "skipped", "inconclusive"],
    "step_status": ["pass", "fail", "skipped", "blocked"],
    "inconclusive_kind": [
        "env_unreachable", "precondition_unmet", "session_failed",
        "data_unavailable", "resource_timeout",
    ],
    "wait_type": [
        "element_visible", "element_enabled", "element_stable", "network_idle",
        "request_done", "text_changed", "url_matches", "attribute_equals",
    ],
    "assert_level": ["decide", "observe"],
    "assert_type": [
        "url_matches", "url_contains", "visible", "hidden", "text_visible",
        "text_equals", "value_equals", "attribute_equals", "count_equals",
        "status_code", "json_path", "db_row", "schema_match", "semantic",
    ],
    "action_type": [
        "goto", "click", "fill", "select", "hover", "scroll", "upload", "download",
        "press", "wait", "extract", "request", "db_query", "navigate", "switch_context",
    ],
    # 预期判定（10.1 #1 决议：封闭白名单）
    "matcher": [
        "equals", "not_equals", "contains", "not_contains", "gt", "gte", "lt", "lte",
        "between", "in_set", "regex", "abs_diff", "null", "not_null",
    ],
    "matcher_fn_whitelist": ["abs_diff", "round", "len"],
    # 缺陷
    "defect_category": [
        "product_bug", "script_issue", "env_issue", "data_issue", "flaky", "unknown",
    ],
    "severity": ["S1", "S2", "S3", "S4"],
    "lifecycle": ["open", "confirmed", "fixed", "verified", "closed", "wontfix"],
    "dedup_decision": ["new", "merged", "linked"],
    # 报告（与 exec.verdict 是不同枚举，不能混用一份）
    "report_verdict": ["pass", "conditional", "no_conclusion"],
    # 风险
    "risk_status": ["new", "tracking", "mitigated", "accepted", "escalated", "closed"],
    # 自愈
    "heal_level": ["L1", "L2", "L3"],
}

# matcher 需要配套 matcher_args 的子集（10.1 #1）
MATCHER_REQUIRES_ARGS: dict[str, list[str]] = {
    "between": ["min", "max"],
    "abs_diff": ["tolerance"],
    "regex": ["pattern"],
    "in_set": ["values"],
}

# ---------------------------------------------------------------- 路径 → 枚举

_STEP_WAIT = re.compile(r"^steps\[\d+\]\.wait\[\d+\]\.type$")
_STEP_ASSERT = re.compile(r"^steps\[\d+\]\.assert\[\d+\]\.type$")
_STEP_ASSERT_LV = re.compile(r"^steps\[\d+\]\.assert\[\d+\]\.level$")
_STEP_STATUS = re.compile(r"^steps\[\d+\]\.status$")
_STEP_DRIVER = re.compile(r"^steps\[\d+\]\.driver$")
_STEP_ACTION = re.compile(r"^steps\[\d+\]\.action$")
_VERIF_DRIVER = re.compile(r"^verification\.(primary|secondary\[\d+\])$")


def enum_for_path(path: str) -> str | None:
    """按字段路径判断该用哪份枚举。

    必须路径感知：`type` 在根是产物类型、在 wait 里是等待类型，
    若只按字段名查表会把两者混成一份枚举 —— 这是最容易犯的错。
    """
    if path == "type":
        return "type"
    if path == "status":
        return "status"
    if path == "verdict":
        return "verdict"
    if path == "inconclusive_kind":
        return "inconclusive_kind"
    if path == "priority":
        return "priority"
    if path == "kind":
        return "requirement_kind"
    if path == "dimension":
        return "dimension"
    if path == "lifecycle":
        return "lifecycle"
    if path == "severity":
        return "severity"
    if path == "attribution.category":
        return "defect_category"
    if path == "admission.verdict":
        return "report_verdict"
    if path == "risk_status":
        return "risk_status"
    if _STEP_STATUS.match(path):
        return "step_status"
    if _STEP_DRIVER.match(path):
        return "driver_kind"
    if _STEP_ACTION.match(path):
        return "action_type"
    if _STEP_WAIT.match(path):
        return "wait_type"
    if _STEP_ASSERT.match(path):
        return "assert_type"
    if _STEP_ASSERT_LV.match(path) or re.match(r"^assertions\[\d+\]\.level$", path):
        return "assert_level"
    if _VERIF_DRIVER.match(path):
        return "driver_kind"
    if path == "primary_driver":
        return "driver_kind"
    return None
