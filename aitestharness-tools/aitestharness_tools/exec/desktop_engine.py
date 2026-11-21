"""桌面执行引擎（重放层，零模型）：UIA 锚点 → 确定性动作 → exec 回执。

对齐 v2 方案的两条红线：
- **重放层零模型**：这里没有任何 VLM/LLM 调用。计划里的每一步都是结构化锚点
  （probe/desktop_probe.py 的 ≥2 指纹），定位解析失败就如实失败交三分归因，
  绝不猜一个"最近的点"。
- **动作封闭枚举**：tap / type / key / wait / assert_anchor / assert_window。
  不接受任意脚本，不接受坐标——坐标是"这一版像素的位置"，进剧本即质量缺陷。

与 Web 侧 exec/web_engine.py 的分工：web_engine 吃 Playwright 探针的 DOM 锚点，
本模块吃 UIA 锚点；产物同为 exec 回执（steps 明细 + ok），判定层与归因层不变。
"""
from __future__ import annotations

import time
from typing import Any

from ..probe.desktop_probe import DesktopProbe, DesktopProbeUnavailable

__all__ = ["run_plan", "OPS"]

OPS = ("tap", "type", "key", "wait", "assert_anchor", "assert_window")
MAX_STEPS = 120
MAX_WAIT_S = 30.0
RESOLVE_TIMEOUT_S = 5.0
RESOLVE_RETRIES = 3


def _valid_anchor(target: Any) -> bool:
    """锚点形状校验：automation_id 可单独成立；否则 control_type+name+class_name 全齐。
    （与 probe.desktop_probe.anchor_of 的 ≥2 指纹口径一致。）"""
    if not isinstance(target, dict):
        return False
    fingerprint = target.get("anchor") if isinstance(target.get("anchor"), dict) else target
    if fingerprint.get("automation_id"):
        return True
    return all(bool(fingerprint.get(key)) for key in ("control_type", "name", "class_name"))


def validate_plan(plan: dict) -> None:
    """计划的封闭校验：非法步骤在进入桌面之前就拒掉。

    坐标字段（x/y/coordinates/point）一律拒绝——坐标是"这一版像素的位置"，
    进计划即质量缺陷（v2 §3.5.5 硬约束在重放层的落点）。
    """
    if not isinstance(plan, dict):
        raise ValueError("plan must be an object")
    steps = plan.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("plan.steps must be a non-empty array")
    if len(steps) > MAX_STEPS:
        raise ValueError(f"plan.steps exceeds {MAX_STEPS}")
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f"step[{index}] must be an object")
        if any(key in step for key in ("x", "y", "coordinates", "point")):
            raise ValueError(f"step[{index}] carries coordinates: anchors only (visual output must degrade to structured anchors)")
        op = step.get("op")
        if op not in OPS:
            raise ValueError(f"step[{index}].op must be one of {OPS}")
        if op in ("tap", "assert_anchor", "type", "key") and not _valid_anchor(step.get("target")):
            raise ValueError(f"step[{index}].target must be a valid anchor (automation_id or control_type+name+class_name)")
        if op == "type" and not isinstance(step.get("text"), str):
            raise ValueError(f"step[{index}].text must be a string")
        if op == "key" and not isinstance(step.get("key"), str):
            raise ValueError(f"step[{index}].key must be a string")
        if op == "wait":
            wait = step.get("seconds", 1)
            if not isinstance(wait, (int, float)) or wait <= 0 or wait > MAX_WAIT_S:
                raise ValueError(f"step[{index}].seconds must be within (0, {MAX_WAIT_S}]")
        if op == "assert_window" and not isinstance(step.get("title"), str):
            raise ValueError(f"step[{index}].title must be a string")


def run_plan(plan: dict, *, probe: DesktopProbe | None = None) -> dict:
    """执行锚点计划 → 回执。首步失败即停：重放不该在断点上继续跑。

    回执是证据，不是结论：每步只记"做了什么、结果如何"，成败判定交给上层
    （wait_assert / 归因）。
    """
    validate_plan(plan)
    probe = probe or DesktopProbe()
    window_hint = plan.get("window_hint") or {}
    steps: list[dict[str, Any]] = []
    started_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    ok = True
    for index, step in enumerate(plan["steps"]):
        if not ok:
            steps.append({"index": index, "op": step.get("op"), "ok": False,
                          "skipped": True, "detail": "前序步骤失败，按契约不再继续执行"})
            continue
        try:
            detail = _execute_step(probe, window_hint, step)
            steps.append({"index": index, "op": step["op"], "ok": True, "detail": detail})
        except DesktopProbeUnavailable:
            raise
        except Exception as error:  # 定位漂移、控件不存在、窗口关闭都到这——如实记，不猜
            ok = False
            steps.append({"index": index, "op": step["op"], "ok": False,
                          "error": str(error), "detail": {}})
    return {"ok": ok, "step_count": len(plan["steps"]),
            "steps": steps,
            "started_at": started_at,
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())}


def _resolve(probe: DesktopProbe, window_hint: dict, anchor: dict) -> dict:
    """带重试的锚点解析：UIA 树偶发刷新滞后，等一小段再找一次，不是自愈。"""
    last: dict = {}
    for attempt in range(RESOLVE_RETRIES):
        result = probe.resolve(window_hint, anchor)
        if result.get("ok"):
            return result
        last = result
        if attempt + 1 < RESOLVE_RETRIES:
            time.sleep(0.5)
    raise LookupError(f"anchor_not_found: {_short(anchor)}（快照 {last.get('snapshot_digest', '?')} 元素）")


def _execute_step(probe: DesktopProbe, window_hint: dict, step: dict) -> dict:
    from pywinauto import Desktop as _UiaDesktop  # noqa: PLC0415 - 延迟到动作期
    from pywinauto import keyboard  # noqa: PLC0415

    op = step["op"]
    if op == "assert_window":
        desktop = _UiaDesktop(backend="uia")
        title = step["title"]
        windows = desktop.windows(top_level_only=True)
        hit = [w for w in windows if title in (w.element_info.name or "")]
        if not hit:
            raise LookupError(f"window_not_found: {title!r}")
        return {"window": hit[0].element_info.name}

    if op == "wait":
        seconds = float(step.get("seconds", 1))
        time.sleep(min(seconds, MAX_WAIT_S))
        return {"waited_s": seconds}

    # 其余动作都要先解析锚点（assert_anchor 除外——它解析本身就是断言）。
    anchor = step.get("target") or {}
    if op == "assert_anchor":
        result = _resolve(probe, window_hint, anchor)
        return {"rect": result["rect"], "path": result["path"]}

    result = _resolve(probe, window_hint, anchor)
    rect = result["rect"]
    desktop = _UiaDesktop(backend="uia")
    wrapper = desktop.from_point(rect["x"] + rect["width"] // 2, rect["y"] + rect["height"] // 2)

    if op == "tap":
        wrapper.click_input()
        return {"rect": rect, "click": "input", "path": result["path"]}
    if op == "type":
        text = step["text"]
        if step.get("replace") and hasattr(wrapper, "set_edit_text"):
            wrapper.set_edit_text(text)
        else:
            wrapper.set_focus()
            keyboard.send_keys(text, with_spaces=True)
        return {"rect": rect, "chars": len(text), "replace": bool(step.get("replace"))}
    if op == "key":
        sequence = step["key"]
        wrapper.set_focus()
        keyboard.send_keys(sequence)
        return {"rect": rect, "key": sequence}
    raise ValueError(f"unknown op {op!r}")


def _short(anchor: dict) -> str:
    target = anchor.get("anchor") or anchor
    return ",".join(f"{key}={target[key]}" for key in ("automation_id", "name", "control_type")
                    if target.get(key)) or "empty"
