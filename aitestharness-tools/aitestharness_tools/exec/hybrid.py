"""§11.5 混合 driver 四条约束校验器 + §11.6 验证方式分配审计闸。

混合 driver 四条约束（§11.5，全部可形式化 → 编译期强制）：
  1 必须声明主 driver   2 最多 2 段，切走不许切回   3 context_flow 显式声明   4 结论按最弱一环
分配审计闸（§11.6）：统计"接口可验证但被分配为 UI"比例，>30% 提示不合理。
"""
from __future__ import annotations

from ..irval.enums import ENUMS

__all__ = ["check_hybrid_plan", "weakest_link_verdict", "allocation_audit"]

_DRIVERS = set(ENUMS["driver_kind"])


def _step_driver(step: dict) -> str | None:
    return step.get("driver") or (target.get("kind")
                                  if isinstance((target := step.get("target")), dict) else None)


def check_hybrid_plan(plan: dict) -> dict:
    """编译期四条约束校验。返回 {ok, problems:[{constraint, message, step?}]}。"""
    steps = plan.get("steps") or []
    problems: list[dict] = []
    drivers_in_order: list[str] = []
    prev_driver = None
    switched_back_at = None

    for i, step in enumerate(steps):
        d = _step_driver(step)
        if d and d in _DRIVERS:
            if d != prev_driver:
                drivers_in_order.append(d)
                if prev_driver is not None:
                    # 约束 2：切走不许切回（第三段出现即违规）
                    if d in drivers_in_order[:-1] and switched_back_at is None:
                        switched_back_at = i
                        problems.append({
                            "constraint": "C2-max-2-segments", "step": i,
                            "message": f"step[{i}] 切回已用过的 driver '{d}'：最多 2 段且切走不许切回，"
                                       f"用例应拆分（当前段序 {'→'.join(drivers_in_order)}）"})
                prev_driver = d

    # 约束 1：主 driver 必须声明，且混合时主 driver = 段数最多的
    main = plan.get("main_driver")
    if not main:
        problems.append({"constraint": "C1-main-driver",
                         "message": "未声明 main_driver（决定语句上下文/等待策略/证据格式）"})
    elif len(drivers_in_order) > 1 and main != drivers_in_order[0]:
        problems.append({"constraint": "C1-main-driver",
                         "message": f"main_driver='{main}' 与首个使用的 driver "
                                    f"'{drivers_in_order[0]}' 不一致，主 driver 必须起头"})

    # 约束 3：driver 切换点必须有 context_flow 显式传递
    flow_keys = {(f.get("from"), f.get("to")) for f in plan.get("context_flow") or []}
    n_segments = len(drivers_in_order)
    if n_segments > 1 and not flow_keys:
        problems.append({"constraint": "C3-context-flow",
                         "message": "混合用例未声明任何 context_flow：跨 driver 变量传递禁止隐式共享"})

    # 约束 4（编译期检查项）：引用的 ctx 变量必须在 flow 中声明
    import re
    used_ctx = set()
    for step in steps:
        blob = str(step.get("payload") or "") + str(step.get("input") or "") \
               + str(step.get("params") or "")
        used_ctx |= set(re.findall(r"\$\{ctx\.([A-Za-z0-9_.]+)\}", blob))
    declared_ctx = {re.search(r"ctx\.([A-Za-z0-9_.]+)", str(f.get("to")) or "").group(1)
                    for f in plan.get("context_flow") or []
                    if re.search(r"ctx\.([A-Za-z0-9_.]+)", str(f.get("to")) or "")}
    undeclared = used_ctx - declared_ctx
    if undeclared:
        problems.append({"constraint": "C3-context-flow",
                         "message": f"引用了未在 context_flow 声明的变量 {sorted(undeclared)}"})

    return {"ok": not problems, "problems": problems,
            "segments": drivers_in_order, "main_driver": main,
            "weakest_link_note": None if not drivers_in_order else
            "结论按最弱一环判定：任一 driver 失败即 fail，归因标注失败 driver（引擎运行时执行）"}


def weakest_link_verdict(segment_results: list[dict]) -> dict:
    """约束 4 的运行时实现：分段结果 → 最终 verdict + 归因到失败 driver。
    segment_results: [{driver, verdict}]（五档）"""
    fail_ranks = {"fail": 0, "inconclusive": 1, "flaky": 2, "skipped": 3, "pass": 4}
    worst = min(segment_results, key=lambda r: fail_ranks.get(r.get("verdict"), 1))
    return {"verdict": worst.get("verdict"),
            "failed_driver": worst.get("driver") if worst.get("verdict") != "pass" else None,
            "rule": "C4-weakest-link"}


def allocation_audit(test_points: list[dict], threshold: float = 0.30) -> dict:
    """§11.6 落成校验器：接口可验证但被分配为 UI 的比例 >30% → 提示不合理。

    test_points: [{id, type, verify_mode}]，type ∈ 业务逻辑/边界/异常/权限/数据一致性/并发/…
    接口可验证类型表见 §11.6 分配规则（与 matrix.assign_verify_mode 同源规则）。
    """
    api_verifiable = {"业务逻辑", "计算", "状态机", "边界", "异常", "错误码",
                      "权限", "越权", "数据隔离", "并发", "幂等", "重复提交",
                      "数据一致性"}
    misplaced = [tp for tp in test_points
                 if tp.get("verify_mode") in ("ui", "web")
                 and any(k in str(tp.get("type") or "") for k in api_verifiable)]
    ratio = (len(misplaced) / len(test_points)) if test_points else 0.0
    return {"total": len(test_points),
            "misplaced_count": len(misplaced),
            "misplaced_ids": [tp.get("id") for tp in misplaced],
            "ratio": round(ratio, 4),
            "ok": ratio <= threshold,
            "message": None if ratio <= threshold else
            f"接口可验证但分配为 UI 的比例 {ratio:.0%} 超过 {threshold:.0%} 阈值——"
            f"防止习惯性写 UI 用例的闸门触发，请复核验证方式分配"}
