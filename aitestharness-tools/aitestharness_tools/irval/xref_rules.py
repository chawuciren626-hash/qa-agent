"""X 层校验规则（V-27、V-30、V-31）：跨产物引用完整性。

这一层是"防伪造"的最后一环：
- 计划可以宣称"重放验证通过"，但那个 exec 记录必须真实存在（V-31）
- 断言可以写得很漂亮，但来源必须指向真实存在的测试点预期（V-30）
- 血缘上游必须存在，否则变更传播算不出来（V-27）
"""

from __future__ import annotations

from typing import Any

from . import errors as E
from .store import Store, parse_ref


def check_derived_from(doc: dict, findings: list[E.Finding], store: Store) -> None:
    """V-27 derived_from 必须指向存在的产物与版本。"""
    for ref in doc.get("derived_from") or []:
        if not isinstance(ref, str):
            continue
        if "@" not in ref:
            findings.append(E.Finding(
                "V-27", E.SCHEMA_REF_VERSION_REQUIRED, "derived_from",
                f"血缘引用 `{ref}` 必须精确到版本（如 `REQ-0045@3`）",
                layer="X",
            ))
            return
        parsed = parse_ref(ref)
        if parsed is None or not store.has_id(parsed[0]):
            findings.append(E.Finding(
                "V-27", E.XREF_MISSING_TARGET, "derived_from",
                f"血缘上游 `{ref}` 不存在",
                layer="X",
            ))
            return
        if store.get(ref) is None:
            findings.append(E.Finding(
                "V-27", E.XREF_VERSION_NOT_FOUND, "derived_from",
                f"血缘上游 `{ref}` 的版本不存在（ID 存在但版本缺失）",
                layer="X",
            ))
            return


def check_assert_source(doc: dict, findings: list[E.Finding], store: Store) -> None:
    """V-30 断言来源必须指向真实存在的 test_point.expected[].id。"""
    if doc.get("type") != "case":
        return
    for i, a in enumerate(doc.get("assertions") or []):
        if not isinstance(a, dict):
            continue
        src = a.get("source")
        if not src or not isinstance(src, str) or "#" not in src:
            findings.append(E.Finding(
                "V-30", E.XREF_ASSERT_SOURCE_INVALID, f"assertions[{i}].source",
                "断言没有可追溯来源：模型很容易直接写断言而不给出处，必须硬拦",
                layer="X",
            ))
            return
        tp_ref, expected_id = src.split("#", 1)
        tp = store.get(tp_ref)
        if tp is None:
            findings.append(E.Finding(
                "V-30", E.XREF_MISSING_TARGET, f"assertions[{i}].source",
                f"断言来源的测试点 `{tp_ref}` 不存在",
                layer="X",
            ))
            return
        ids = {e.get("id") for e in (tp.get("expected") or []) if isinstance(e, dict)}
        if expected_id not in ids:
            findings.append(E.Finding(
                "V-30", E.XREF_ASSERT_SOURCE_INVALID, f"assertions[{i}].source",
                f"来源 `{src}` 中的预期 `{expected_id}` 在 {tp_ref} 中不存在",
                layer="X",
            ))
            return


def check_refs_exist(doc: dict, findings: list[E.Finding], store: Store) -> None:
    """V-31 关键引用完整性（含闸证据必须真实存在）。"""
    itype = doc.get("type")

    def ensure(ref: Any, field: str, code: str = E.XREF_MISSING_TARGET) -> bool:
        if not ref:
            return True
        if store.get(str(ref)) is None:
            findings.append(E.Finding("V-31", code, field,
                                      f"引用 `{ref}` 不存在的产物", layer="X"))
            return False
        return True

    if itype == "plan":
        if not ensure(doc.get("case_ref"), "case_ref"):
            return
        replay_ref = ((doc.get("gates") or {}).get("replay_verified") or {}).get("exec_ref")
        ensure(replay_ref, "gates.replay_verified.exec_ref", E.XREF_GATE_EVIDENCE_NOT_FOUND)
    elif itype == "exec":
        ensure(doc.get("plan_ref"), "plan_ref")
    elif itype == "defect":
        ensure((doc.get("found_by") or {}).get("exec_ref"), "found_by.exec_ref")


def run(doc: Any, store: Store) -> list[E.Finding]:
    findings: list[E.Finding] = []
    check_derived_from(doc, findings, store)
    if findings:
        return findings
    check_assert_source(doc, findings, store)
    if findings:
        return findings
    check_refs_exist(doc, findings, store)
    return findings
