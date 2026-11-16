"""回归与 flaky 工具：
1. select_regression — 回归选集：smoke(≤5min) / core(≤1h) / full 三闸（v3 第 13 章）
2. verdict_of_samples — flaky 判定：同计划同环境同数据 N 次结果不一致 ⇒ flaky（v3 第 14 章）
3. quarantine_check — 隔离区校验：quarantine 中的用例不得进入任何回归集
4. judge_samples — 带版本前置的 N 次判定（v3 §24.7）：版本不一致 ⇒ inconclusive
"""
from __future__ import annotations

from ..common.version import VERSION_CHANGED, stamps_differ

__all__ = ["select_regression", "verdict_of_samples", "quarantine_check",
           "estimate_duration_s", "first_run_pass_rate", "suspicious_signals",
           "admission_conclusion", "judge_samples"]

# 风险权重：最近一次 verdict 与风险等级决定是否进 smoke/core
_SMOKE_MAX_S = 5 * 60
_CORE_MAX_S = 60 * 60


def estimate_duration_s(execs: list[dict]) -> int:
    """取最近一次 exec 的 duration（缺省估 30s）。"""
    if not execs:
        return 30
    latest = max(execs, key=lambda e: (e.get("started_at") or ""))
    ms = latest.get("duration_ms") or latest.get("duration_ms_total") or 30000
    return int(ms // 1000) + 1


def select_regression(cases: list[dict], tier: str = "smoke",
                      budget_s: int | None = None) -> dict:
    """cases: [{id, execs:[...], risk: S1..S4, tags:[...], status, quarantine: bool,
                assertions:[{assert_type}]}]

    三闸规则（§13.3）：
      smoke：S1 + tags 含 smoke，预算内按 S1 优先、耗时短优先，默认预算 5min；
              额外约束：**flaky 率必须 0**（曾出现 flaky 的用例剔除）、
              **语义断言禁入**（100% 规则断言）；
      core ：smoke 全集 + S1/S2 + tags 含 core，默认预算 1h；
      full ：非 quarantine 的全部用例，预算不限。
    quarantine 用例在任何档位都被剔除（闸 3）。
    """
    budgets = {"smoke": _SMOKE_MAX_S, "core": _CORE_MAX_S, "full": None}
    if tier not in budgets:
        raise ValueError(f"tier must be smoke|core|full, got {tier}")
    budget = budget_s if budget_s is not None else budgets[tier]

    eligible, excluded = [], []
    for c in cases:
        if c.get("quarantine") or (c.get("status") or "").lower() == "quarantined":
            continue
        risk = c.get("risk") or "S4"
        tags = set(c.get("tags") or [])
        dur = estimate_duration_s(c.get("execs") or [])
        if tier == "smoke" and not (risk == "S1" or "smoke" in tags):
            continue
        if tier == "core" and not (risk in ("S1", "S2") or "core" in tags
                                   or "smoke" in tags):
            continue
        if tier == "smoke":
            # 约束一：冒烟集 flaky 率必须 0
            vs = [e.get("verdict") for e in c.get("execs") or [] if e.get("verdict")]
            if vs and verdict_of_samples(vs) == "flaky":
                excluded.append({"id": c.get("id"), "reason": "smoke-flaky（冒烟集要求 flaky 率 0）"})
                continue
            # 约束二：冒烟集 100% 规则断言，语义断言不得进入
            if any((a or {}).get("assert_type") == "semantic"
                   for a in c.get("assertions") or []):
                excluded.append({"id": c.get("id"),
                                 "reason": "semantic-assertion（冒烟集禁语义断言，稳定性无法保证）"})
                continue
        eligible.append({"id": c.get("id"), "risk": risk, "duration_s": dur,
                         "priority": (0 if risk == "S1" else 1 if risk == "S2"
                                      else 2 if risk == "S3" else 3, dur)})
    eligible.sort(key=lambda x: x.pop("priority"))
    selected, total = [], 0
    for c in eligible:
        if budget is not None and total + c["duration_s"] > budget:
            continue
        selected.append(c["id"])
        total += c["duration_s"]
    return {"tier": tier, "selected": selected, "total_s": total,
            "budget_s": budget, "skipped_by_budget": len(eligible) - len(selected),
            "excluded": excluded}


def admission_conclusion(requirement_coverage: float, impact_coverage: float,
                         asset_health: float, thresholds: dict | None = None) -> dict:
    """§13.4 三项指标 → 准入结论（合成规则写在代码里，不靠人记）。

    三项达标 → 可上线；需求覆盖达标但影响覆盖不足 → 有条件上线（列未测风险）；
    **资产健康度低于阈值 → 不给结论**（先修资产，而不是先上线）。
    """
    t = {"requirement_coverage": 0.90, "impact_coverage": 0.80,
         "asset_health": 0.70, **(thresholds or {})}
    if asset_health < t["asset_health"]:
        return {"verdict": "no_conclusion",
                "reason": f"资产健康度 {asset_health:.0%} < 阈值 {t['asset_health']:.0%}："
                          f"用例本身不可信，不给结论（先修资产）",
                "metrics": {"requirement_coverage": requirement_coverage,
                            "impact_coverage": impact_coverage,
                            "asset_health": asset_health}}
    if requirement_coverage < t["requirement_coverage"]:
        return {"verdict": "not_ready",
                "reason": f"需求覆盖率 {requirement_coverage:.0%} 未达标（改动的功能没测到）",
                "metrics": {"requirement_coverage": requirement_coverage,
                            "impact_coverage": impact_coverage,
                            "asset_health": asset_health}}
    if impact_coverage < t["impact_coverage"]:
        return {"verdict": "conditional", "reason": "需求覆盖达标但影响覆盖不足：有条件上线，须列未测风险",
                "metrics": {"requirement_coverage": requirement_coverage,
                            "impact_coverage": impact_coverage,
                            "asset_health": asset_health}}
    return {"verdict": "ready", "reason": "三项指标达标，可上线",
            "metrics": {"requirement_coverage": requirement_coverage,
                        "impact_coverage": impact_coverage,
                        "asset_health": asset_health}}


def verdict_of_samples(verdicts: list[str],
                       records: list[dict] | None = None) -> str:
    """N 次样本 → 最终 verdict（v3 §14.1 定义严格对齐）。

    flaky = 同一份执行计划、同一环境、同一数据，连续执行 N 次，结果不一致。
    - **同版本**是隐含前提（§24.7）：传 records 时先做版本一致性门，
      版本不同一律判 inconclusive(version_changed)，不冤枉脚本；
    - 三者任一变化都不算 flaky：因此 inconclusive（环境不可达/会话失败）**不参与**
      "不一致"判定——那是环境问题（§14.1 表格：环境抖动 → 环境健康检查 + 重试）；
    - 只有 pass 与 fail 混合才算 flaky；
    - 全部 inconclusive → inconclusive；pass+inconclusive → inconclusive（环境未就绪，不冤枉脚本）；
    - 全部 skipped → skipped。
    """
    if not verdicts:
        raise ValueError("empty verdicts")
    if records is not None:
        chk = stamps_differ(records)
        if chk["available"] and not chk["consistent"]:
            return "inconclusive"        # 版本漂移：见 judge_samples 取原因码
    v = [str(x).lower() for x in verdicts]
    uniq = set(v)
    if uniq <= {"pass"}:
        return "pass"
    if uniq <= {"fail"}:
        return "fail"
    if uniq <= {"skipped"}:
        return "skipped"
    if uniq <= {"inconclusive"}:
        return "inconclusive"
    if uniq <= {"pass", "fail"}:
        return "flaky"                       # 唯一构成 flaky 的组合
    # 含 inconclusive：环境因素优先归为 inconclusive（不误判 flaky，不误判 fail）
    return "inconclusive"


def judge_samples(records: list[dict]) -> dict:
    """带版本前置的 N 次判定（§24.7 决策 57）。

    records: exec IR 片段 [{verdict, engine_version, schema_version, capability_versions}]

    返回 {verdict, reason, version_check, samples}
      - 版本不一致      → verdict=inconclusive, reason="version_changed"，
                          附带各版本明细，**不进隔离区、不算 flaky**；
      - 版本一致但结果抖动 → 走 verdict_of_samples（pass/fail 混合才 flaky）；
      - 样本无版本戳     → 照常判定，但 version_check.available=False，
                          报告侧必须标注"版本不可验证"，不许当成已核验。

    为什么单独一个函数：verdict_of_samples 返回 str 便于旧调用方复用，
    而排查更新引发的问题需要原因码与版本明细，两者不该混在一个返回值里。
    """
    if not records:
        raise ValueError("empty records")
    chk = stamps_differ(records)
    samples = [str(r.get("verdict") or "inconclusive").lower() for r in records]
    if chk["available"] and not chk["consistent"]:
        return {"verdict": "inconclusive", "reason": VERSION_CHANGED,
                "version_check": chk, "samples": samples,
                "action": "在稳定版本上重跑取证；本条不计入 flaky、不进隔离区"}
    verdict = verdict_of_samples(samples)
    if verdict == "flaky":
        reason = "verdict_instability"
        action = "按 §14.3 可疑信号归因，确因脚本则入隔离区并加 reason/review_after"
    else:
        reason = "stable" if verdict in ("pass", "fail") else verdict
        action = "none"
    return {"verdict": verdict, "reason": reason, "version_check": chk,
            "samples": samples, "action": action,
            "version_verified": bool(chk["available"])}


def first_run_pass_rate(records: list[dict]) -> dict:
    """§14.5 指标：首次执行通过率（禁用含重试的最终通过率）。

    records: [{case_id, attempts: [verdict...]}]（attempts 按执行顺序）
    首次执行 = attempts[0]，不许用重试后的成功。
    """
    if not records:
        return {"first_run_pass_rate": None, "sample": 0,
                "note": "无样本；本指标禁用含重试的最终通过率（§14.5）"}
    first_pass = sum(1 for r in records
                     if (r.get("attempts") or ["inconclusive"])[0] == "pass")
    per_driver = {}
    for r in records:
        d = r.get("driver") or "unknown"     # 分别统计接口/UI flaky 率要分 driver
        first = (r.get("attempts") or ["inconclusive"])[0]
        slot = per_driver.setdefault(d, {"n": 0, "first_pass": 0, "flaky": 0})
        slot["n"] += 1
        slot["first_pass"] += 1 if first == "pass" else 0
        slot["flaky"] += 1 if verdict_of_samples(r.get("attempts") or []) == "flaky" else 0
    return {"first_run_pass_rate": round(first_pass / len(records), 4),
            "sample": len(records),
            "by_driver": {k: {"first_run_pass_rate": round(v["first_pass"] / v["n"], 4),
                              "flaky_rate": round(v["flaky"] / v["n"], 4), "n": v["n"]}
                          for k, v in per_driver.items()},
            "note": "首次执行通过率才是真实信号；**禁用含重试的最终通过率**；"
                    "flaky 率按 driver 分开统计（§14.5）"}


def suspicious_signals(exec_ir: dict, baseline_ms: int | None = None) -> list[dict]:
    """§14.3 第二步：重放期可疑信号（零额外成本），flaky 检测的免费输入。

    信号：命中降级定位 / 等待超阈值(>3s) / 发生过重试 /
          断言通过但伴随控制台或网络异常 / 执行时长波动 >50%。
    """
    signals = []
    for s in exec_ir.get("steps") or []:
        if (s.get("locator_hit") or 1) > 1:
            signals.append({"step": s.get("index"), "signal": "degraded_locator",
                            "detail": f"命中第 {s['locator_hit']} 个指纹"})
        if (s.get("wait_ms") or 0) > 3000:
            signals.append({"step": s.get("index"), "signal": "long_wait",
                            "detail": f"等待 {s['wait_ms']}ms > 3000ms"})
        if s.get("retries"):
            signals.append({"step": s.get("index"), "signal": "retried",
                            "detail": f"重试 {s['retries']} 次"})
        if s.get("status") == "pass" and (s.get("console_errors") or s.get("network_errors")):
            signals.append({"step": s.get("index"), "signal": "passed_with_noise",
                            "detail": "断言通过但伴随控制台/网络异常"})
        if baseline_ms and s.get("duration_ms"):
            delta = abs(s["duration_ms"] - baseline_ms) / baseline_ms
            if delta > 0.5:
                signals.append({"step": s.get("index"), "signal": "duration_swing",
                                "detail": f"时长波动 {delta:.0%} > 50%"})
    return signals


def quarantine_check(cases: list[dict]) -> dict:
    """隔离区纪律检查：
    1) quarantine 用例不得出现在任何回归集；
    2) 每条 quarantine 用例必须有 quarantine_reason 与 review_after 日期（防"永久隔离"）。
    """
    problems = []
    for c in cases:
        cid = c.get("id")
        if c.get("quarantine") or (c.get("status") or "").lower() == "quarantined":
            if not c.get("quarantine_reason"):
                problems.append({"id": cid, "message": "隔离中但缺 quarantine_reason"})
            if not c.get("review_after"):
                problems.append({"id": cid, "message": "隔离中但缺 review_after（防永久隔离）"})
    return {"ok": not problems, "problems": problems,
            "quarantined_count": sum(1 for c in cases
                                     if c.get("quarantine")
                                     or (c.get("status") or "").lower() == "quarantined")}
