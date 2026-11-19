"""定位指纹 → 与驱动无关的查询描述（§12.3 三条硬规则的前半段）。

**指纹不是选择器语法**，这个区分是这套东西能不能活过改版的分水岭：

  · 写 `{testid: login-submit}`、`{role: button, name: 登录}`——描述"这是个什么元素"；
  · 不写 `css: "div:nth-child(3) > button"` 当唯一依据——描述"它在第几个坑位"，
    改一次版就断，而且断的时候没人知道它本来想点的是"登录"。

三个硬规则在这里落地：

  1. **按优先级依次尝试，命中即停**：指纹列表的顺序就是优先级，第一个唯一命中即采用；
  2. **多命中拒绝执行**：命中 2 个及以上不取第一个，直接判 ambiguous。取第一个的写法
     在真机上表现为"偶尔点到旁边的按钮"，是最难复现也最难归因的一类假通过；
  3. **每次降级必须记录**：用了第 2、3 个指纹就是降级，必须带 `locator_hit` 出去，
     否则"定位器退化"这件事永远只在事故复盘时才被发现。

本模块是纯函数 + 一次计数回调，不 import playwright：规则可以在没有浏览器的机器上测。
"""
from __future__ import annotations

from typing import Any, Callable, Mapping

from .wait_assert import LocatorResolver

__all__ = ["LOCATOR_KEYS", "LocatorSpecError", "fingerprint_query", "describe_query",
           "resolve_target", "target_locators"]

# 封闭枚举：新增一个键 = 规范变更，必须同时补驱动侧的映射
LOCATOR_KEYS = ("testid", "role", "label", "text", "placeholder",
                "id", "name", "css", "alt", "title")

# 这些键描述的"策略"互斥：同一个指纹里写两个，说明作者没想清楚要按什么找
_EXCLUSIVE = ("testid", "label", "text", "placeholder", "id", "name", "css", "alt", "title")


class LocatorSpecError(ValueError):
    """指纹写错（未知键/多策略/空值）。这是编译期错误，不该等到执行时才暴露。"""


def fingerprint_query(fingerprint: Any) -> dict:
    """把一个指纹编译成查询描述：`{"kind": ..., "value": ..., "name": ...}`。"""
    if not isinstance(fingerprint, Mapping):
        raise LocatorSpecError(f"定位指纹必须是映射，收到 {type(fingerprint).__name__}")
    keys = list(fingerprint)
    unknown = [k for k in keys if k not in LOCATOR_KEYS]
    if unknown:
        raise LocatorSpecError(
            f"定位指纹含未知键 {unknown}；允许的键：{list(LOCATOR_KEYS)}"
            f"（未知键静默忽略的表现是'元素找不到'，排查方向会全错）")
    if "role" in fingerprint:
        # role + name 是一对（name 是可访问名，不是独立策略），其余键都不许并存
        extra = [k for k in keys if k not in ("role", "name")]
        if extra:
            raise LocatorSpecError(f"role 指纹不能同时带 {extra}：一个指纹只描述一种策略")
        role = fingerprint.get("role")
        if not role:
            raise LocatorSpecError("role 指纹缺少 role 值")
        return {"kind": "role", "value": str(role),
                "name": str(fingerprint["name"]) if fingerprint.get("name") else None}
    used = [k for k in _EXCLUSIVE if k in fingerprint]
    if not used:
        raise LocatorSpecError(f"定位指纹为空或只有 name：{dict(fingerprint)}"
                               f"（name 只能配合 role 使用）")
    if len(used) > 1:
        raise LocatorSpecError(f"定位指纹含多个策略 {used}：一个指纹只能描述一种策略，"
                               f"多种策略请拆成多个指纹按优先级排列")
    key = used[0]
    value = fingerprint.get(key)
    if value in (None, ""):
        raise LocatorSpecError(f"定位指纹 {key} 的值为空")
    return {"kind": key, "value": str(value)}


def describe_query(query: dict | None) -> str:
    """给日志/证据用的可读描述。"""
    if not query:
        return "(未命中)"
    kind, value = query.get("kind"), query.get("value")
    if kind == "role":
        return f"role={value}[name={query.get('name')}]" if query.get("name") else f"role={value}"
    return f"{kind}={value}"


def target_locators(target: Any) -> tuple[list[dict], str | None]:
    """从 step.target 里取出指纹列表与 url。

    两种写法都接受：
      target: {locators: [...], url: /x}      # 推荐的完整形态
      target: {testid: login-form}            # 单指纹简写（常见于手写剧本）
    """
    if not isinstance(target, Mapping):
        raise LocatorSpecError(f"step.target 必须是映射，收到 {type(target).__name__}")
    url = str(target["url"]) if target.get("url") else None
    if target.get("locators"):
        raw = target["locators"]
        if not isinstance(raw, (list, tuple)):
            raise LocatorSpecError("target.locators 必须是列表（按优先级排列）")
        return [dict(item) if isinstance(item, Mapping) else item for item in raw], url
    rest = {k: v for k, v in target.items() if k != "url"}
    if rest:
        return [rest], url
    return [], url


def resolve_target(counts: Callable[[list[dict]], list[int]],
                   locators: list[dict]) -> dict:
    """按优先级定位：`counts(queries) -> [命中数...]` 由驱动提供。

    返回 LocatorResolver 的判定 + 命中的查询 + 逐指纹命中数（进 evidence）。
    """
    queries = [fingerprint_query(fp) for fp in locators]
    if not queries:
        return {"status": "locator_not_found", "hit_index": None, "locator_hit": None,
                "query": None, "counts": [], "detail": "步骤未声明任何定位指纹"}
    hits = list(counts(queries))
    if len(hits) != len(queries):
        raise ValueError(f"计数回调返回 {len(hits)} 个结果，与 {len(queries)} 个指纹不符")
    decision = LocatorResolver().resolve(hits)
    decision["counts"] = hits
    decision["query"] = (queries[decision["hit_index"]]
                         if decision.get("hit_index") is not None and
                         decision.get("status") == "ok" else None)
    if decision.get("status") != "ok":
        decision["detail"] = (f"{decision.get('detail')}；逐指纹命中数={hits}"
                              f"（{', '.join(describe_query(q) for q in queries)}）")
    return decision
