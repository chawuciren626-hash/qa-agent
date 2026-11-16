"""§11.4 Web 专有工具中可形式化的部分：结构化 DOM 快照 + iframe/shadow 标注 + 基线 diff。

分工先说清楚（这是 M2 能不能顺利接上的关键）：
    · Playwright 只负责**取原料**：把页面 DOM 拉成扁平元素列表（含 frame 路径、
      shadow 宿主链），传进 `build_snapshot`；
    · 本模块负责**判定**：哪些元素归为交互控件、在哪一层、指纹怎么取、跟上一次比什么变了。

    这样做的理由：DOM 结构判定是纯函数，可单测；而浏览器驱动必须在本机跑、易崩、
    不能单测。把两者搅在一起，任何 DOM 规则调整都要开浏览器验证，成本高到没人愿意改。

三条规则来自实际踩坑：
    1. **iframe / shadow 必须显式标注**：不标注时，同一份 css 会在主文档和 iframe 里
       各命中一次，引擎要么报歧义要么点错元素——这是 Web 自动化最经典的假失败来源；
    2. **快照必须削体积**：整页 outerHTML 动辄几 MB，进证据包会撑爆保留期策略，
       也会把 token 烧在无关的样式类上。只留交互元素 + 必要属性；
    3. **基线 diff 只比语义差异**：文字从"提交"变"提交 "不该报变更（空白噪音），
       但"提交"变"提交订单"必须报（按钮语义变了，用例文案断言会失效）。

零 LLM。
"""
from __future__ import annotations

import re

__all__ = ["MAX_ELEMENTS", "build_snapshot", "fingerprints_of", "diff_snapshot",
           "snapshot_to_controls", "frame_path_of"]

# 快照元素上限：超过说明页面异常（如把整张表展开成 5000 行），截断并标注
MAX_ELEMENTS = 800

_INTERACTIVE_TAGS = {"input", "textarea", "select", "button", "a", "table",
                     "form", "label", "details"}
_INTERACTIVE_ROLES = {"button", "link", "checkbox", "radio", "textbox", "combobox",
                      "tab", "menuitem", "option", "switch", "slider"}
# 只保留与定位/断言有关的属性（class 只留前 3 个，避免样式哈希噪音）
_KEEP_ATTRS = ("id", "name", "type", "role", "aria-label", "aria-labelledby",
               "placeholder", "data-testid", "data-test", "data-cy", "href",
               "title", "value", "disabled", "readonly", "required", "maxlength")
_WS = re.compile(r"\s+")


def _norm(s) -> str:
    return _WS.sub(" ", str(s or "")).strip()


def frame_path_of(el: dict) -> str:
    """元素所在的 frame 路径：`main` / `main>iframe#pay` / `main>#host::shadow`。

    为什么用字符串而不是嵌套结构：进证据包、写进定位器、跟人沟通都是同一串话，
    嵌套结构每次都要重新解释一遍。
    """
    parts = ["main"]
    for f in el.get("frames") or []:
        sel = f.get("selector") if isinstance(f, dict) else str(f)
        if sel:
            parts.append(str(sel))
    host = el.get("shadow_host")
    if host:
        parts.append(f"{host}::shadow")
    return ">".join(parts)


def fingerprints_of(el: dict) -> dict:
    """从扁平元素生成多指纹（沿用 §9 优先级：testid → role → label → text → css → xpath）。"""
    attrs = {k: el.get(k) for k in _KEEP_ATTRS}
    attrs = {k: v for k, v in attrs.items() if v not in (None, "")}
    testid = attrs.get("data-testid") or attrs.get("data-test") or attrs.get("data-cy")
    label = attrs.get("aria-label") or el.get("label_text") or attrs.get("placeholder")
    role = attrs.get("role")
    if not role:
        tag = _norm(el.get("tag")).lower()
        role = {"button": "button", "a": "link", "input": (
            "checkbox" if _norm(attrs.get("type")).lower() == "checkbox" else "textbox"),
            "select": "combobox"}.get(tag)
    text = _norm(el.get("text"))[:40] or None
    css = None
    if attrs.get("id"):
        css = f"#{attrs['id']}"
    elif attrs.get("name"):
        css = f"[name=\"{attrs['name']}\"]"
    xpath = None
    if attrs.get("id"):
        xpath = f"//*[@id='{attrs['id']}']"
    return {k: v for k, v in {"testid": testid, "role": role, "label": label,
                              "text": text, "css": css, "xpath": xpath}.items() if v}


def _is_interactive(el: dict) -> bool:
    tag = _norm(el.get("tag")).lower()
    role = _norm(el.get("role")).lower()
    if el.get("listener") or el.get("clickable"):
        return True
    return tag in _INTERACTIVE_TAGS or role in _INTERACTIVE_ROLES


def build_snapshot(page: str, elements: list[dict],
                   taken_at: str | None = None,
                   max_elements: int = MAX_ELEMENTS) -> dict:
    """把 Playwright 取到的扁平 DOM 原料 → 结构化快照（确定性，可单测）。

    elements 每项：{tag, text, id?, name?, type?, role?, aria-label?, placeholder?,
                    data-testid?, href?, disabled?, frames?: [{selector}], shadow_host?,
                    visible?: bool, enabled?: bool}

    返回：
      {type:"dom_snapshot", page, elements:[{idx, tag, frame_path, fingerprints, attrs,
        visible, enabled}], by_frame, truncated, counts}

    `by_frame` 是给定位器用的：同一指纹在不同 frame 里出现时必须按 frame 分组，
    否则运行时会被判 ambiguous（现在这个判定是对的，问题在快照没给足信息）。
    """
    els = []
    by_frame: dict[str, int] = {}
    non_interactive = 0
    for el in elements or []:
        if not isinstance(el, dict):
            continue
        if not _is_interactive(el):
            non_interactive += 1
            continue
        fp = frame_path_of(el)
        by_frame[fp] = by_frame.get(fp, 0) + 1
        els.append({
            "idx": len(els),
            "tag": _norm(el.get("tag")).lower(),
            "frame_path": fp,
            "text": _norm(el.get("text"))[:60],
            "fingerprints": fingerprints_of(el),
            "attrs": {k: v for k, v in el.items()
                      if k in _KEEP_ATTRS and v not in (None, "")},
            "visible": bool(el.get("visible", True)),
            "enabled": bool(el.get("enabled", not el.get("disabled"))),
        })
        if len(els) >= max_elements:
            break
    return {
        "type": "dom_snapshot",
        "page": page,
        "taken_at": taken_at,
        "elements": els,
        "by_frame": by_frame,
        "truncated": len(els) >= max_elements,
        "counts": {"interactive": len(els), "skipped_non_interactive": non_interactive,
                   "frames": len(by_frame)},
        "note": ("检测到多 frame/shadow 上下文：定位器必须带 frame_path，"
                 "否则同一 css 会在多个上下文里命中（§11.4 Web 主要假失败源）"
                 if len(by_frame) > 1 else "单一主文档上下文"),
    }


def snapshot_to_controls(snapshot: dict) -> dict:
    """快照 → 探索器 `extract_controls` 可直接吃的格式（打通阶段②与 §9 元素库）。

    为什么要转：探索器只认 `{interactive:[{tag,type,name,...}]}`，而快照是更结构化的
    形式。没有这个桥，两条链路各存一份控件清单，改一处就漂移。
    """
    interactive = []
    for e in snapshot.get("elements") or []:
        a = e.get("attrs") or {}
        interactive.append({
            "tag": e.get("tag"), "type": a.get("type"), "name": a.get("name") or a.get("id"),
            "id": a.get("id"), "text": e.get("text"), "role": a.get("role"),
            "testid": a.get("data-testid") or a.get("data-test"),
            "frame_path": e.get("frame_path"),
        })
    return {"interactive": interactive, "page": snapshot.get("page"),
            "frame_paths": sorted({e.get("frame_path") for e in snapshot.get("elements") or []
                                   if e.get("frame_path")})}


def diff_snapshot(old: dict, new: dict) -> dict:
    """两次快照的语义 diff（基线比对用，不涉及图像）。

    比对口径（刻意保守）：
      · 指纹集合相同即视为同一元素——不看 index（DOM 顺序会因插入广告位、埋点而变）；
      · 只报四类变化：新增元素 / 消失元素 / 文本变化 / 可见性变化；
      · **文本变化用规范化后比较**：空白差异不报，语义差异必报。

    返回 {added, removed, text_changed, visibility_changed, counts, advice}
    用途：① 元素库失效判定（`removed` → 进 retired 历史）；② 改版后用例是否要重审。
    """
    def key(e):
        fps = e.get("fingerprints") or {}
        return (e.get("frame_path") or "main",
                fps.get("testid") or fps.get("css") or fps.get("xpath")
                or f"{e.get('tag')}|{fps.get('role')}|{fps.get('label') or fps.get('text')}")

    o = {key(e): e for e in (old or {}).get("elements") or []}
    n = {key(e): e for e in (new or {}).get("elements") or []}

    added = [{"key": k, "text": n[k].get("text")} for k in n if k not in o]
    removed = [{"key": k, "text": o[k].get("text")} for k in o if k not in n]
    text_changed, vis_changed = [], []
    for k in set(o) & set(n):
        if _norm(o[k].get("text")) != _norm(n[k].get("text")):
            text_changed.append({"key": k, "from": o[k].get("text"), "to": n[k].get("text")})
        if bool(o[k].get("visible")) != bool(n[k].get("visible")):
            vis_changed.append({"key": k, "from": o[k].get("visible"),
                                "to": n[k].get("visible")})
    total = len(set(o) | set(n))
    changed = len(added) + len(removed) + len(text_changed) + len(vis_changed)
    ratio = round(changed / total, 4) if total else 0.0
    return {
        "added": added, "removed": removed,
        "text_changed": text_changed, "visibility_changed": vis_changed,
        "counts": {"captured": total, "added": len(added), "removed": len(removed),
                   "text_changed": len(text_changed),
                   "visibility_changed": len(vis_changed), "change_ratio": ratio},
        "advice": ("页面无变化" if changed == 0 else
                   ("改动面较大（>30%），建议按新快照重新登记元素库"
                    if ratio > 0.3 else
                    f"{changed} 处变化：removed 进 retired 历史，text_changed 需核查文案断言")),
        "retire_candidates": [r["key"] for r in removed],
    }
