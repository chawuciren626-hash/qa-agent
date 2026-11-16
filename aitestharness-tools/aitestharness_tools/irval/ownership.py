"""字段分权（契约 0.2 铁律 1）。

`writer` 分 `program` / `agent` / `human` 三类。agent 提交的 payload 里
一旦出现 program 或 human 专属字段，**在反序列化阶段就剥离并告警**，
不做"写后比对再回滚"（有竞态）。

为什么这条要单独成模块：如果 agent 能写 `gates`，五道闸就形同虚设 ——
它大可以自己标"全部 pass"。闸的写入权必须在编译器进程，不在被约束方手里。
"""

from __future__ import annotations

from typing import Any

from . import errors as E

#: 任何产物类型下都只能由程序写入的根字段
ALWAYS_PROGRAM: frozenset[str] = frozenset({
    "schema_version", "type", "id", "version", "status", "project",
    "derived_from", "content_hash", "created_at", "created_by", "updated_at",
})

#: exec「执行事实」字段：除 verdict 类结论外，还包含运行时版本戳与时间。
#: 单独拆出来是因为其中的 engine_version / schema_version / capability_versions
#: 必须由**执行进程**写（§24.7），agent 若能写这些字段，就能伪造"我跑的是新版本"，
#: 从而绕过版本漂移判定、把 flaky 洗成 pass——那是比伪造 gates 更隐蔽的越权。
EXEC_FACT: frozenset[str] = frozenset({
    "verdict", "verdict_reason", "inconclusive_kind", "attempt",
    "consistency", "metrics", "evidence_ref", "self_heal",
    "started_at", "finished_at",
    "engine_version", "schema_version", "capability_versions",
})

#: 特定类型下由程序写入的根字段（plan / exec 为执行链路事实）
PROGRAM_TYPE_SPECIFIC: frozenset[str] = frozenset({
    # plan：闸与编译溯源
    "gates", "compiled_from",
}) | EXEC_FACT

#: 只能由人写入
HUMAN_ONLY: frozenset[str] = frozenset({"approved_by"})

PROGRAM_ONLY = ALWAYS_PROGRAM | PROGRAM_TYPE_SPECIFIC


def forbidden_for(writer: str) -> frozenset[str]:
    if writer.startswith("agent:"):
        return PROGRAM_ONLY | HUMAN_ONLY
    if writer.startswith("program:"):
        return HUMAN_ONLY
    return frozenset()  # human 可写全部


def check_agent_payload(payload: dict[str, Any], writer: str) -> E.Result:
    """校验 agent/human 提交的 payload 是否越权写了不该写的字段。

    只查根层：深层的 `gates.*` 由根层 `gates` 一并覆盖；
    `expected[].matcher` 这类属于 agent 合法字段，不做限制。
    """
    banned = forbidden_for(writer)
    findings: list[E.Finding] = []

    if not isinstance(payload, dict):
        findings.append(E.Finding("PERM", E.PERM_AGENT_WROTE_PROGRAM_FIELD, None,
                                  "payload 顶层必须是 mapping"))
        return E.Result(False, findings)

    for key in payload:
        if key in banned:
            findings.append(E.Finding(
                "PERM", E.PERM_AGENT_WROTE_PROGRAM_FIELD, key,
                f"`{key}` 只允许 {('program' if key in PROGRAM_ONLY else 'human')} 写入，"
                f"{writer} 无权提交（已剥离）",
                action=E.ACTION_REJECT,
                layer="PERM",
            ))

    return E.Result(not findings, findings)


def strip_forbidden(payload: dict[str, Any], writer: str) -> tuple[dict[str, Any], E.Result]:
    """剥离越权字段并返回清洗后的 payload（工程实际用法）。"""
    result = check_agent_payload(payload, writer)
    if result.accepted:
        return payload, result
    banned = {f.field for f in result.findings}
    cleaned = {k: v for k, v in payload.items() if k not in banned}
    return cleaned, result
