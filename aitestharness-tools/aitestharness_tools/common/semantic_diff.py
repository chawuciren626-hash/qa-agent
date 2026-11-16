"""语义 diff：判断需求/测试点变更是"表述变更"还是"语义变更"。

对应 v3 方案：需求变更场景 → 只有语义变更才触发下游（测试点/用例/计划）重算；
表述变更仅更新原文与 fingerprint，产物血缘不动，人工确认卡点不被无谓打扰。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .lineage import semantic_fingerprint

__all__ = ["FieldChange", "ChangeClass", "semantic_diff", "classify_change"]

# 语义等价：只影响呈现、不影响测试意义的字段（改动不触发重算）
PRESENTATION_FIELDS = {"description_raw", "title_raw", "notes", "comment", "markdown_src"}


@dataclass
class FieldChange:
    field: str
    before: object
    after: object
    cls: str = "none"            # none / presentation / semantic
    fingerprint_before: str | None = None
    fingerprint_after: str | None = None


def classify_change(path: str, before, after) -> FieldChange:
    ch = FieldChange(field=path, before=before, after=after)
    ch.fingerprint_before = semantic_fingerprint(str(before)) if before is not None else None
    ch.fingerprint_after = semantic_fingerprint(str(after)) if after is not None else None
    leaf = path.split(".")[-1]
    if before == after:
        ch.cls = "none"
    elif leaf in PRESENTATION_FIELDS or ch.fingerprint_before == ch.fingerprint_after:
        ch.cls = "presentation"
    else:
        ch.cls = "semantic"
    return ch


def semantic_diff(old: dict, new: dict, prefix: str = "") -> list[FieldChange]:
    """递归对比两份 IR，输出逐字段变更及分类。列表按 index 展开（.0/.1…）。"""
    changes: list[FieldChange] = []
    keys = set(old.keys()) | set(new.keys()) if isinstance(old, dict) and isinstance(new, dict) else set()
    for k in sorted(keys):
        path = f"{prefix}.{k}" if prefix else k
        o, n = old.get(k) if isinstance(old, dict) else None, new.get(k) if isinstance(new, dict) else None
        if isinstance(o, dict) and isinstance(n, dict):
            changes.extend(semantic_diff(o, n, path))
        elif isinstance(o, list) and isinstance(n, list):
            for i in range(max(len(o), len(n))):
                oi = o[i] if i < len(o) else None
                ni = n[i] if i < len(n) else None
                if isinstance(oi, dict) and isinstance(ni, dict):
                    changes.extend(semantic_diff(oi, ni, f"{path}.{i}"))
                else:
                    c = classify_change(f"{path}.{i}", oi, ni)
                    if c.cls != "none":
                        changes.append(c)
        else:
            c = classify_change(path, o, n)
            if c.cls != "none":
                changes.append(c)
    return changes


def needs_recompute(changes: list[FieldChange], watch_prefixes: list[str] | None = None) -> bool:
    """是否存在语义变更。watch_prefixes：只关心某些前缀时传入，如 ["acceptance","api"]。"""
    for ch in changes:
        if ch.cls != "semantic":
            continue
        if watch_prefixes is None or any(ch.field.startswith(p) for p in watch_prefixes):
            return True
    return False
