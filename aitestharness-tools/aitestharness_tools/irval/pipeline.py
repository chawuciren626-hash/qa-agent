"""校验流水线：S → M → X，任一阶段命中即返回（错误码必须正交）。

顺序不是随意的：
1. S 层先跑 —— 结构不合法，语义检查没有意义；
2. M 层次之 —— 单产物内能判定的问题，成本最低；
3. X 层最后 —— 需要查库，最贵，前面能拦就不必查。
"""

from __future__ import annotations

from typing import Any

from . import errors as E
from . import schema_rules, semantic_rules, xref_rules
from .store import Store


def validate(doc: Any, store: Store | None = None,
             registry: set[tuple[str, int]] | None = None) -> E.Result:
    s = schema_rules.validate(doc, registry)
    if not s.accepted:
        return s

    m = semantic_rules.run(doc, store)
    if m:
        return E.Result(False, m)

    if store is not None:
        x = xref_rules.run(doc, store)
        if x:
            return E.Result(False, x)

    return E.Result(True, [])
