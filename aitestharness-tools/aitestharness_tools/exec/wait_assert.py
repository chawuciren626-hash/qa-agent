"""§11.3 / §12.2 四类共用的工具（一）：等待条件库 + 断言引擎 + 定位解析器规则。

⚠ 等待枚举以 v3 §12.2 为准（封闭枚举，不允许 LLM 自由发挥）：
  element_visible / element_enabled / element_stable / network_idle /
  request_done(pattern) / text_changed / url_matches / attribute_equals
见 §12.3 定位解析器三条硬规则：按优先级尝试、多命中拒绝执行、降级必须记录。
"""
from __future__ import annotations

import re

from ..irval.enums import ENUMS

__all__ = ["WAIT_TYPES", "WAIT_DEFAULTS", "check_wait_step", "AssertionEngine",
           "evaluate_assert", "MAX_WAIT_MS", "MAX_WAIT_MS_STRICT",
           "assertion_level", "LocatorResolver"]

# ---- 等待条件库：封闭枚举（严格对齐 v3 §12.2）----
WAIT_TYPES = (
    "element_visible", "element_enabled", "element_stable",   # 元素类
    "network_idle", "request_done",                            # 网络类
    "text_changed",                                            # 文本类
    "url_matches",                                             # 导航类
    "attribute_equals",                                        # 属性类
)
# 每种等待类型的必需参数（缺一即编译期报错，防止"写个类型但不知道等什么"）
WAIT_REQUIRED_ARGS = {
    "element_visible": ("target",),
    "element_enabled": ("target",),
    "element_stable": ("target",),      # 位置尺寸连续 N 帧不变；N 默认 3
    "network_idle": (),                 # idle_ms 默认 500
    "request_done": ("pattern",),       # 如 "GET /api/orders"
    "text_changed": ("target",),
    "url_matches": ("pattern",),
    "attribute_equals": ("target", "attribute", "value"),
}
MAX_WAIT_MS = 30_000
MAX_WAIT_MS_STRICT = 10_000             # duration 兜底上限（保留兜底语义但严格限制）
WAIT_DEFAULTS = {"timeout_ms": 10_000, "poll_interval_ms": 200,
                 "stable_frames": 3, "idle_ms": 500}


def check_wait_step(step: dict) -> list[str]:
    """编译期等待步骤检查：类型封闭 + 必需参数 + 超时上限 + 禁 sleep 语义。

    返回违例列表（空 = 通过）。duration/sleep 不在枚举内 → 直接拒（V-18 禁 sleep）。
    """
    waits = step.get("wait")
    waits = waits if isinstance(waits, list) else ([waits] if waits else [])
    errs = []
    for i, w in enumerate(waits):
        wt = w.get("type") if isinstance(w, dict) else w
        if wt not in WAIT_TYPES:
            errs.append(f"wait[{i}] 类型 '{wt}' 不在 §12.2 封闭枚举 {WAIT_TYPES}"
                        f"（DSL 禁止 driver 专有写法与 sleep）")
            continue
        for arg in WAIT_REQUIRED_ARGS[wt]:
            if w.get(arg) in (None, ""):
                errs.append(f"wait[{i}] ({wt}) 缺必需参数 '{arg}'")
        timeout = (w.get("timeout_ms") or WAIT_DEFAULTS["timeout_ms"])
        if timeout > MAX_WAIT_MS:
            errs.append(f"wait[{i}] timeout_ms={timeout} 超上限 {MAX_WAIT_MS}")
        if wt == "request_done" and w.get("pattern") and not re.match(
                r"^(GET|POST|PUT|PATCH|DELETE)\s+\S+$", str(w["pattern"]).split("?")[0], re.I):
            errs.append(f"wait[{i}] request_done.pattern 应为 'METHOD /path'，"
                        f"收到 {w.get('pattern')!r}")
    return errs


# ---- 断言引擎：decide / observe 两级（§12.4）----
# 关键步骤判定规则（程序判，人工可覆写，不交给 LLM）：
#   正常流程类测试点 → 默认关键；数据校验类 → 强制关键；
#   导航/填充/跳转等支撑性步骤 → 默认非关键
SUPPORT_ACTIONS = {"goto", "navigate", "open", "fill", "click", "hover", "scroll",
                   "switch_context", "press", "wait"}
FORCE_DECIDE_TP_TYPES = ("数据校验", "数据一致性", "边界", "异常", "权限")


def assertion_level(step: dict, test_point_type: str | None = None,
                    manual_override: bool | None = None) -> str:
    """判定断言级别：decide / observe（§12.4 判定权在程序 + 人工可覆写）。

    manual_override 优先（人工覆写）。
    """
    if manual_override is not None:
        return "decide" if manual_override else "observe"
    if test_point_type and any(k in str(test_point_type) for k in FORCE_DECIDE_TP_TYPES):
        return "decide"
    action = str(step.get("action") or step.get("intent") or "").lower()
    if any(a in action for a in SUPPORT_ACTIONS):
        return "observe"
    return "decide"


class AssertionEngine:
    """共用断言引擎：判定逻辑 driver 无关。语义断言结果落 decide 级但必须标注模型判定。"""

    def __init__(self):
        self._matchers = set(ENUMS["matcher"])

    def evaluate(self, actual, assertion: dict) -> dict:
        m = assertion.get("matcher")
        level = assertion.get("level") or ("decide" if assertion.get("decide") else "observe")
        if m not in self._matchers:
            return {"passed": False, "actual": actual, "level": level,
                    "error": f"matcher '{m}' 不在白名单", "source": assertion.get("source")}
        try:
            passed = _apply(actual, m, assertion.get("expected"))
            error = None
        except (TypeError, ValueError) as exc:
            passed, error = False, str(exc)
        res = {"passed": passed, "actual": actual, "error": error, "level": level,
               "source": assertion.get("source")}
        # 语义断言必须可审计：标注由模型判定（§12.4）
        if assertion.get("assert_type") == "semantic" or assertion.get("by_model"):
            res["judged_by"] = "model"
        return res

    def verdict_for(self, results: list[dict]) -> str:
        if any(r.get("level", "decide") == "decide" and not r.get("passed") for r in results):
            return "fail"
        return "pass"


evaluate_assert = AssertionEngine().evaluate


class LocatorResolver:
    """§12.3 定位解析器（编译期规则 + 运行时判定逻辑）。

    三条硬规则：
    1) 按 locators 优先级依次尝试，命中即停；
    2) **多命中必须拒绝执行**（要求唯一性，不允许"取第一个"）；
    3) 每次降级**必须记录**（命中第几个指纹）→ 计入 locator_hit 与健康度。
    全部失效 → locator_not_found，交自愈（仅 L1/L2）。
    """

    def resolve(self, candidates: list[str]) -> dict:
        """candidates：每个指纹的命中数量（按优先级顺序）。
        例：[3, 0, 1] 表示首选命中 3 个（歧义）、次选 0 个、第三选命中 1 个。
        """
        if not candidates:
            return {"status": "locator_not_found", "hit_index": None, "locator_hit": None,
                    "detail": "无候选指纹"}
        for idx, count in enumerate(candidates):
            if count == 1:
                return {"status": "ok", "hit_index": idx,
                        "locator_hit": idx + 1,          # 第 N 个指纹命中（1 起始）
                        "degraded": idx > 0,             # 非首选即降级，必须记录
                        "ambiguity_rejected": [i for i, c in enumerate(candidates[:idx])
                                               if c > 1]}
            if count > 1:
                # 多命中拒绝执行——不允许"取第一个"
                return {"status": "locator_ambiguous", "hit_index": idx,
                        "locator_hit": None,
                        "detail": f"指纹#{idx + 1} 命中 {count} 个元素：多命中拒绝执行，需收紧定位"}
        return {"status": "locator_not_found", "hit_index": None, "locator_hit": None,
                "detail": "全部指纹未命中，交自愈（L1 换指/L2 追加等待）"}


def _apply(actual, matcher: str, expected):
    if matcher == "equals":
        return str(actual) == str(expected)
    if matcher == "not_equals":
        return str(actual) != str(expected)
    if matcher == "contains":
        return str(expected) in str(actual)
    if matcher == "not_contains":
        return str(expected) not in str(actual)
    if matcher == "null":
        return actual is None
    if matcher == "not_null":
        return actual is not None
    if matcher in ("gt", "gte", "lt", "lte"):
        return {"gt": float(actual) > float(expected),
                "gte": float(actual) >= float(expected),
                "lt": float(actual) < float(expected),
                "lte": float(actual) <= float(expected)}[matcher]
    if matcher == "between":
        lo = expected.get("lo") if isinstance(expected, dict) else expected[0]
        hi = expected.get("hi") if isinstance(expected, dict) else expected[1]
        return str(lo) <= str(actual) <= str(hi)
    if matcher == "in_set":
        return str(actual) in {str(x) for x in (expected or [])}
    if matcher == "regex":
        return re.search(str(expected), str(actual)) is not None
    raise ValueError(f"matcher '{matcher}' 需上层展开 matcher_args")
