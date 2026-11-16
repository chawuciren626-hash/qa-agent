"""§12.5 取证包（固定 7 分区 schema，含与历史基线的 diff）+ §12.7 人工接管状态重对齐。

取证包固定分区（§12.5）：context / visual / dom / network / console / trace / history
**"与上次成功的 diff"是最直接的归因证据**——大部分失败是"某处变了"，人一眼能看出来。
通用 agent 拿不到，因为它没有历史资产。
"""
from __future__ import annotations

from datetime import datetime, timezone

__all__ = ["build_evidence_pack", "diff_snapshot", "REALIGN_STEPS", "realign_after_takeover"]

EVIDENCE_SECTIONS = ("context", "visual", "dom", "network", "console", "trace", "history")


def build_evidence_pack(exec_ir: dict, failed_step: dict | None = None,
                        baseline: dict | None = None,
                        history: list[dict] | None = None,
                        keep_request_payload: bool = True) -> dict:
    """组装 §12.5 七分区取证包。

    baseline：上次成功的同步骤快照 {dom_summary, screenshot_ref, ...} → 产出 diff 分区。
    history ：该用例最近 5 次结果（判断是否 flaky）。
    入参只在 evidence 包留（有保留期），长期资产不留（决议 #2）。
    """
    step = failed_step or next(
        (s for s in exec_ir.get("steps") or [] if s.get("status") == "fail"), {})
    dom_now = step.get("dom_summary") or {}
    pack = {
        "context": {
            "exec_id": exec_ir.get("lineage", {}).get("id") or exec_ir.get("id"),
            "plan_id": (exec_ir.get("plan") or {}).get("id"),
            "plan_version": (exec_ir.get("plan") or {}).get("version"),
            "step_index": step.get("index"),
            "env": exec_ir.get("env") or {},
            "data_version": exec_ir.get("data_version"),
            "engine_version": exec_ir.get("engine_version"),
            "collected_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "visual": {"screenshot": step.get("screenshot_ref"),
                   "video": step.get("video_ref"),
                   "baseline_diff": diff_snapshot(dom_now, (baseline or {}).get("dom_summary"),
                                                  kind="visual")},
        "dom": {"snapshot": dom_now,
                "target_outer_summary": step.get("target_summary"),
                "baseline_diff": diff_snapshot(dom_now, (baseline or {}).get("dom_summary"))},
        "network": {"requests": step.get("network") or [],
                    "note": "本步骤相关请求（状态码/耗时/payload 摘要）"},
        "console": {"errors": step.get("console_errors") or [],
                    "warnings": step.get("console_warnings") or []},
        "trace": {"steps": [{"index": s.get("index"), "action": s.get("action"),
                             "status": s.get("status")}
                            for s in (exec_ir.get("steps") or [])[:step.get("index", 0) + 1]]},
        "history": {"recent": (history or [])[:5]},
        "failed_assertions": [a for a in step.get("assertions") or []
                              if a.get("level", "decide") == "decide" and not a.get("passed")],
    }
    if keep_request_payload:
        pack["network"]["request_excerpt"] = step.get("request") or None
    return pack


def diff_snapshot(now: dict, before: dict | None, kind: str = "dom") -> dict | None:
    """快照 diff（baseline 缺失时返回 None，并明确标注"无基线"——不是"无差异"）。"""
    if before is None:
        return {"available": False,
                "note": f"无上次成功的 {kind} 基线：无法给出 diff（新用例或基线已过期）"}
    added = sorted(set(now or {}) - set(before))
    removed = sorted(set(before) - set(now or {}))
    changed = sorted(k for k in set(now or {}) & set(before) if now[k] != before[k])
    return {"available": True, "added": added, "removed": removed, "changed": changed,
            "summary": f"+{len(added)} -{len(removed)} ~{len(changed)}"}


# ---- §12.7 人工接管后的状态重新对齐（三步，最易漏） ----
REALIGN_STEPS = (
    ("resnapshot", "重新抓 DOM 快照，更新元素映射"),
    ("refresh_touched", "刷新 touched（页面或接口可能变了）"),
    ("precheck_next", "校验当前状态是否满足下一步前置条件，不满足明确报错，不硬跑"),
)


def realign_after_takeover(current_state: dict, next_step: dict,
                           extract_touched_fn=None) -> dict:
    """接管交回时的三步对齐（§12.7）。不做这三步，后续步骤会基于过期状态执行。

    current_state: {dom_summary, touched: {pages, apis}, satisfied: {precondition: bool}}
    next_step: {requires: [...]}（下一步前置条件）
    返回 {ok, steps:[{step, done, detail}], blocked_reason}
    """
    results = []
    dom_ok = bool(current_state.get("dom_summary"))
    results.append({"step": "resnapshot", "done": dom_ok,
                    "detail": "快照已更新" if dom_ok else "未取到新 DOM 快照"})
    touched_ok = current_state.get("touched") is not None
    if touched_ok and extract_touched_fn and current_state.get("steps"):
        current_state["touched"] = extract_touched_fn({"steps": current_state["steps"]})
    results.append({"step": "refresh_touched", "done": touched_ok,
                    "detail": f"touched={current_state.get('touched')}"})
    requires = next_step.get("requires") or []
    satisfied = current_state.get("satisfied") or {}
    missing = [r for r in requires if not satisfied.get(r)]
    results.append({"step": "precheck_next", "done": not missing,
                    "detail": "前置满足" if not missing else f"前置不满足：{missing}"})
    all_ok = all(r["done"] for r in results)
    return {"ok": all_ok, "steps": results,
            "blocked_reason": None if all_ok else
            f"接管后状态未对齐，拒绝继续执行（{ [r['step'] for r in results if not r['done']] }）"}
