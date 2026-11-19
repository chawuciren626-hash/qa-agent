"""一致性复跑的**选择规则**：哪些步骤允许被重复执行。

一致性检查的做法是"把同一步骤再跑几次，看结论是否稳定"。这在只读接口上完全无害，
在写接口上等于**重复制造副作用**：`POST /api/orders` 复跑两次就是多两张订单；
`click 提交` 复跑就是重复提交。副作用一旦产生，接着坏掉的是两件事：

  · 下一轮的基线指纹（数据变了 → preflight 报 blocking，其实是自己制造的漂移，
    而且会被当成"环境不稳定"排查半天）；
  · 真实缺陷被幂等逻辑掩盖（"重复提交被去重"看起来是"稳定通过"）。

所以复跑不是默认行为，而是一个**需要声明的许可**：

  1. 步骤显式 `idempotent: true` → 允许（写接口但确实幂等，由计划作者负责）；
  2. 步骤显式 `idempotent: false` → 拒绝（即使是 GET 也不复跑，尊重显式声明）；
  3. 未声明时按语义推断：api 的 GET/HEAD/OPTIONS 是 RFC 9110 定义的**安全方法**，
     允许；其余（含全部 web 动作）视为有副作用，拒绝。

推断只覆盖"按协议不可能有副作用"的情形。反过来做（默认可复跑、出问题再关）
会在第一次接真实环境时就写脏数据，而脏数据是可比性链最难回滚的破坏。
"""
from __future__ import annotations

import re

__all__ = ["SAFE_API_METHODS", "REPEATABLE_WEB_ACTIONS",
           "step_allows_repeat", "pick_repeatable", "not_verified_note"]

# RFC 9110 §9.2.1：safe methods —— 语义上只读，允许客户端重复发起
SAFE_API_METHODS = ("GET", "HEAD", "OPTIONS")

# web 侧没有任何动作是天然安全的：goto 会触发埋点与服务端会话，click 会提交。
# 唯一可复跑的是"只读观测"类动作，而它们在本引擎里不是独立步骤（见 web_engine）。
REPEATABLE_WEB_ACTIONS: tuple[str, ...] = ()

_METHOD_RE = re.compile(r"^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+", re.I)


def _api_method(step: dict) -> str:
    request = str(step.get("request") or "")
    matched = _METHOD_RE.match(request)
    if matched:
        return matched.group(1).upper()
    return str(step.get("method") or "GET").upper()


def step_allows_repeat(step: dict, driver: str = "api") -> tuple[bool, str]:
    """返回 (是否允许复跑, 理由)。理由要能直接写进 exec IR 供归因。"""
    declared = step.get("idempotent")
    if declared is True:
        return True, "步骤声明 idempotent=true"
    if declared is False:
        return False, "步骤声明 idempotent=false，尊重显式声明"
    if driver == "api":
        method = _api_method(step)
        if method in SAFE_API_METHODS:
            return True, f"{method} 属 RFC 9110 安全方法，重复执行不产生副作用"
        return False, (f"{method} 非安全方法，未声明 idempotent=true 时不复跑"
                       f"（复跑会重复写入，污染下一轮基线）")
    action = str(step.get("action") or "").strip()
    if action in REPEATABLE_WEB_ACTIONS:
        return True, f"web 动作 {action} 为只读观测"
    return False, f"web 动作 {action or '(未声明)'} 可能改变页面或服务端状态，需显式 idempotent=true"


def pick_repeatable(steps: list[dict], driver: str = "api") -> dict | None:
    """挑第一个"有 decide 断言且允许复跑"的步骤；没有则返回 None。

    优先挑带 decide 断言的步骤：没有断言的步骤复跑只能证明"能点两次"，
    证明不了结论可复现，白花时间还制造副作用。
    """
    for index, step in enumerate(steps or []):
        if not any(a.get("decide") or a.get("level") == "decide"
                   for a in (step.get("assert") or [])):
            continue
        allowed, reason = step_allows_repeat(step, driver)
        if allowed:
            return {"index": index, "step": step, "reason": reason}
    return None


def not_verified_note(steps: list[dict], driver: str = "api") -> str:
    """给"没有可复跑步骤"一句能落到报告里的解释，而不是静默记 pass。"""
    reasons = []
    for step in steps or []:
        allowed, reason = step_allows_repeat(step, driver)
        if not allowed:
            reasons.append(reason)
    if not reasons:
        return "计划里没有带 decide 断言的步骤，无可复跑对象"
    first = reasons[0]
    return f"无可复跑步骤，未做一致性验证（{first}）"
