"""§10.10 环境事实资产（maps）：把"系统长什么样"变成可版本化资产。

现状缺口：项目资料库只有**业务知识**（md 文档），没有**环境事实**（有哪些页面、哪些
接口、哪些控件、登录怎么走）。后果是 AI 有"该测什么"的知识，却不知道"页面上有什么"，
只能每次执行时现去浏览器里找——这就是演示时十几分钟跑不起来、token 烧光的另一半原因。

本模块负责环境事实的**资产化**（探测本身在 explore/explorer.py，零 LLM）：
    1. build_maps    —— 路由 + 控件 + 接口 + 登录路径 → maps IR（带探测时间与版本）
    2. diff_maps     —— 两次探测的差异（页面/接口新增消失、控件变化）→ 影响候选
    3. scope_coverage—— scope 里的页面/接口是否都已建档（未建档＝要现场探，提前告警）
    4. maps_staleness—— 建档过期提醒（版本升级后地图会失真，过期地图比没有更危险）
    5. affected_cases—— 地图变化 → 按 touched 反查受影响用例
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..common.lineage import content_hash

__all__ = ["build_maps", "diff_maps", "scope_coverage", "maps_staleness",
           "affected_cases", "DEFAULT_MAX_AGE_DAYS"]

DEFAULT_MAX_AGE_DAYS = 14


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_maps(project: str, env: str, routes: list[str] | None = None,
               controls_by_page: dict[str, dict] | None = None,
               apis: list[dict] | None = None,
               login: dict | None = None,
               probed_at: str | None = None,
               engine_version: str = "1.0.0",
               actor: str = "program:explorer") -> dict:
    """产出 maps IR 正文。

    routes：explorer.extract_routes() 的 routes（零 LLM 解析 JS 路由表）
    controls_by_page：{route: extract_controls() 的输出}
    apis：parse_openapi() 的接口清单，或抓包得到的 [{method, path, module}]
    login：登录器固化结果 {form_detected, selector_set, captcha_type, session_saved}
    """
    pages = []
    if controls_by_page is not None and not isinstance(controls_by_page, dict):
        raise TypeError("controls_by_page 必须是 {route: extract_controls() 输出} 的映射，"
                        f"收到 {type(controls_by_page).__name__}")
    for r in sorted(set(routes or [])):
        ctrl = (controls_by_page or {}).get(r) or {}
        pages.append({
            "route": r,
            "controls": ctrl.get("controls") or [],
            "control_count": ctrl.get("control_count", len(ctrl.get("controls") or [])),
            "registered": bool(ctrl),      # 有控件清单才算真建档，只有路由不算
        })
    api_list = sorted(
        [{"method": (a.get("method") or "GET").upper(),
          "path": a.get("path") or "",
          "module": a.get("module") or a.get("tag") or "default",
          "required": sorted(a.get("required") or [])} for a in (apis or [])],
        key=lambda x: (x["path"], x["method"]))
    body = {
        "type": "maps",
        "project": project,
        "env": env,
        "pages": pages,
        "apis": api_list,
        "login": login or {},
        "stats": {
            "pages": len(pages),
            "pages_registered": sum(1 for p in pages if p["registered"]),
            "apis": len(api_list),
            "controls": sum(p["control_count"] for p in pages),
        },
        "probed_at": probed_at or _now(),
        "engine_version": engine_version,
    }
    body["content_hash"] = content_hash({
        "pages": [p["route"] for p in pages],
        "apis": [f"{a['method']} {a['path']}" for a in api_list],
    })
    return {**body, "_build_meta": {"actor": actor,
                                    "note": "控件清单为空的页面视为未建档，需补探"}}


def diff_maps(old: dict, new: dict) -> dict:
    """两次建档的差异。页面/接口的新增与消失都会影响用例有效性。

    为什么必须做这个：版本升级后页面路由改了，旧用例的步骤指向不存在的页面——
    不 diff 就会表现为"元素找不到"的自愈风暴，或被误判成 flaky。
    """
    o_pages = {p["route"] for p in (old or {}).get("pages") or []}
    n_pages = {p["route"] for p in (new or {}).get("pages") or []}
    o_apis = {f"{a['method']} {a['path']}" for a in (old or {}).get("apis") or []}
    n_apis = {f"{a['method']} {a['path']}" for a in (new or {}).get("apis") or []}

    o_ctrl = {p["route"]: p.get("control_count", 0) for p in (old or {}).get("pages") or []}
    n_ctrl = {p["route"]: p.get("control_count", 0) for p in (new or {}).get("pages") or []}
    ctrl_changed = [{"route": r, "before": o_ctrl[r], "after": n_ctrl[r]}
                    for r in sorted(set(o_ctrl) & set(n_ctrl))
                    if o_ctrl[r] != n_ctrl[r]]

    d = {"pages_added": sorted(n_pages - o_pages),
         "pages_removed": sorted(o_pages - n_pages),
         "apis_added": sorted(n_apis - o_apis),
         "apis_removed": sorted(o_apis - n_apis),
         "controls_changed": ctrl_changed,
         "env_changed": (old or {}).get("env") != (new or {}).get("env")}
    d["breaking"] = bool(d["pages_removed"] or d["apis_removed"] or d["env_changed"])
    d["summary"] = (f"页面 +{len(d['pages_added'])}/-{len(d['pages_removed'])}，"
                    f"接口 +{len(d['apis_added'])}/-{len(d['apis_removed'])}，"
                    f"控件变化 {len(ctrl_changed)} 页")
    return d


def scope_coverage(scope: dict, maps: dict) -> dict:
    """scope 中的页面/接口是否都已建档。

    价值：在动手之前就告诉用户"这 3 个页面没建过档，需要先探一遍"，
    而不是执行到一半发现元素找不到。
    """
    pages = {p["route"] for p in (maps or {}).get("pages") or []}
    reg = {p["route"] for p in (maps or {}).get("pages") or [] if p.get("registered")}
    apis = {f"{a['method']} {a['path']}" for a in (maps or {}).get("apis") or []}

    want_pages = [p for p in (scope.get("pages") or [])]
    want_apis = [a if " " in str(a) else str(a) for a in (scope.get("apis") or [])]
    missing_pages = [p for p in want_pages if p not in pages]
    unregistered = [p for p in want_pages if p in pages and p not in reg]
    missing_apis = [a for a in want_apis if a not in apis]
    ok = not missing_pages and not missing_apis
    return {"ok": ok, "missing_pages": missing_pages,
            "unregistered_pages": unregistered, "missing_apis": missing_apis,
            "advice": ("scope 已全量建档，可直接进入测试设计" if ok
                       else f"{len(missing_pages)} 个页面/接口未建档，建议先跑环境建档"
                            f"（零 LLM，10 秒级），否则执行期会现找元素")}


def maps_staleness(maps: dict, now: str | None = None,
                   max_age_days: int = DEFAULT_MAX_AGE_DAYS) -> dict:
    """建档是否过期。过期地图比没有地图更危险——它会让人以为已经知道有什么。"""
    probed = (maps or {}).get("probed_at")
    if not probed:
        return {"stale": True, "age_days": None, "reason": "missing_probed_at",
                "advice": "无探测时间，按过期处理"}
    try:
        t = datetime.strptime(probed, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return {"stale": True, "age_days": None, "reason": "bad_probed_at",
                "advice": "探测时间格式非法，按过期处理"}
    cur = (datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
           if now else datetime.now(timezone.utc))
    age = (cur - t).days
    return {"stale": age > max_age_days, "age_days": age,
            "max_age_days": max_age_days,
            "advice": ("地图已过期，建议重新建档后再跑回归"
                       if age > max_age_days else "地图有效")}


def affected_cases(diff: dict, cases: list[dict]) -> dict:
    """地图变化 → 受影响用例（按用例的 touched 反查）。

    cases: [{id, touched: {pages: [...], apis: [...]}}]
    返回 {must_rerun: [...], retired: [...], reason_by_case: {...}}
      retired —— 用例触及的页面/接口已被删除，直接退场（不是 fail，是不适用）
    """
    gone_pages = set(diff.get("pages_removed") or [])
    gone_apis = set(diff.get("apis_removed") or [])
    touched_pages = set(diff.get("pages_added") or [])
    touched_apis = set(diff.get("apis_added") or [])
    changed_pages = {c["route"] for c in diff.get("controls_changed") or []}

    must, retired, reason = [], [], {}
    for c in cases or []:
        t = c.get("touched") or {}
        cp = set(t.get("pages") or [])
        ca = set(t.get("apis") or [])
        hit_gone_p = cp & gone_pages
        hit_gone_a = ca & gone_apis
        if hit_gone_p or hit_gone_a:
            retired.append(c.get("id"))
            reason[c.get("id")] = f"依赖已消失：{sorted(hit_gone_p | hit_gone_a)}"
            continue
        hit = (cp & changed_pages) | (cp & touched_pages) | (ca & touched_apis)
        if hit:
            must.append(c.get("id"))
            reason[c.get("id")] = f"触及变更：{sorted(hit)}"
    return {"must_rerun": must, "retired": retired,
            "reason_by_case": reason,
            "summary": f"需重跑 {len(must)} 条、退场 {len(retired)} 条"}
