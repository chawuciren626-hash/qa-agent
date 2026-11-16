"""10.5 阶段五：缺陷分析 —— Program/Validator 四件套（零 LLM；归因器是 Advisor，在 agent 层）。

v3 §10.5 实战判断：归因下沉到执行末端（失败那一刻取证包还在手上）；
flaky 用例中有一类是**真实偶发 bug**（并发/缓存/时序），识别器必须上报而非静默重跑。

1. build_evidence_pack — 取证包组装器：从结果 IR 拉齐证据（12.5）
2. defect_fingerprint / dedup_defects — 缺陷去重器：指纹匹配
   （失败断言 + 目标元素 + 异常签名；向量相似由上层可选叠加）
3. render_defect_ticket — 缺陷单渲染器：模板渲染（接 Jira/禅道/内置）
4. identify_heisenbug — 偶发 bug 识别器（Validator）：标记"预期不稳定"的失败
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

__all__ = ["build_evidence_pack", "defect_fingerprint", "dedup_defects",
           "render_defect_ticket", "identify_heisenbug"]

_TICKET_TEMPLATES = {
    "builtin": """[缺陷] {title}
严重级: {severity} | 归因: {category} | 置信度: {confidence}
用例: {case_id}  计划: {plan_id}  环境: {env}
--- 证据 ---
{evidence_block}
--- 首次出现 / 复现次数 ---
first_seen: {first_seen}  occurrences: {occurrences}
""",
    "jira": {"summary": "{title}",
             "description": "用例 {case_id} @ {env}\n\n{evidence_block}",
             "labels": ["aitestharness", "{category}"], "priority": "{severity}"},
}


def build_evidence_pack(exec_ir: dict, keep_request_payload: bool = True) -> dict:
    """从 exec IR 组装配证包（v3 §12.5）：失败步骤的请求/响应/断言/日志引用拉齐。

    入参只在 evidence 包里留（有保留期），长期资产不留（决议 #2）。
    """
    failing = [s for s in exec_ir.get("steps") or [] if s.get("status") == "fail"]
    pack = {
        "exec_id": exec_ir.get("lineage", {}).get("id") or exec_ir.get("id"),
        "plan": exec_ir.get("plan"),
        "env": exec_ir.get("env") or {},
        "verdict": exec_ir.get("verdict"),
        "collected_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "failed_steps": [],
    }
    for s in failing:
        entry = {"index": s.get("index"), "action": s.get("action"),
                 "assertions": [a for a in s.get("assertions") or []
                                if a.get("decide") and not a.get("passed")],
                 "duration_ms": s.get("duration_ms")}
        # 请求入参仅入 evidence 包（有保留期）
        if keep_request_payload:
            entry["request_excerpt"] = s.get("request") or None
        pack["failed_steps"].append(entry)
    return pack


def defect_fingerprint(fail_step: dict, env_key: str = "") -> str:
    """缺陷指纹：失败断言(matcher+expected) + 目标元素(action) + 异常签名(错误类型)。
    同指纹 = 同缺陷候选；环境键参与指纹（同缺陷在不同环境可复现性要分开看）。"""
    asserts = sorted(f"{a.get('matcher')}:{a.get('expected')}"
                     for a in fail_step.get("assertions") or [])
    err = str((fail_step.get("error") or {}).get("type") or "")
    raw = "|".join([str(fail_step.get("action")), ";".join(asserts), err, env_key])
    return "dfp-" + hashlib.sha1(raw.encode()).hexdigest()[:12]


def dedup_defects(evidence_packs: list[dict], existing: list[dict] | None = None) -> dict:
    """缺陷去重器（Program）：
    new      —— 指纹未见过，建议开新缺陷单
    merged   —— 与本批或既有缺陷指纹相同，合并
    返回分组结果供归因器（Advisor）接手打标。"""
    seen: dict[str, list] = {}
    for pack in evidence_packs:
        for s in pack.get("failed_steps") or []:
            fp = defect_fingerprint(s, pack.get("env", {}).get("key", ""))
            seen.setdefault(fp, []).append({"exec_id": pack.get("exec_id"),
                                            "step_index": s.get("index")})
    existing_map = {}
    for d in existing or []:
        existing_map.setdefault(d.get("fingerprint"), []).append(d.get("id"))
    result = []
    for fp, occurrences in seen.items():
        linked = existing_map.get(fp) or []
        result.append({"fingerprint": fp,
                       "occurrences": occurrences,
                       "decision": "merged" if linked else "new",
                       "linked_defects": linked})
    return {"groups": result,
            "new_count": sum(1 for r in result if r["decision"] == "new"),
            "merged_count": sum(1 for r in result if r["decision"] == "merged")}


def render_defect_ticket(group: dict, meta: dict,
                         template: str = "builtin") -> dict | str:
    """缺陷单渲染器：模板渲染（builtin 文本 / jira 结构）。归因字段由归因器（Advisor）给出。
    meta: {title, severity, category, confidence, case_id, plan_id, env, evidence_pack}"""
    ev = meta.get("evidence_pack") or {}
    ev_block = "\n".join(
        f"step[{s['index']}] {s['action']}: " +
        "; ".join(f"期望 {a.get('matcher')} {a.get('expected')}，实际 {a.get('actual')}"
                  for a in s.get("assertions") or [])
        for s in ev.get("failed_steps") or []) or "（无失败断言细节，见 exec 原文）"
    occ = group.get("occurrences") or []
    if template == "builtin":
        return _TICKET_TEMPLATES["builtin"].format(
            title=meta.get("title", "未命名"), severity=meta.get("severity", "S3"),
            category=meta.get("category", "unknown"),
            confidence=meta.get("confidence", "-"),
            case_id=meta.get("case_id", "?"), plan_id=meta.get("plan_id", "?"),
            env=meta.get("env", "?"), evidence_block=ev_block,
            first_seen=ev.get("collected_at", "-"),
            occurrences=len(occ))
    if template == "jira":
        t = _TICKET_TEMPLATES["jira"]
        return {"summary": t["summary"].format(title=meta.get("title", "未命名")),
                "description": t["description"].format(
                    case_id=meta.get("case_id", "?"), env=meta.get("env", "?"),
                    evidence_block=ev_block),
                "labels": [t["labels"][0], meta.get("category", "unknown")],
                "priority": meta.get("severity", "S3")}
    raise ValueError(f"unknown template: {template}")


def identify_heisenbug(history: list[dict]) -> list[dict]:
    """偶发 bug 识别器（Validator，v3 §10.5 必须能上报真实偶发缺陷）。

    history: [{case_id, plan_id, env, verdict, step_index}] 按同一 case+env 的多次执行。
    判定：同一步骤在多次执行中"断言失败与否不稳定"（不全是脚本问题式的必现失败），
    且失败时的 actual 值各不相同 → 提示可能是真实偶发缺陷（并发/缓存/时序），
    建议：不自动修脚本，先转人工 + 保留全部取证包。
    """
    by_key: dict[tuple, list] = {}
    for h in history:
        by_key.setdefault((h.get("case_id"), h.get("env")), []).append(h)
    suspects = []
    for (case_id, env), runs in by_key.items():
        verdicts = {r.get("verdict") for r in runs}
        if verdicts <= {"pass"} or verdicts <= {"fail", "error"}:
            continue   # 必现失败或全通过：不是偶发
        actuals = {str(r.get("actual")) for r in runs if r.get("actual") is not None}
        suspects.append({
            "case_id": case_id, "env": env,
            "runs": len(runs), "verdicts": sorted(verdicts),
            "actual_variants": sorted(actuals),
            "suspect": "heisenbug",
            "hint": "同一步骤结果不稳定且实际值多样——可能是真实偶发缺陷"
                    "（并发/缓存/时序），勿自动修脚本，转人工并保留取证包",
        })
    return suspects
