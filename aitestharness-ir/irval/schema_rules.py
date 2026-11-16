"""S 层校验规则（V-01 ~ V-08、V-38）+ 字段分权（PERM）。

只做**单产物内、静态可判定**的检查，不查库、不调模型。
跨产物检查（V-27/V-30/V-31）在 xref.py，此处不涉及。
"""

from __future__ import annotations

import re
from typing import Any, Iterator

from . import errors as E
from .enums import ENUMS, MATCHER_REQUIRES_ARGS, enum_for_path

# ------------------------------------------------------------------ 常量表

#: 公共头必填（draft 态就要有）
HEADER_REQUIRED: list[str] = [
    "schema_version", "type", "id", "version", "status", "project",
    "module", "derived_from", "content_hash",
    "created_at", "created_by", "updated_at",
]

#: approved 态额外必填
HEADER_APPROVED_REQUIRED = ["approved_by"]

#: 免于人工确认的产物类型。
#: `exec` 是机器事实记录（每次执行产生一条，不可能逐条人工签），
#: 它的"可信"由 V-17 闸与 V-20 断言一致性保证，不靠 approved_by。
#: 这是对契约 2.2 的一处显式澄清（契约原文"approved 态必备 approved_by"未区分类型）。
EXEMPT_APPROVER = {"exec"}

#: ID 格式（按前缀）
ID_PATTERNS: dict[str, str] = {
    "REQ": r"^REQ-\d{4}$",
    "TP": r"^TP-\d{4}-\d{2}$",
    "CASE": r"^CASE-\d{5}$",
    "PLAN": r"^PLAN-\d{5}$",
    "EXEC": r"^EXEC-\d{4}$",
    "DEF": r"^DEF-\d{4}$",
    "RPT": r"^RPT-\d{8}-\d{2}$",
    "RISK": r"^RISK-\d{4}$",
    "FRAG": r"^FRAG-[a-z0-9][a-z0-9-]*$",
    "EV": r"^EV-\d{4}$",
}

TYPE_PREFIX: dict[str, str] = {
    "requirement": "REQ",
    "test_point": "TP",
    "case": "CASE",
    "plan": "PLAN",
    "exec": "EXEC",
    "defect": "DEF",
    "report": "RPT",
    "risk": "RISK",
}

#: approved 态按类型必填的业务字段
APPROVED_REQUIRED: dict[str, list[str]] = {
    "requirement": ["source_ref", "business_rules", "acceptance"],
    "test_point": ["matrix", "expected", "verification", "priority"],
    "case": ["test_point", "primary_driver", "assertions", "budget", "steps"],
    "plan": ["case_ref", "primary_driver", "compiled_from", "gates", "touched", "steps"],
    "exec": ["plan_ref", "verdict", "steps", "assertions", "evidence_ref"],
    "defect": ["found_by", "fingerprint", "attribution", "severity", "lifecycle"],
    "report": ["period", "admission", "execution"],
}

#: 必须为字符串十进制的字段路径（V-38 / V-04）
DECIMAL_PATHS = [
    re.compile(r"^expected\[\d+\]\.value$"),
    re.compile(r"^expected\[\d+\]\.matcher_args(\.[a-z_]+|\[\d+\])$"),
    re.compile(r"^data_constraints\[\d+\]\.range\[\d+\]$"),
    re.compile(r"^business_rules\[\d+\]\.boundary\[\d+\]$"),
    re.compile(r"^acceptance\[\d+\]\.value$"),
]

#: 时间字段（后缀匹配）
TIME_SUFFIX = "_at"

ISO8601_TZ = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)
ISO8601_NAIVE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}")

#: 断言来源：`<TP-id>@<ver>#<E-id>`
ASSERT_SOURCE = re.compile(r"^[A-Z]+-[A-Za-z0-9-]+@\d+#[A-Z]+-\d+$")

#: `${...}` 引用：允许的 namespace
REF_NAMESPACES = {"data", "ctx", "env", "cred"}
REF_NS = re.compile(r"^\$\{(.+)\}$")
REF_NS_NAME = re.compile(r"^([a-z]+)(?=[.:])")

#: 凭证特征（值形态判定，不按字段名判定 —— 否则 `password: ${cred://...}` 会被误杀）
CRED_PATTERNS = [
    re.compile(r"^eyJ[A-Za-z0-9_-]{10,}"),          # JWT
    re.compile(r"LTAI[A-Za-z0-9]{8,}"),             # 阿里云 AccessKey
    re.compile(r"^sk-[A-Za-z0-9]{16,}"),            # OpenAI 风格
    re.compile(r"^ghp_[A-Za-z0-9]{20,}"),           # GitHub PAT
    re.compile(r"Bearer\s+\S{12,}"),                # Bearer token
]
#: 泛化口令特征：大写+小写+数字+强特殊字符（不含 . - / : 等路径友好字符）
PWD_SPECIAL = re.compile(r"[@#$%^&*!_+=?~]")

#: 常见"看起来像口令"的合法标识，必须先排除再套口令启发式。
#: 没有这层白名单，`FRAG-login@2` 会被误判成密码 —— 误杀的代价比漏杀更高，
#: 因为被误杀的规则会被团队直接关掉。
SAFE_VALUE_PATTERNS = [
    re.compile(r"^\$\{.*\}$"),                       # 引用
    re.compile(r"^[a-z]+://"),                        # scheme:// 引用（data/cred/evidence）
    re.compile(r"^[A-Z][A-Z0-9]*(-[A-Za-z0-9.]+)+(#.*)?$"),  # TP-0045-02 / FRAG-login@2
    re.compile(r"^[A-Z][A-Z0-9]*(-[A-Za-z0-9.]+)+@\d+(#.*)?$"),  # 带版本的产物引用
    re.compile(r"^/"),                                # 页面路径
    re.compile(r"^sha256:[0-9a-f]+$"),                # 指纹
    re.compile(r"^[\d.]+$"),                          # 版本号
    re.compile(r"^[a-z0-9][a-z0-9\-_.]*$"),           # 纯小写标识（含 - _ .）
]

ACTOR = re.compile(r"^(program|agent|human):.+$")


# ------------------------------------------------------------------ 工具


def iter_fields(obj: Any, path: str = "") -> Iterator[tuple[str, Any]]:
    """产出 (路径, 叶子值)。路径形如 `steps[0].wait[1].type`。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            child = f"{path}.{k}" if path else str(k)
            yield from iter_fields(v, child)
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            yield from iter_fields(item, f"{path}[{i}]")
    else:
        yield path, obj


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# ------------------------------------------------------------------ 规则


def check_header(doc: dict, findings: list[E.Finding]) -> None:
    """V-01 公共头字段齐全；approved 必须有 human 确认人。"""
    for f in HEADER_REQUIRED:
        if f not in doc:
            findings.append(E.Finding("V-01", E.SCHEMA_HEADER_MISSING, f,
                                      f"公共头缺少必填字段 `{f}`"))
            return  # 一个用例只报一个码
    if doc.get("status") == "approved" and doc.get("type") not in EXEMPT_APPROVER:
        approvers = doc.get("approved_by")
        if not approvers:
            findings.append(E.Finding(
                "V-01", E.SCHEMA_APPROVED_NEEDS_APPROVER, "approved_by",
                "status=approved 必须有至少一个确认人（human）",
            ))


def check_actor(doc: dict, findings: list[E.Finding]) -> None:
    """V-07 actor 格式。"""
    for path, v in iter_fields(doc):
        if path.split(".")[-1] in {"created_by", "approved_by", "answered_by"} or path.endswith("approved_by"):
            values = v if isinstance(v, list) else [v]
            for item in values:
                if not isinstance(item, str) or not ACTOR.match(item):
                    findings.append(E.Finding(
                        "V-07", E.SCHEMA_ACTOR_FORMAT_INVALID, path,
                        f"actor 必须为 program:/agent:/human: 前缀，实际 `{item}`",
                    ))
                    return


def check_id(doc: dict, findings: list[E.Finding],
             registry: set[tuple[str, int]] | None = None) -> None:
    """V-03 ID 前缀、格式、唯一性。"""
    pid = doc.get("id")
    if not isinstance(pid, str):
        findings.append(E.Finding("V-03", E.SCHEMA_ID_FORMAT_INVALID, "id",
                                  "id 必须为字符串"))
        return
    prefix = pid.split("-")[0]
    if prefix not in ID_PATTERNS:
        findings.append(E.Finding(
            "V-03", E.SCHEMA_ID_PREFIX_INVALID, "id",
            f"未知 ID 前缀 `{prefix}`，合法前缀：{sorted(ID_PATTERNS)}",
            extra={"allowed": sorted(ID_PATTERNS)},
        ))
        return
    expected_prefix = TYPE_PREFIX.get(doc.get("type", ""))
    if expected_prefix and prefix != expected_prefix:
        findings.append(E.Finding(
            "V-03", E.SCHEMA_ID_PREFIX_INVALID, "id",
            f"type={doc.get('type')} 的 id 前缀应为 `{expected_prefix}`，实际 `{prefix}`",
        ))
        return
    if not re.match(ID_PATTERNS[prefix], pid):
        findings.append(E.Finding(
            "V-03", E.SCHEMA_ID_FORMAT_INVALID, "id",
            f"ID `{pid}` 不符合格式 `{ID_PATTERNS[prefix]}`",
        ))
        return
    if registry is not None:
        key = (pid, int(doc.get("version", 0)))
        if key in registry:
            findings.append(E.Finding(
                "V-03", E.SCHEMA_ID_DUPLICATE, "id",
                f"`{pid}@v{key[1]}` 已存在：同 ID 同版本禁止重复导入（升版请 +1）",
            ))


def check_time_and_decimal(doc: dict, findings: list[E.Finding]) -> None:
    """V-04 时间格式 + 数值必须字符串十进制。"""
    for path, v in iter_fields(doc):
        leaf = path.split(".")[-1]
        # 时间
        if leaf.endswith(TIME_SUFFIX) and isinstance(v, str):
            if ISO8601_TZ.match(v):
                continue
            code = (E.SCHEMA_TIME_NO_TIMEZONE if ISO8601_NAIVE.match(v)
                    else E.SCHEMA_TIME_FORMAT_INVALID)
            findings.append(E.Finding("V-04", code, path,
                                      f"时间 `{v}` 必须为 ISO8601 且带时区"))
            return
        # 数值
        if _is_number(v) and any(p.match(path) for p in DECIMAL_PATHS):
            findings.append(E.Finding(
                "V-04", E.SCHEMA_NUMBER_NOT_STRING_DECIMAL, path,
                f"数值 `{v}` 必须写成字符串十进制（如 \"{v}\"），避免浮点误差",
            ))
            return


def check_enum(doc: dict, findings: list[E.Finding]) -> None:
    """V-02 枚举封闭。

    `null` 视为"未设置"而不是"非法值"：某字段该不该有值由条件必填规则
    （如 V-21 inconclusive_kind）判定，枚举只管"给了值是否合法"。
    把 null 当非法会让 `inconclusive_kind: null` 这类合法状态被误杀。
    """
    for path, v in iter_fields(doc):
        enum_name = enum_for_path(path)
        if not enum_name:
            continue
        if v is None:
            continue
        allowed = ENUMS[enum_name]
        if not isinstance(v, str) or v not in allowed:
            findings.append(E.Finding(
                "V-02", E.SCHEMA_ENUM_INVALID, path,
                f"`{v}` 不在 {enum_name} 枚举内",
                extra={"allowed": allowed},
            ))
            return


def check_approved_required(doc: dict, findings: list[E.Finding]) -> None:
    """V-06 approved 态按类型必填齐全（draft 允许缺）。"""
    if doc.get("status") != "approved":
        return
    itype = doc.get("type")
    for f in APPROVED_REQUIRED.get(itype, []):
        if f not in doc:
            findings.append(E.Finding(
                "V-06", E.SCHEMA_APPROVED_FIELD_MISSING, f,
                f"type={itype} 的 approved 产物缺少 `{f}`（draft 可缺，approved 不可）",
            ))
            return


def check_credential(doc: dict, findings: list[E.Finding]) -> None:
    """V-05 凭证明文。值形态判定，不按字段名。"""
    for path, v in iter_fields(doc):
        if not isinstance(v, str) or not v:
            continue
        if v.startswith("${"):        # 引用形式，合法
            continue
        if any(p.search(v) for p in CRED_PATTERNS):
            findings.append(E.Finding(
                "V-05", E.SEM_CREDENTIAL_PLAINTEXT, path,
                "疑似凭证明文：只允许 cred:// 引用，禁止落盘",
                action=E.ACTION_ALERT,
            ))
            return
        # 泛化口令特征（先排除合法标识，再套启发式）
        if any(p.match(v) for p in SAFE_VALUE_PATTERNS):
            continue
        if (len(v) >= 8 and " " not in v
                and any(c.isupper() for c in v) and any(c.islower() for c in v)
                and any(c.isdigit() for c in v) and PWD_SPECIAL.search(v)):
            findings.append(E.Finding(
                "V-05", E.SEM_CREDENTIAL_PLAINTEXT, path,
                f"疑似口令明文 `{v}`（大写+小写+数字+特殊字符）",
                action=E.ACTION_ALERT,
            ))
            return


def check_ref(doc: dict, findings: list[E.Finding]) -> None:
    """V-08 引用语法：`${ns.key}` 白名单；断言来源必须精确到版本。"""
    # 1) ${...} namespace
    for path, v in iter_fields(doc):
        if not isinstance(v, str):
            continue
        m = REF_NS.match(v)
        if not m:
            continue
        inner = m.group(1)
        ns_m = REF_NS_NAME.match(inner)
        ns = ns_m.group(1) if ns_m else None
        if ns not in REF_NAMESPACES:
            findings.append(E.Finding(
                "V-08", E.SCHEMA_REF_NAMESPACE_INVALID, path,
                f"引用 `${{{inner}}}` 的 namespace 非法，允许：{sorted(REF_NAMESPACES)}",
            ))
            return
    # 2) 断言来源
    for i, a in enumerate(doc.get("assertions") or []):
        if not isinstance(a, dict):
            continue
        src = a.get("source")
        if src is None:
            continue  # 由 V-30 处理（来源缺失/无效）
        if not isinstance(src, str) or "@" not in src:
            findings.append(E.Finding(
                "V-08", E.SCHEMA_REF_VERSION_REQUIRED, f"assertions[{i}].source",
                "断言来源必须精确到版本，形如 `TP-0045-02@1#E-01`",
            ))
            return
        if not ASSERT_SOURCE.match(src):
            findings.append(E.Finding(
                "V-08", E.SCHEMA_REF_VERSION_REQUIRED, f"assertions[{i}].source",
                f"断言来源格式非法 `{src}`，应为 `<TP-id>@<ver>#<E-id>`",
            ))
            return


def check_expectation_provenance(doc: dict, findings: list[E.Finding]) -> None:
    """V-39 前置：`expected[].source/state` 与 `verdict_cap` 的**结构**校验（v1.1）。

    只管形状与自相矛盾，不管枚举取值——取值合法性由 V-02 按路径判定，
    重复判定会让同一个错误报两个码，破坏"一个用例只触发一个码"的正交约定。

    三条这里必须拦的自相矛盾：

    1. `source` 写成字符串。常见错法是把 `assertions[].source`（引用型）
       的写法照搬到 `expected[].source`（对象型）。**报错而不是猜**——
       猜错的后果是溯源信息静默变成一句 `TP-x@1#E-01` 文本。
    2. 有 `state: verified` 却没有 `source`。R1 说得很清楚：无源即无信，
       没有来源却标已确认，等于自己给自己发信用证明。
    3. `source.type: model` 配 `state: verified`。这是 R2 的唯一硬点：
       模型生成的预期只能由人转正，程序不得代劳。
    """
    # ---- test_point.expected[] ----
    for i, item in enumerate(doc.get("expected") or []):
        if not isinstance(item, dict):
            continue
        source = item.get("source")
        state = item.get("state")

        if source is not None and not isinstance(source, dict):
            findings.append(E.Finding(
                "V-39", E.SCHEMA_EXPECT_SOURCE_INVALID, f"expected[{i}].source",
                "`expected[].source` 必须是对象 `{type, ref, quote}`；"
                "若想写引用请用 `case.assertions[].source`（两者语义不同，见契约附录 C）",
            ))
            return

        if isinstance(source, dict):
            if "type" not in source:
                findings.append(E.Finding(
                    "V-39", E.SCHEMA_EXPECT_SOURCE_INVALID, f"expected[{i}].source.type",
                    "`source` 必须给 `type`（doc/human/derived/model），否则无法判断这条预期凭什么可信",
                ))
                return
            # R2：模型推导不得自证
            if source.get("type") == "model" and state == "verified":
                findings.append(E.Finding(
                    "V-39", E.SCHEMA_EXPECT_SOURCE_INVALID, f"expected[{i}].state",
                    "`source.type=model` 不能标 `verified`——模型推测的预期只能由人转正（R2）",
                ))
                return

        # R1：无源不得 verified
        if state == "verified" and source is None:
            findings.append(E.Finding(
                "V-39", E.SCHEMA_EXPECT_SOURCE_INVALID, f"expected[{i}].state",
                "没有 `source` 却标 `verified`——无源即无信（R1），请补来源或改回 `unverified`",
            ))
            return

    # ---- exec.verdict_cap ----
    cap = doc.get("verdict_cap")
    if cap is None:
        return
    if not isinstance(cap, dict):
        findings.append(E.Finding(
            "V-39", E.SCHEMA_VERDICT_CAP_INVALID, "verdict_cap",
            "`verdict_cap` 必须是对象 `{ceiling, applied, reason, unverified_assertions}`",
        ))
        return
    if "applied" in cap and not isinstance(cap["applied"], bool):
        findings.append(E.Finding(
            "V-39", E.SCHEMA_VERDICT_CAP_INVALID, "verdict_cap.applied",
            "`applied` 必须是布尔——写 `\"false\"` 字符串会被当成真值，压低的结论就漏报了",
        ))
        return
    asserts = cap.get("unverified_assertions")
    if asserts is not None and not isinstance(asserts, list):
        findings.append(E.Finding(
            "V-39", E.SCHEMA_VERDICT_CAP_INVALID, "verdict_cap.unverified_assertions",
            "`unverified_assertions` 必须是断言 id 数组（人工照它定点确认）",
        ))
        return


# ------------------------------------------------------------------ 主入口

RULES = [
    ("V-01", check_header),
    ("V-07", check_actor),
    ("V-03", check_id),
    ("V-04", check_time_and_decimal),
    ("V-02", check_enum),
    ("V-06", check_approved_required),
    ("V-05", check_credential),
    ("V-08", check_ref),
    ("V-39", check_expectation_provenance),
]


def validate(doc: Any, registry: set[tuple[str, int]] | None = None) -> E.Result:
    """执行 S 层全部校验。返回首个错误的 Result（错误码正交）。"""
    findings: list[E.Finding] = []

    if not isinstance(doc, dict):
        findings.append(E.Finding("V-01", E.SCHEMA_HEADER_MISSING, None,
                                  "产物顶层必须是 mapping"))
        return E.Result(False, findings)

    check_header(doc, findings)
    if findings:
        return E.Result(False, findings)

    check_actor(doc, findings)
    check_id(doc, findings, registry)
    check_time_and_decimal(doc, findings)
    check_enum(doc, findings)
    check_approved_required(doc, findings)
    check_credential(doc, findings)
    check_ref(doc, findings)
    if findings:
        return E.Result(False, findings)

    # v1.1：溯源结构与 verdict_cap 形状。放在最后——前面的结构问题
    # （缺字段、枚举非法）会让溯源判断本身失真，先报更精确的码。
    check_expectation_provenance(doc, findings)

    return E.Result(not findings, findings)
