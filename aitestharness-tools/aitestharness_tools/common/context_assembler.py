"""§10.10 上下文装配器：按 scope 切片喂模型，而不是每轮灌整份资料库。

解决的三个问题（现状"每轮对话前读整份资料库"的代价）：
    1. token 随资料库线性增长——测登录也要为库存模块的 300 条规则付费；
    2. 长上下文中段规则被忽略——long_ctx 是 LLM 最短板（§10.9），灌得越多漏得越多；
    3. **无法追溯**——资料库改了，产物为什么变说不清。本模块产出 `context_refs`，
    写入 `plan.lineage`，使每条测试可回答"基于哪版知识、哪版地图跑的"。

装配策略：
    - 按 scope（pages / apis / modules / keywords）匹配知识项与地图条目；
    - 与 scope 无关的**通用规则**（rule/constraint）默认保留——业务规则常常跨模块生效，
      裁掉它比裁掉介绍性文字危险得多；
    - 超预算时按优先级裁剪（rule/constraint > term/role > entity > flow），
      裁掉什么必须记在 dropped 里，不许静默丢；
    - 装配结果与账目一起返回，调用方据此写 lineage 并在报告里说明"本次仅装载了 N 条规则"。
"""
from __future__ import annotations

__all__ = ["assemble", "DEFAULT_BUDGET_TOKENS", "est_tokens", "ASSEMBLY_PRIORITY"]

DEFAULT_BUDGET_TOKENS = 8000        # 单次装配预算（中文按 1 字≈1 token 保守估）

# 裁剪优先级：数字越大越先保留
ASSEMBLY_PRIORITY = {
    "rule": 100, "constraint": 100,
    "term": 80, "role": 80,
    "entity": 60,
    "flow": 40,
    "page": 70, "api": 70, "login": 90,
}


def est_tokens(text: str) -> int:
    """保守估算：中文 1 字≈1 token，英文按 4 字符≈1 token 近似取大值。"""
    s = str(text or "")
    cjk = sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff")
    other = len(s) - cjk
    return cjk + (other + 3) // 4


def _item_text(it: dict) -> str:
    return f"[{it.get('type')}]{it.get('name')}：{it.get('statement') or ''}"


def _match_scope(item: dict, scope: dict) -> bool:
    """知识项与 scope 的相关性。

    保守原则：**scope 没给语义筛选条件（modules/keywords）时，知识项全量保留**。
    理由——漏装一条业务规则的代价（测试点缺维度、断言写错）远大于多花的那点 token；
    而 pages 只能过滤地图（页面/接口有明确 route），无法判断"这条规则属于哪个页面"。
    要按模块瘦身，scope 必须显式给 modules 或 keywords。
    """
    tags = {str(t) for t in (item.get("tags") or [])}
    section = str(item.get("section") or "")
    keys = {str(x) for x in (scope.get("keywords") or [])}
    mods = {str(x) for x in (scope.get("modules") or [])}
    if not keys and not mods:
        return True                                   # 无筛选条件 → 全量（保守）
    if tags & keys or tags & mods:
        return True
    if any(k and (k in section or k in str(item.get("name"))) for k in keys | mods):
        return True
    # 通用规则/约束默认保留：跨模块生效，裁掉风险高
    return item.get("type") in ("rule", "constraint") and not tags


def assemble(scope: dict | None = None, knowledge: dict | None = None,
             maps: dict | None = None, budget_tokens: int = DEFAULT_BUDGET_TOKENS,
             extra: list[dict] | None = None) -> dict:
    """装配一次上下文。

    scope: {pages: [...], apis: [...], modules: [...], keywords: [...]}
    knowledge: build_knowledge() 产出
    maps: build_maps() 产出
    extra: 额外片段 [{kind, text, priority}]（如历史缺陷摘要、上次失败原因）

    返回：
        context      —— 给模型的实际内容（分节）
        context_refs —— 写入 plan.lineage 的账目（版本 + 内容指纹 + 装载了什么）
        dropped      —— 因预算被裁掉的项（含原因，可解释）
        tokens_est / budget / utilization
        coverage     —— scope 在地图里的建档情况（见 maps.scope_coverage）
    """
    scope = scope or {}
    budget = int(budget_tokens or DEFAULT_BUDGET_TOKENS)
    entries: list[dict] = []          # {kind, priority, text, ref}

    # ---- 知识项 ----
    kb_items = (knowledge or {}).get("items") or []
    for it in kb_items:
        if not _match_scope(it, scope):
            continue
        entries.append({
            "kind": f"kb:{it['type']}",
            "priority": ASSEMBLY_PRIORITY.get(it["type"], 10),
            "text": _item_text(it),
            "ref": {"id": it["id"], "type": it["type"],
                    "fingerprint": it.get("fingerprint")},
        })

    # ---- 地图条目：只取 scope 涉及的页面/接口 ----
    mp = maps or {}
    want_pages = set(scope.get("pages") or [])
    want_apis = {str(a) for a in (scope.get("apis") or [])}
    for p in mp.get("pages") or []:
        if want_pages and p["route"] not in want_pages:
            continue
        ctrls = ", ".join(f"{c.get('control_type')}:{c.get('name') or c.get('text') or '-'}"
                          for c in (p.get("controls") or [])[:12])
        entries.append({
            "kind": "map:page",
            "priority": ASSEMBLY_PRIORITY["page"],
            "text": f"[页面]{p['route']} 控件({p.get('control_count', 0)}): {ctrls or '未建档'}",
            "ref": {"route": p["route"], "registered": p.get("registered")},
        })
    for a in mp.get("apis") or []:
        key = f"{a['method']} {a['path']}"
        if want_apis and key not in want_apis and a.get("module") not in (scope.get("modules") or []):
            continue
        entries.append({
            "kind": "map:api",
            "priority": ASSEMBLY_PRIORITY["api"],
            "text": f"[接口]{key} module={a.get('module')}"
                    + (f" required={a['required']}" if a.get("required") else ""),
            "ref": {"api": key},
        })
    if mp.get("login"):
        lg = mp["login"]
        entries.append({
            "kind": "map:login",
            "priority": ASSEMBLY_PRIORITY["login"],
            "text": f"[登录] 表单={lg.get('form_detected')} 验证码={lg.get('captcha_type')} "
                    f"会话固化={lg.get('session_saved')}",
            "ref": {"login": True},
        })

    for e in extra or []:
        entries.append({"kind": e.get("kind") or "extra",
                        "priority": int(e.get("priority", 30)),
                        "text": str(e.get("text") or ""),
                        "ref": e.get("ref") or {"extra": True}})

    # ---- 预算裁剪：高优先级优先，同级保持原序（稳定 = 可复现） ----
    entries.sort(key=lambda e: -e["priority"])
    kept, dropped, used = [], [], 0
    for e in entries:
        t = est_tokens(e["text"])
        if used + t > budget and kept:
            dropped.append({"kind": e["kind"], "ref": e["ref"], "tokens": t,
                            "reason": "budget_exceeded"})
            continue
        kept.append({**e, "tokens": t})
        used += t

    # 恢复文档顺序（知识项在前、地图在后、额外片段最后；同类按原序）
    order = {"kb": 0, "map": 1}
    kept.sort(key=lambda e: (order.get(e["kind"].split(":")[0], 2),
                             -e["priority"]))

    context = {}
    for e in kept:
        bucket = "knowledge" if e["kind"].startswith("kb:") else (
            "environment" if e["kind"].startswith("map:") else "extra")
        context.setdefault(bucket, []).append(e["text"])

    coverage = None
    if mp:
        from ..knowledge.maps import scope_coverage
        coverage = scope_coverage(scope, mp)

    refs = {
        "scope": {"pages": sorted(want_pages), "apis": sorted(want_apis),
                  "modules": sorted(scope.get("modules") or []),
                  "keywords": sorted(scope.get("keywords") or [])},
        "knowledge": {"version": (knowledge or {}).get("_build_meta", {}).get("version"),
                      "content_hash": (knowledge or {}).get("content_hash"),
                      "loaded": sum(1 for e in kept if e["kind"].startswith("kb:")),
                      "total": len(kb_items)},
        "maps": {"env": mp.get("env"), "probed_at": mp.get("probed_at"),
                 "content_hash": mp.get("content_hash"),
                 "pages_loaded": sum(1 for e in kept if e["kind"] == "map:page"),
                 "apis_loaded": sum(1 for e in kept if e["kind"] == "map:api")},
        "dropped_count": len(dropped),
        "tokens_est": used,
        "budget": budget,
    }
    return {"context": context, "context_refs": refs, "dropped": dropped,
            "tokens_est": used, "budget": budget,
            "utilization": round(used / budget, 3) if budget else None,
            "coverage": coverage,
            "statement": f"装载知识 {(refs['knowledge'])['loaded']}/{(refs['knowledge'])['total']} 条、"
                         f"页面 {(refs['maps'])['pages_loaded']} 个、"
                         f"接口 {(refs['maps'])['apis_loaded']} 个，"
                         f"{used}/{budget} tokens，裁剪 {len(dropped)} 项"}
