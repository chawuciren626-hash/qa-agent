"""桌面 computer-use 结构层与重放层冒烟（M 桌面切片）。

不碰真实桌面：DesktopProbe 的指纹纯函数直接断言；run_plan 用测试替身
（FakeDesktopProbe），UIA/pywinauto 只在 _execute_step 动作期导入——替身从
resolve() 这一层接管，动作执行用记录器代替真点击。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aitestharness_tools.probe.desktop_probe import (DesktopProbe, anchor_of,
                                                     anchors_match)
from aitestharness_tools.exec.desktop_engine import run_plan, validate_plan


BTN = {"control_type": "Button", "automation_id": "btnSubmit", "name": "提交订单",
       "class_name": "Win32Button", "rect": {"x": 100, "y": 200, "width": 80, "height": 28},
       "path": "win[记事本]/Pane[0]", "depth": 1,
       "anchor": {"automation_id": "btnSubmit", "control_type": "Button", "name": "提交订单"}}
MENU = {"control_type": "MenuItem", "automation_id": "", "name": "文件",
        "class_name": "Win32Menu", "rect": {"x": 0, "y": 0, "width": 40, "height": 22},
        "path": "win[记事本]/Pane[1]", "depth": 1,
        "anchor": {"control_type": "MenuItem", "name": "文件", "class_name": "Win32Menu"}}
ELEMENTS = [BTN, MENU]


def test_anchor_requires_two_fingerprints():
    assert anchor_of({"automation_id": "btnSubmit"})["automation_id"] == "btnSubmit"
    assert anchor_of({"control_type": "Button", "name": "提交订单", "class_name": "Win32Button"})["name"]
    # 无名无 id 的纯容器：None，绝不硬造锚点
    assert anchor_of({"control_type": "Pane"}) is None
    assert anchor_of({"control_type": "Button", "name": "确定"}) is None  # 缺 class_name


def test_anchor_matching_scores_and_rejects():
    by_id = {"automation_id": "btnSubmit", "control_type": "Button"}
    assert anchors_match(BTN, by_id) >= 4
    assert anchors_match(MENU, by_id) == 0
    combo = {"control_type": "MenuItem", "name": "文件", "class_name": "Win32Menu"}
    assert anchors_match(MENU, combo) == 3
    # 单一指纹不成立（少于 2 个命中字段）
    assert anchors_match(MENU, {"control_type": "MenuItem"}) == 0
    # 字段冲突直接 0
    assert anchors_match(MENU, {"control_type": "MenuItem", "name": "编辑", "class_name": "Win32Menu"}) == 0
    # 坐标永不参与匹配
    assert anchors_match(BTN, {"automation_id": "btnSubmit", "rect": {"x": 999}}) >= 4


def test_resolve_picks_best_anchor():
    probe = DesktopProbe()
    probe.snapshot = lambda hint: {"elements": [BTN, MENU], "truncated": False}  # type: ignore
    hit = probe.resolve({"title": "记事本"}, {"automation_id": "btnSubmit"})
    assert hit["ok"] and hit["rect"] == BTN["rect"]
    miss = probe.resolve({"title": "记事本"}, {"automation_id": "ghost"})
    assert not miss["ok"] and miss["reason"] == "anchor_not_found"


class FakeDesktopProbe:
    """替身：resolve 可控成败；动作记录到 clicks/keys，不碰真桌面。"""

    def __init__(self, elements=None, fail_anchor=False):
        self.elements = elements if elements is not None else ELEMENTS
        self.fail_anchor = fail_anchor
        self.clicks, self.keys, self.focus = [], [], []

    def snapshot(self, hint):
        return {"source": "dom", "windows": [], "elements": self.elements,
                "element_count": len(self.elements), "truncated": False}

    def resolve(self, hint, anchor):
        if self.fail_anchor:
            return {"ok": False, "reason": "anchor_not_found", "snapshot_digest": len(self.elements)}
        return {"ok": True, "rect": self.elements[0]["rect"], "anchor": self.elements[0]["anchor"],
                "path": self.elements[0]["path"]}


def test_validate_plan_rejects_open_shapes():
    for bad in [
        {}, {"steps": []},
        {"steps": [{"op": "evaluate", "script": "return 1"}]},
        {"steps": [{"op": "tap"}]},                                   # tap 缺 target
        {"steps": [{"op": "tap", "target": {}, "x": 100, "y": 200}]},  # 坐标不在封闭枚举里
        {"steps": [{"op": "type", "target": {"automation_id": "a"}}]},  # type 缺 text
        {"steps": [{"op": "key", "target": {}, "key": 1}]},
        {"steps": [{"op": "wait", "seconds": 999}]},
        {"steps": [{"op": "assert_window"}]},
    ]:
        try:
            validate_plan(bad)
            raise AssertionError(f"plan should be rejected: {bad}")
        except ValueError:
            pass
    validate_plan({"steps": [{"op": "tap", "target": {"automation_id": "btnSubmit"}},
                             {"op": "wait", "seconds": 0.2}]})


def test_run_plan_executes_and_stops_on_first_failure():
    probe = FakeDesktopProbe(fail_anchor=False)
    import aitestharness_tools.exec.desktop_engine as engine

    calls: list[str] = []

    def fake_execute(p, hint, step):  # 动作层整体替换：绝不碰真实桌面
        calls.append(step["op"])
        if step["op"] == "key":
            raise LookupError("anchor_not_found: name=文件")
        return {"op": step["op"], "stub": True}

    original = engine._execute_step
    engine._execute_step = fake_execute
    try:
        plan = {"window_hint": {"title": "记事本"}, "steps": [
            {"op": "tap", "target": {"automation_id": "btnSubmit"}},
            {"op": "key", "target": {"automation_id": "btnSubmit"}, "key": "{ENTER}"},
            {"op": "wait", "seconds": 0.05},
            {"op": "assert_anchor", "target": {"automation_id": "btnSubmit"}},
        ]}
        receipt = run_plan(plan, probe=probe)
        assert receipt["ok"] is False
        assert calls == ["tap", "key"], "失败后按契约停住，不再继续执行"
        assert receipt["steps"][0]["ok"] is True
        assert receipt["steps"][1]["ok"] is False
        assert receipt["steps"][2]["skipped"] is True
        assert receipt["steps"][1]["error"], "失败原因必须进回执（归因的输入）"
    finally:
        engine._execute_step = original


def test_run_plan_all_pass_with_stub_actions():
    probe = FakeDesktopProbe()
    # 把动作层整条换成记录器：引擎的编排语义（fail-fast、回执形态）才是这里的被测对象
    import aitestharness_tools.exec.desktop_engine as engine

    def fake_execute(p, hint, step):
        return {"op": step["op"], "stub": True}

    original = engine._execute_step
    engine._execute_step = fake_execute
    try:
        plan = {"steps": [
            {"op": "tap", "target": {"automation_id": "btnSubmit"}},
            {"op": "assert_window", "title": "记事本"},
        ]}
        receipt = run_plan(plan, probe=probe)
        assert receipt["ok"] is True
        assert [s["op"] for s in receipt["steps"]] == ["tap", "assert_window"]
        assert all(s["ok"] for s in receipt["steps"])
    finally:
        engine._execute_step = original


def test_pool_desktop_lane():
    from aitestharness_tools.exec.pools import PoolScheduler
    scheduler = PoolScheduler()
    plan = {"main_driver": "native", "pool": "desktop"}
    decision = scheduler.submit(plan)
    assert decision["pool"] == "desktop_pool"
    assert scheduler.lease("desktop_pool") is True
    assert scheduler.lease("desktop_pool") is False  # 单屏独占
    scheduler.release("desktop_pool")
    assert scheduler.lease("desktop_pool") is True
    # 未声明的池覆盖值回落到 driver 默认池
    assert scheduler.submit({"main_driver": "web"})["pool"] == "web_pool"


def test_runtime_cli_exposes_desktop_tools():
    from aitestharness_tools.runtime_cli import invoke
    probe = FakeDesktopProbe()
    original_resolve = DesktopProbe.resolve
    original_snapshot = DesktopProbe.snapshot
    DesktopProbe.resolve = lambda self, hint, anchor: probe.resolve(hint, anchor)  # type: ignore
    DesktopProbe.snapshot = lambda self, hint: probe.snapshot(hint)  # type: ignore
    try:
        result = invoke("desktop.snapshot", {"window_hint": {"title": "记事本"}})
        assert result["source"] == "dom" and result["element_count"] == 2
        receipt = invoke("desktop.replay", {"plan": {"steps": [
            {"op": "assert_anchor", "target": {"automation_id": "btnSubmit"}}]}})
        assert receipt["ok"] is True
    finally:
        DesktopProbe.resolve = original_resolve  # type: ignore
        DesktopProbe.snapshot = original_snapshot  # type: ignore


def _main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print(f"  ok {test.__name__}")
    print(f"desktop smoke: {len(tests)} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
