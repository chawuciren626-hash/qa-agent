"""Windows 桌面探针（结构层，零模型）：UIA 控件树快照 + 视觉定位反查。

这是桌面 computer-use 的「取原料层」。与 Web 侧 probe/base.py 的三层取法对应：

1. **结构层（本模块）**：Windows UI Automation 的控件树——automation_id / name /
   control_type / class_name / rect 是桌面侧的「结构化锚点」，与 Web 的 selector/a11y
   同级。快照产物可存档、可 diff、可作重放输入。
2. **视觉层（scripts/desktop-visual.mjs，Midscene）**：截图 → VLM 定位 → 动作。它的
   产出**必须当场降级为本模块的 UIA 锚点**（element_from_point 反查），坐标只留在
   证据里，绝不进剧本——与 v2 方案 §3.5.5 的硬约束同一条。

为什么指纹要求 ≥2 个稳定字段（与 exec/native_mini.py 的 LocResolver 同口径）：
automation_id 单独可用最好；没有 automation_id 的控件退而求其次组合
control_type + name + class_name + path。单一指纹（比如只有 name）在 UI 改版后
既无法自证失效，也无法自愈——那正是"坐标剧本每轮都废"的桌面版。
"""
from __future__ import annotations

import io
import json
from dataclasses import dataclass, field
from typing import Any

from .base import ProbeUnavailable

__all__ = ["DesktopProbeUnavailable", "DesktopProbe", "anchor_of", "anchors_match"]

# UIA 树的硬上限：超大控件树（游戏/浏览器内核窗口）会把快照变成一次卡顿。
# 截断在产物里如实标注（truncated=True），不静默丢。
MAX_NODES = 600
MAX_DEPTH = 14
# 视觉定位反查时，点命中的控件可能是"包着目标的无语义容器"（Pane/Group）。
# 允许向外最多找这么多层，取第一个有名字或有 automation_id 的祖先作为锚点宿主。
POINT_ANCESTOR_LIMIT = 4


def _area(rect: Any) -> int:
    """RECT 的面积（排序窗口用）。pywinauto 两个 RECT 形态（方法/属性）都兼容。"""
    try:
        return max(0, int(_dim(rect, "width"))) * max(0, int(_dim(rect, "height")))
    except Exception:
        return 0


def _dim(rect: Any, name: str) -> int:
    value = getattr(rect, name, 0)
    return value() if callable(value) else value


def _rect_of(target: Any) -> Any:
    """rectangle 有时是方法（UIAWrapper）有时是属性（UIAElementInfo）——统一取 RECT。"""
    rect = getattr(target, "rectangle", None)
    if rect is None:
        return None
    try:
        return rect() if callable(rect) else rect
    except Exception:
        return None


def _rect_dict(rect: Any) -> dict[str, int]:
    return {"x": int(_dim(rect, "left")), "y": int(_dim(rect, "top")),
            "width": int(_dim(rect, "width")), "height": int(_dim(rect, "height"))}


class DesktopProbeUnavailable(ProbeUnavailable):
    """pywinauto 缺失或非 Windows 平台。与"取不到某一页"区分开。"""


def _require_uia():
    try:
        import pywinauto  # noqa: F401
        from pywinauto import Desktop
    except ImportError as error:  # pragma: no cover - 平台差异走单测桩
        raise DesktopProbeUnavailable(
            "pywinauto 未安装：桌面结构层不可用（pip install pywinauto）。") from error
    return Desktop


@dataclass
class DesktopProbe:
    """一次快照会话。调用方不持有 Application 对象，connect/disconnect 都在这里。"""

    max_nodes: int = MAX_NODES
    max_depth: int = MAX_DEPTH
    _nodes: int = field(default=0, init=False)

    # ---- 快照 ------------------------------------------------------------

    def snapshot(self, window_hint: dict[str, Any] | None = None) -> dict:
        """窗口 → 控件树扁平列表。hint: {title, title_re, class_name, pid} 任一组合。

        产物结构刻意与 Web 侧 FlatDom 同型（elements + source + truncated），
        取原料与判定之间不需要转换层。
        """
        Desktop = _require_uia()
        desktop = Desktop(backend="uia")
        windows = self._find_windows(desktop, window_hint or {})
        elements: list[dict[str, Any]] = []
        truncated = False
        for window in windows:
            self._nodes = 0
            walk = self._walk(window, path=f"win[{window.element_info.name or window.element_info.control_type}]")
            elements.extend(walk["elements"])
            truncated = truncated or walk["truncated"]
        return {
            "source": "dom",  # 结构层产物，与 Web ② 同级（桌面无"静态解析"层）
            "windows": [{"title": w.element_info.name, "class_name": w.element_info.class_name,
                         "pid": w.element_info.process_id} for w in windows],
            "element_count": len(elements),
            "elements": elements,
            "truncated": truncated,
        }

    @staticmethod
    def _find_windows(desktop: Any, hint: dict[str, Any]) -> list[Any]:
        """按 hint 圈定顶层窗口。不给 hint = 所有可见顶层窗口（顶部窗口在前）。

        backend 已由 Desktop(backend='uia') 构造时固定——windows() 再传一次会抛
        "Using another backend than set in Desktop constructor is not allowed"。
        """
        import pywinauto
        if hint.get("pid"):
            return list(desktop.windows(process=hint["pid"], top_level_only=True))
        if hint.get("title_re"):
            return list(desktop.windows(title_re=hint["title_re"], top_level_only=True))
        if hint.get("class_name"):
            return list(desktop.windows(class_name=hint["class_name"], top_level_only=True))
        if hint.get("title"):
            # 精确标题失败时退到子串匹配：窗口标题常带"未保存"等状态后缀。
            exact = list(desktop.windows(title=hint["title"], top_level_only=True))
            return exact or [w for w in desktop.windows(top_level_only=True)
                             if (hint["title"] or "") in (w.element_info.name or "")]
        all_windows = list(pywinauto.findwindows.find_elements(top_level_only=True, backend="uia"))
        return [desktop.window(handle=element.handle)
                for element in sorted(all_windows, key=lambda e: _area(_rect_of(e)), reverse=True)][:6]

    def _walk(self, wrapper: Any, path: str = "", depth: int = 0) -> dict[str, Any]:
        """控件树 → 扁平元素列表。每个元素带 anchor（≥2 指纹）与 children 计数。"""
        elements: list[dict[str, Any]] = []
        truncated = False
        stack = [(wrapper, path, depth)]
        while stack:
            current, current_path, current_depth = stack.pop()
            if self._nodes >= self.max_nodes or current_depth > self.max_depth:
                return {"elements": elements, "truncated": True}
            self._nodes += 1
            info = current.element_info
            # rect 在 wrapper 上（rectangle()），不在 element_info 上。
            element = {
                "control_type": info.control_type,
                "automation_id": info.automation_id or "",
                "name": info.name or "",
                "class_name": info.class_name or "",
                "enabled": bool(current.is_enabled()) if hasattr(current, "is_enabled") else True,
                "rect": _rect_dict(_rect_of(current)),
                "path": current_path,
                "depth": current_depth,
                "anchor": anchor_of({
                    "control_type": info.control_type, "automation_id": info.automation_id or "",
                    "name": info.name or "", "class_name": info.class_name or "",
                }),
            }
            elements.append(element)
            if current_depth < self.max_depth:
                try:
                    children = list(current.children())
                except Exception:
                    children = []
                # 深度优先的稳定顺序：栈要反着压，列表序才是 UIA 的自然序。
                for index, child in reversed(list(enumerate(children))):
                    stack.append((child, f"{current_path}/{info.control_type}[{index}]", current_depth + 1))
        return {"elements": elements, "truncated": truncated}

    # ---- 视觉定位反查（硬约束的落点） -------------------------------------

    def element_from_point(self, x: int, y: int) -> dict[str, Any]:
        """屏幕坐标 → UIA 锚点。Midscene 命中一个视觉位置后，立刻用它反查结构化指纹。

        命中的控件若无 automation_id 也无 name（纯容器），沿父链向上找
        POINT_ANCESTOR_LIMIT 层内第一个"可定位"的祖先，并把偏移记进 anchor——
        反查失败返回 anchor=None，让调用方如实标注 unresolved，而不是硬造一个锚点。
        """
        Desktop = _require_uia()
        desktop = Desktop(backend="uia")
        try:
            wrapper = desktop.from_point(int(x), int(y))
        except Exception as error:
            return {"ok": False, "anchor": None, "reason": f"point_lookup_failed:{error}"}
        return self._anchor_for_wrapper(wrapper, depth=POINT_ANCESTOR_LIMIT)

    def _anchor_for_wrapper(self, wrapper: Any, depth: int) -> dict[str, Any]:
        info = wrapper.element_info
        anchor = anchor_of({
            "control_type": info.control_type, "automation_id": info.automation_id or "",
            "name": info.name or "", "class_name": info.class_name or "",
        })
        rect = _rect_of(wrapper)
        if anchor is not None or depth <= 0:
            return {"ok": anchor is not None,
                    "anchor": anchor,
                    "rect": _rect_dict(rect) if rect else None,
                    "reason": None if anchor is not None else "no_stable_fingerprint"}
        try:
            parent = wrapper.parent()
        except Exception:
            parent = None
        if parent is None:
            return {"ok": False, "anchor": None, "reason": "no_stable_fingerprint"}
        return self._anchor_for_wrapper(parent, depth - 1)

    # ---- 锚点解析（重放的定位端） -----------------------------------------

    def resolve(self, window_hint: dict[str, Any], anchor: dict[str, Any]) -> dict[str, Any]:
        """按指纹在当前 UIA 树里解析锚点 → 命中元素的 rect 与指纹。重放层专用。

        匹配打分：automation_id 命中 > control_type+name+class_name 全命中 > 部分命中。
        多个同分时取面积最小的（小控件通常更具体）。解析不到返回 ok=False——
        重放层如实失败交归因，绝不猜一个最近的点。
        """
        snapshot = self.snapshot(window_hint)
        best: tuple[int, dict[str, Any]] | None = None
        for element in snapshot["elements"]:
            score = anchors_match(element, anchor)
            if score <= 0:
                continue
            area = element["rect"]["width"] * element["rect"]["height"]
            if best is None or score > best[0] or (score == best[0] and area < best[1]["rect"]["width"] * best[1]["rect"]["height"]):
                best = (score, element)
        if best is None:
            return {"ok": False, "reason": "anchor_not_found",
                    "snapshot_digest": len(snapshot["elements"])}
        element = best[1]
        anchor = element.get("anchor") or anchor_of(element)
        return {"ok": True, "rect": element["rect"], "anchor": anchor, "path": element["path"]}

    def screenshot(self, region: dict[str, int] | None = None) -> bytes:
        """屏幕截图 PNG。证据与视觉层的输入；分辨率随主屏。"""
        try:
            from PIL import ImageGrab
        except ImportError as error:  # pragma: no cover
            raise DesktopProbeUnavailable("Pillow 未安装：桌面截图不可用。") from error
        box = None
        if region:
            box = (region["x"], region["y"], region["x"] + region["width"], region["y"] + region["height"])
        image = ImageGrab.grab(bbox=box, all_screens=True)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()


# ---- 指纹纯函数（无 UIA 依赖，单测不打真桌面） ------------------------------

def anchor_of(info: dict[str, str]) -> dict[str, str] | None:
    """≥2 稳定指纹：automation_id 可单独成立；否则 control_type+name+class_name 组合。

    两者都凑不齐（无名无 id 的纯容器）返回 None——硬造一个不可复现的锚点比没有更糟。
    """
    automation_id = info.get("automation_id") or ""
    if automation_id:
        return {"automation_id": automation_id, "control_type": info.get("control_type") or "", "name": info.get("name") or ""}
    name = (info.get("name") or "").strip()
    control_type = info.get("control_type") or ""
    class_name = info.get("class_name") or ""
    if name and control_type and class_name:
        return {"control_type": control_type, "name": name, "class_name": class_name}
    return None


def anchors_match(element: dict[str, Any], anchor: dict[str, Any]) -> int:
    """锚点 ↔ 元素打分（0 = 不匹配）。只看指纹字段，坐标永不参与匹配。"""
    target = anchor.get("anchor") if "anchor" in anchor else anchor
    if not target:
        return 0
    automation_id = target.get("automation_id")
    if automation_id:
        if element.get("automation_id") != automation_id:
            return 0
        score = 4
        if target.get("control_type") and target["control_type"] == element.get("control_type"):
            score += 1
        return score
    fields = ["control_type", "name", "class_name"]
    if any(target.get(key) and target[key] != element.get(key) for key in fields):
        return 0
    hit = sum(1 for key in fields if target.get(key))
    return hit if hit >= 2 else 0


def element_receipt(element: dict[str, Any]) -> dict[str, Any]:
    """快照元素的对外形态：指纹 + 几何 + 路径，剥掉内部字段。"""
    keep = ("control_type", "automation_id", "name", "class_name", "rect", "path", "depth", "anchor")
    return {key: element[key] for key in keep if key in element}


def dump_snapshot(snapshot: dict[str, Any], path: str) -> str:
    """快照落盘（证据用）。json 顶层带 source/truncated，元素过 element_receipt。"""
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({**snapshot, "elements": [element_receipt(item) for item in snapshot["elements"]]},
                  handle, ensure_ascii=False, indent=2)
    return path
