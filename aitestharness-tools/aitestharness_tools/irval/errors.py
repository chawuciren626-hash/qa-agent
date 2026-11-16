"""错误码与校验结果模型。

错误码必须**正交**：一个用例只应触发一个码。
实现里若同时报多个码，说明规则边界没划清 —— 调规则，不要改用例。
"""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field as dc_field
from typing import Any

# ------------------------------------------------------------------ 错误码

# S 层（schema，静态）
SCHEMA_HEADER_MISSING = "SCHEMA_HEADER_MISSING"
SCHEMA_APPROVED_NEEDS_APPROVER = "SCHEMA_APPROVED_NEEDS_APPROVER"
SCHEMA_APPROVED_FIELD_MISSING = "SCHEMA_APPROVED_FIELD_MISSING"
SCHEMA_ENUM_INVALID = "SCHEMA_ENUM_INVALID"
SCHEMA_ID_PREFIX_INVALID = "SCHEMA_ID_PREFIX_INVALID"
SCHEMA_ID_FORMAT_INVALID = "SCHEMA_ID_FORMAT_INVALID"
SCHEMA_ID_DUPLICATE = "SCHEMA_ID_DUPLICATE"
SCHEMA_TIME_NO_TIMEZONE = "SCHEMA_TIME_NO_TIMEZONE"
SCHEMA_TIME_FORMAT_INVALID = "SCHEMA_TIME_FORMAT_INVALID"
SCHEMA_NUMBER_NOT_STRING_DECIMAL = "SCHEMA_NUMBER_NOT_STRING_DECIMAL"
SCHEMA_FLOAT_NUMBER = "SCHEMA_FLOAT_NUMBER"
SCHEMA_ACTOR_FORMAT_INVALID = "SCHEMA_ACTOR_FORMAT_INVALID"
SCHEMA_REF_NAMESPACE_INVALID = "SCHEMA_REF_NAMESPACE_INVALID"
SCHEMA_REF_VERSION_REQUIRED = "SCHEMA_REF_VERSION_REQUIRED"
SCHEMA_DUPLICATE_KEY = "SCHEMA_DUPLICATE_KEY"

# M 层（语义，单产物内）
SEM_CREDENTIAL_PLAINTEXT = "SEM_CREDENTIAL_PLAINTEXT"
SEM_NO_DECIDE_ASSERT = "SEM_NO_DECIDE_ASSERT"
SEM_EXPECTATION_NOT_DECIDABLE = "SEM_EXPECTATION_NOT_DECIDABLE"
SEM_STEP_BUDGET_EXCEEDED = "SEM_STEP_BUDGET_EXCEEDED"
SEM_GATE_NOT_PASSED = "SEM_GATE_NOT_PASSED"
SEM_GATE_EVIDENCE_MISSING = "SEM_GATE_EVIDENCE_MISSING"
SEM_SLEEP_FORBIDDEN = "SEM_SLEEP_FORBIDDEN"
SEM_WAIT_TOO_LONG = "SEM_WAIT_TOO_LONG"
SEM_ABSOLUTE_PATH_FORBIDDEN = "SEM_ABSOLUTE_PATH_FORBIDDEN"
SEM_COORDINATE_FORBIDDEN = "SEM_COORDINATE_FORBIDDEN"
SEM_VERDICT_CONTRADICTS_ASSERT = "SEM_VERDICT_CONTRADICTS_ASSERT"
SEM_INCONCLUSIVE_NO_KIND = "SEM_INCONCLUSIVE_NO_KIND"
SEM_KIND_ON_PASS = "SEM_KIND_ON_PASS"
SEM_MATCHER_NOT_WHITELISTED = "SEM_MATCHER_NOT_WHITELISTED"
SEM_MATCHER_ARGS_MISSING = "SEM_MATCHER_ARGS_MISSING"
SEM_REGEX_UNSAFE = "SEM_REGEX_UNSAFE"
SEM_MULTIPLE_PLANS_PER_CASE = "SEM_MULTIPLE_PLANS_PER_CASE"

# X 层（跨产物）
XREF_MISSING_TARGET = "XREF_MISSING_TARGET"
XREF_VERSION_NOT_FOUND = "XREF_VERSION_NOT_FOUND"
XREF_ASSERT_SOURCE_INVALID = "XREF_ASSERT_SOURCE_INVALID"
XREF_GATE_EVIDENCE_NOT_FOUND = "XREF_GATE_EVIDENCE_NOT_FOUND"

# 权限
PERM_AGENT_WROTE_PROGRAM_FIELD = "PERM_AGENT_WROTE_PROGRAM_FIELD"

# 处置动作用语（固定枚举，避免实现自造）
ACTION_REJECT = "rejected"
ACTION_ACCEPT = "accepted"
ACTION_FORCE_FAIL = "force_fail"
ACTION_ALERT = "alert"
ACTION_SPLIT_CASE = "split_case"
ACTION_USE_VARIANT = "use_variant"


@dataclass
class Finding:
    """一条校验发现。字段名与用例集的 `expected` 对齐。"""

    rule: str
    code: str
    field: str | None = None
    message: str = ""
    action: str = ACTION_REJECT
    layer: str = "S"
    extra: dict[str, Any] = dc_field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = {
            "rule": self.rule,
            "code": self.code,
            "field": self.field,
            "action": self.action,
            "layer": self.layer,
            "message": self.message,
        }
        if self.extra:
            d["extra"] = self.extra
        return d


@dataclass
class Result:
    """校验结果：accepted 或 rejected + 首个错误码。"""

    accepted: bool
    findings: list[Finding] = dc_field(default_factory=list)

    @property
    def code(self) -> str | None:
        return self.findings[0].code if self.findings else None

    @property
    def field(self) -> str | None:
        return self.findings[0].field if self.findings else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "result": ACTION_ACCEPT if self.accepted else ACTION_REJECT,
            "code": self.code,
            "field": self.field,
            "findings": [f.to_dict() for f in self.findings],
        }


class LoadError(Exception):
    """YAML 加载阶段错误（V-38 必须在解析时捕获，不能解析后再查）。"""

    def __init__(self, code: str, field: str | None, message: str,
                 line: int | None = None, column: int | None = None):
        super().__init__(message)
        self.code = code
        self.field = field
        self.message = message
        self.line = line
        self.column = column

    def to_finding(self, rule: str = "V-38") -> Finding:
        return Finding(
            rule=rule,
            code=self.code,
            field=self.field,
            message=self.message,
            action=ACTION_REJECT,
            layer="S",
            extra={"line": self.line, "column": self.column},
        )
