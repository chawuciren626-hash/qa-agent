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


def _expectation_fingerprint(item: dict) -> tuple:
    """预期的「实质内容」指纹。

    故意**不含** `source` / `state`：补一个原文引用、或把人确认过的
    `unverified` 转成 `verified`，这不是"改了预期"，不该计入漂移次数。
    计入的话，越是认真做溯源的团队越容易被判漂移——激励反了。
    """
    return (
        item.get("observable"),
        item.get("matcher"),
        repr(item.get("matcher_args")),
        item.get("value"),
        item.get("statement"),
    )


def check_expect_drift(doc: dict, findings: list[E.Finding], store: Store) -> None:
    """V-40 `EXPECT_DRIFT`：预期反复改动必须标 drifted（v1.1）。

    规则原文（§6.4 R5）：同一 `case_id` 的 `expected` 在一个版本周期内
    变更 ≥2 次 → 标 `drifted`，强制人工复核并进报告。

    为什么是「≥2 次」而不是「≥1 次」：改一次大概率是修笔误，改两次
    以上更像是"改到能过"。这条规则防的不是正常修订，是**通过率被改
    成噪声**——三个月后 95% 通过但缺陷密度不变，就是从这里开始的。

    本实现的简化：用 store 里已有的全部版本作为"一个版本周期"，
    内存 store 没有时间维度。接真实库时应改为按 `updated_at` 窗口切片，
    并在报告里写明窗口起止——否则"改了 2 次"这句话没有时间边界。
    """
    if doc.get("type") != "test_point":
        return
    pid = doc.get("id")
    if not isinstance(pid, str):
        return
    history = store.versions_of(pid)
    if len(history) < 3:
        # 至少要有 3 个版本才可能出现"变更 ≥2 次"
        return

    current = {e.get("id"): (i, e) for i, e in enumerate(doc.get("expected") or []) if isinstance(e, dict)}

    for exp_id, (index, item) in current.items():
        seen: list[tuple] = []
        for version_doc in history:
            for old in version_doc.get("expected") or []:
                if not isinstance(old, dict) or old.get("id") != exp_id:
                    continue
                fp = _expectation_fingerprint(old)
                if not seen or seen[-1] != fp:
                    seen.append(fp)
        changes = max(0, len(seen) - 1)
        if changes < 2:
            continue
        if item.get("state") == "drifted":
            continue        # 已按规则标注，符合要求
        findings.append(E.Finding(
            "V-40", E.EXPECT_DRIFT, f"expected[{index}].state",
            f"预期 `{exp_id}` 已变更 {changes} 次（≥2），必须标 `state: drifted` 并人工复核；"
            "反复改预期直到通过，会让通过率失去含义",
            layer="X",
            extra={"expected_id": exp_id, "changes": changes, "versions": len(history)},
        ))
        return


def check_unverified_pass_xref(doc: dict, findings: list[E.Finding], store: Store) -> None:
    """V-39 `EXPECT_UNVERIFIED_PASS`（跨产物版）：真去查预期有没有被确认。

    链路：`exec.plan_ref` → plan → `case_ref` → case.assertions[level=decide]
    → 每条 `source` = `TP-x@v#E-y` → test_point.expected[E-y].state

    判据（R4 一票通过制）：至少一条 decide 断言的 expected 是 `verified`；
    一条都没有，这个 pass 就是在替模型自己的猜测背书。

    **链路断了不报 V-39**：plan/case 取不到是 V-31 的职责，在这里顺手报
    会让同一个缺陷出两个码，违反"一个用例只触发一个码"。
    """
    if doc.get("type") != "exec" or doc.get("verdict") != "pass":
        return
    plan = store.get(str(doc.get("plan_ref"))) if doc.get("plan_ref") else None
    if plan is None:
        return
    case = store.get(str(plan.get("case_ref"))) if plan.get("case_ref") else None
    if case is None:
        return

    decide = [
        a for a in (case.get("assertions") or [])
        if isinstance(a, dict) and a.get("level") == "decide"
    ]
    if not decide:
        return        # 无 decide 断言由 V-15 管

    verified: list[str] = []
    unverified: list[str] = []
    explicit_state = 0
    for a in decide:
        src = a.get("source")
        if not isinstance(src, str) or "#" not in src:
            unverified.append(str(a.get("id")))
            continue
        tp_ref, expected_id = src.split("#", 1)
        tp = store.get(tp_ref)
        if tp is None:
            continue          # 缺产物：V-30 管
        item = next(
            (e for e in (tp.get("expected") or [])
             if isinstance(e, dict) and e.get("id") == expected_id),
            None,
        )
        if item is None:
            continue          # id 不存在：V-30 管
        state = item.get("state")
        if state is not None:
            explicit_state += 1
        if state == "verified":
            verified.append(str(a.get("id")))
        else:
            unverified.append(str(a.get("id")))

    if verified:
        return

    # 「从未评估」与「已记录为未确认」必须分开处置：
    #
    #   一条都没填 state  → 历史债务。说明这套溯源机制上线前就产生了这条 exec，
    #                        没有人说过"确认过"也没有人说过"没确认"。这里硬拦，
    #                        等于上线当天把所有历史用例判红，规则会立刻被关掉。
    #                        正确处置是：不进冒烟集（R1）+ 报告单列债务，不在这里拦。
    #
    #   填了 state 但都不 verified → 明确的违规。产物自己说了"没确认"，
    #                                结论却还是 pass（R3/R4），必须拦。
    if not explicit_state:
        return

    findings.append(E.Finding(
        "V-39", E.EXPECT_UNVERIFIED_PASS, "verdict",
        f"{explicit_state} 条 decide 断言引用的预期已标注未确认 {unverified}，"
        "本次 pass 等于替模型自己的推测背书（R4：一票通过制）——"
        "结论应降为 inconclusive，并在报告里列出待确认清单",
        action=E.ACTION_FORCE_INCONCLUSIVE,
        layer="X",
        extra={"unverified_assertions": unverified, "explicit_state": explicit_state},
    ))


def run(doc: Any, store: Store) -> list[E.Finding]:
    findings: list[E.Finding] = []
    check_derived_from(doc, findings, store)
    if findings:
        return findings
    check_assert_source(doc, findings, store)
    if findings:
        return findings
    check_refs_exist(doc, findings, store)
    if findings:
        return findings
    check_unverified_pass_xref(doc, findings, store)
    if findings:
        return findings
    check_expect_drift(doc, findings, store)
    return findings
