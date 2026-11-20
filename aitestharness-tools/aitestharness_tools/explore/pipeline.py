"""探索流水线（M2a）：把「取原料」串成「项目地图」，全程零 LLM。

三段结构（与文档 §5 一致）：

    ① 静态解析 probe.fetch_bundle   → 路由清单 + 技术栈        （0 token，秒级）
    ② 结构巡检 probe.flat_dom       → 扁平 DOM → 快照 → 控件   （0 token）
    ③ 视觉兜底                       → **不在这里**，见下

关于 ③ 为什么不在本文件：视觉兜底要调模型，而本文件必须能在 CI 里对任意页面跑、结果确定。
所以这里只做「如实标记」——取不到的页面写 `source="unresolved"` 并保留 PartialFailure 的
原因与已试手段，由 agent 层决定是否为它起一次视觉探测（M2b，受硬预算约束）。

三条纪律：

1. **不把失败当空结果**：某页取不到 ≠ 该页没有控件。unresolved 页面的 `controls` 恒为 None，
   下游若把 None 当空列表算覆盖率，就会得到"覆盖 100%"的假结论。
2. **每个产物带 source**：`bundle` / `dom` / `unresolved` 三态，回答"这条信息怎么来的"。
3. **预算由工程决定**：页面数、每页动作数都受 BudgetGuard 约束，不靠模型自觉（§15.3）。
"""
from __future__ import annotations

import hashlib
import json
import urllib.parse

from ..exec.snapshot import build_snapshot, snapshot_to_controls
from ..probe.base import (PartialFailure, ProbeUnavailable,
                          SOURCE_BUNDLE, SOURCE_DOM, SOURCE_UNRESOLVED)
from .explorer import (BudgetGuard, detect_stack, extract_controls, extract_routes,
                       controls_to_test_points)

__all__ = ["explore", "PIPELINE_VERSION"]

PIPELINE_VERSION = 1


def _canonical_hash(payload: dict) -> str:
    """地图内容指纹：G9 的 content_hash 就靠它，用来判断"地图变了没有、plan 是否过期"。"""
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _absolute(start_url: str, route: str) -> str:
    return urllib.parse.urljoin(start_url, route)


def _route_key(url: str, start_url: str) -> str:
    """页面身份用「path?query」，不用完整 URL：换端口/换域名时地图不该失效。"""
    base = urllib.parse.urlsplit(start_url)
    parts = urllib.parse.urlsplit(url)
    key = parts.path or "/"
    if parts.query:
        key = f"{key}?{parts.query}"
    if base.netloc and parts.netloc and base.netloc != parts.netloc:
        key = f"//{parts.netloc}{key}"
    return key


def explore(start_url: str, probe, *, budget: BudgetGuard | None = None,
            extra_routes: list[str] | None = None, include_test_points: bool = True,
            max_routes: int | None = None) -> dict:
    """跑一次探索，返回可入库的地图草案。

    start_url：入口页。路由以它做基准拼绝对 URL。
    probe    ：实现 `probe.base.WebProbe` 的探针（HttpProbe / PlaywrightProbe / 测试替身）。
    budget   ：页面预算；不传则用 DEFAULT_BUDGET，**不允许无上限**。

    返回结构（写进 qa_environment_maps 的最小集）：
        {version, start_url, stack, probe, routes:{routes,prefixes,count},
         pages:[{page,url,source,controls,elements,snapshot_digest}],
         unresolved:[{page,url,source,reason,tried}],
         stats:{...}, content_hash}
    """
    guard = budget or BudgetGuard()
    bundle = probe.fetch_bundle(start_url)
    if bundle.error and not bundle.html:
        # 入口页都拿不到：整次探索失败，不产生空地图（空地图比没有地图更危险）。
        raise PartialFailure(start_url, f"入口页取不到：{bundle.error}",
                             tried=[SOURCE_BUNDLE], detail={"probe": getattr(probe, "name", "?")})

    js_text = bundle.js_text()
    parsed_routes = extract_routes(js_text)
    stack = detect_stack((bundle.html or "") + js_text)

    route_list: list[str] = ["/"]
    route_list.extend(parsed_routes.get("routes") or [])
    route_list.extend(extra_routes or [])
    if max_routes is not None:
        route_list = route_list[:max_routes]

    pages: list[dict] = []
    unresolved: list[dict] = []
    driver_gone = False

    for route in route_list:
        url = _absolute(start_url, route)
        page_key = _route_key(url, start_url)
        allowed, reason = guard.can_inspect(url)
        if not allowed:
            unresolved.append({"page": page_key, "url": url, "source": SOURCE_UNRESOLVED,
                               "reason": f"预算拦下：{reason}", "tried": []})
            continue
        if driver_gone:
            unresolved.append({"page": page_key, "url": url, "source": SOURCE_UNRESOLVED,
                               "reason": "驱动不可用（本机无浏览器），未尝试结构巡检",
                               "tried": [SOURCE_BUNDLE]})
            continue
        try:
            dom = probe.flat_dom(url)
        except ProbeUnavailable as error:
            driver_gone = True
            unresolved.append({"page": page_key, "url": url, "source": SOURCE_UNRESOLVED,
                               "reason": str(error), "tried": [SOURCE_BUNDLE]})
            continue
        except PartialFailure as failure:
            unresolved.append({"page": page_key, **failure.as_dict()})
            continue

        guard.consume_inspect(url)
        snapshot = build_snapshot(page_key, dom.elements)
        controls = extract_controls(snapshot_to_controls(snapshot))
        pages.append({
            "page": page_key,
            "url": url,
            "source": SOURCE_DOM,
            "controls": controls,
            "elements": snapshot.get("counts") or {},
            "frames": dom.frames,
            "truncated": bool(dom.truncated or snapshot.get("truncated")),
            "snapshot_digest": _canonical_hash(snapshot)[:16],
        })

    test_points: list[dict] = []
    if include_test_points:
        for page in pages:
            test_points.extend(controls_to_test_points(page["page"], page["controls"] or {}))

    # ① 静态解析本身也产出一层信息：路由来自 JS 原文，即使没巡检（预算截断），也已经有"有哪些页面"。
    # 这些页面的 source=bundle、controls=None——语义是"知道它在，但没看过里面"，
    # 下游算覆盖率时必须把它们排除在分母外，否则会得到"覆盖 100%"的假结论。
    attempted = {_route_key(_absolute(start_url, route), start_url) for route in route_list}
    for route in parsed_routes.get("routes") or []:
        url = _absolute(start_url, route)
        page_key = _route_key(url, start_url)
        if page_key in attempted or any(page["page"] == page_key for page in pages):
            continue
        pages.append({"page": page_key, "url": url, "source": SOURCE_BUNDLE,
                      "controls": None, "elements": {}, "frames": [],
                      "truncated": False, "snapshot_digest": None})

    by_source: dict[str, int] = {}
    for page in pages:
        by_source[page["source"]] = by_source.get(page["source"], 0) + 1
    for item in unresolved:
        by_source[SOURCE_UNRESOLVED] = by_source.get(SOURCE_UNRESOLVED, 0) + 1

    maps = {
        "version": PIPELINE_VERSION,
        "start_url": start_url,
        "stack": stack,
        "probe": getattr(probe, "name", "unknown"),
        "routes": parsed_routes,
        "pages": sorted(pages, key=lambda item: item["page"]),
        "unresolved": unresolved,
        "test_points": test_points,
        "stats": {
            "route_count": len(route_list),
            "inspected": len([page for page in pages if page["source"] == SOURCE_DOM]),
            "bundle_only": by_source.get(SOURCE_BUNDLE, 0),
            "unresolved": len(unresolved),
            "controls": sum(len((page.get("controls") or {}).get("controls") or []) for page in pages),
            "test_points": len(test_points),
            "budget_used": {"inspected": len(guard.inspected), "cap": guard.inspect_pages},
            "by_source": by_source,
        },
    }
    maps["content_hash"] = _canonical_hash({key: value for key, value in maps.items() if key != "content_hash"})
    return maps
