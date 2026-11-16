"""§6.2 / §6.3 血缘增量重算：资料库变了，只重算该重算的那部分。

解决的问题很具体：现有工程的用法是「每轮读整份资料库」。资料一改，下游全部重来一遍——
500 条用例的项目，改一句措辞就要重审全量，团队一个月内就会放弃这套机制。

本文件实现 §6.2 的六步流程（纯代码、零 LLM）：
    1. normalize_text  —— 语义指纹：去格式噪音后的 hash（**不是文档 hash**）
    2. diff_knowledge  —— 旧新知识库对账：分「语义变更 / 仅表述变更 / 新增 / 删除」
    3. lineage_closure —— 沿血缘边求闭包：哪些下游产物要重算
    4. incremental_plan—— 组一份可执行的重算计划（只喂受影响子图 + 人工只审 diff）

关键判据（§6.3）：
    · 表述变更（措辞、章节重排、错别字）→ **只更新指纹，不触发重算**；
    · 语义变更 → 重算闭包，人工审 diff；
    · 不做这一步，每次小改都全量重跑，机制必然被弃用。

诚实边界：语义指纹是**字符级规范化 hash**，不是语义理解。它能识别"去标点后一致"，
识别不了"满100减10"与"消费百元立减十元"是同一条。后者要靠 LLM 判，那属于
`requirement_extract` 的活，不进本模块（否则每次资料更新都要烧 token）。
"""
from __future__ import annotations

import unicodedata
from difflib import SequenceMatcher

from ..common.lineage import semantic_fingerprint

__all__ = ["normalize_text", "diff_knowledge", "lineage_closure",
           "incremental_plan", "similarity", "RECOMPUTE_RULES"]


def normalize_text(text: str) -> str:
    """语义指纹的原始输入规范化：NFKC → 折叠空白 → 去控制字符。

    与 lineage.semantic_fingerprint 的差别：那个还会去标点转小写（用于"同一条规则"去重），
    这个保留标点与大小写——"满 100 减 10" 和 "满100减10" 应视为同一句，
    但 "金额>100" 与 "金额<100" 不能因为都去掉符号而撞成一条。
    """
    s = unicodedata.normalize("NFKC", str(text or ""))
    s = "".join(" " if ch.isspace() or unicodedata.category(ch) == "Cc" else ch for ch in s)
    return " ".join(s.split())


def similarity(a: str, b: str) -> float:
    """相似度（只用于报告"改了多少"，不参与任何判定）。"""
    return round(SequenceMatcher(None, normalize_text(a), normalize_text(b)).ratio(), 4)


# 各类产物对「知识变更」的敏感度：knowledge 变了，谁的结论会被推翻
RECOMPUTE_RULES: dict[str, dict] = {
    "requirement": {"on": ("rule", "constraint", "term", "role", "flow"),
                    "why": "业务规则/约束/术语变了，需求项的判定依据就变了"},
    "testpoint": {"on": ("rule", "constraint", "role"),
                  "why": "规则与约束决定维度矩阵里该有哪些格子"},
    "case": {"on": ("rule", "constraint", "term"),
             "why": "断言来自测试点预期，而预期来自规则原文"},
    "plan": {"on": ("rule", "constraint", "term"),
             "why": "计划里的预期值是固化时写死的，规则一改就过期"},
    "defect": {"on": ("rule",),
               "why": "归因依据的「是否合规」判断会变"},
    "report": {"on": (),
               "why": "报告只消费 exec 事实与 facts，知识变更不直接影响（等下轮执行自然更新）"},
}


def _by_key(knowledge: dict) -> dict[str, dict]:
    """知识项索引：优先用语义指纹（判定语义变更），没有指纹用 id。"""
    out = {}
    for it in (knowledge or {}).get("items") or []:
        key = it.get("fingerprint") or it.get("id")
        if key:
            out[key] = it
    return out


def diff_knowledge(old: dict, new: dict,
                   rename_threshold: float = 0.86) -> dict:
    """旧新知识库对账，四类结果分开报（**这是不触发全量重跑的关键**）。

    返回：
      semantic_changed —— 指纹不同但能对上（同一 id，statement 变化）→ 要重算
      wording_only     —— 指纹相同、原文表述不同 → **只更新指纹，不重算**
      renamed          —— id 变了但内容高度相似 → 视为同一项改标签，只记不改结论
      added / removed  —— 新增 / 删除

    判定顺序（顺序错了会把表述变更误判成语义变更）：
      1. 指纹相同 → wording_only（哪怕 id/name 不同）；
      2. 指纹不同但 id 相同 → semantic_changed；
      3. 指纹不同、id 也不同但相似度高 → renamed；
      4. 其余 → added / removed。
    """
    o, n = _by_key(old), _by_key(new)
    old_by_id = {it.get("id"): it for it in (old or {}).get("items") or [] if it.get("id")}
    new_by_id = {it.get("id"): it for it in (new or {}).get("items") or [] if it.get("id")}

    same_fp = set(o) & set(n)
    wording = [{"id": n[k].get("id"), "fingerprint": k,
                "old_statement": o[k].get("statement"),
                "new_statement": n[k].get("statement")}
               for k in same_fp
               if normalize_text(o[k].get("statement")) != normalize_text(
                   n[k].get("statement"))]

    rest_new = {k: v for k, v in n.items() if k not in same_fp}
    rest_old = {k: v for k, v in o.items() if k not in same_fp}

    semantic = []
    for cid, it in list(new_by_id.items()):
        if cid not in old_by_id:
            continue
        before, after = old_by_id[cid], it
        if before.get("fingerprint") == after.get("fingerprint"):
            continue
        semantic.append({
            "id": cid, "type": after.get("type") or before.get("type"),
            "old_statement": before.get("statement"),
            "new_statement": after.get("statement"),
            "change_ratio": similarity(before.get("statement") or "",
                                       after.get("statement") or ""),
            "source": after.get("source") or before.get("source"),
        })
        for k in (before.get("fingerprint"), after.get("fingerprint")):
            rest_old.pop(k, None)
            rest_new.pop(k, None)

    renamed = []
    for ok_, oit in list(rest_old.items()):
        best, best_r = None, 0.0
        for nk, nit in rest_new.items():
            if nit.get("type") != oit.get("type"):
                continue
            r = similarity(oit.get("statement") or "", nit.get("statement") or "")
            if r > best_r:
                best, best_r = nk, r
        if best and best_r >= rename_threshold:
            renamed.append({"old_id": oit.get("id"), "new_id": rest_new[best].get("id"),
                            "similarity": best_r,
                            "note": "内容基本一致，视为同一项改名/换标签，不触发重算"})
            rest_old.pop(ok_, None)
            rest_new.pop(best, None)

    return {
        "semantic_changed": semantic,
        "wording_only": wording,
        "renamed": renamed,
        "added": [it for it in rest_new.values()],
        "removed": [it for it in rest_old.values()],
        "stats": {
            "semantic_changed": len(semantic), "wording_only": len(wording),
            "renamed": len(renamed), "added": len(rest_new), "removed": len(rest_old),
        },
        "triggers_recompute": bool(semantic or rest_new or rest_old),
        "advice": ("全部为表述变更：只更新指纹，不触发任何重算（§6.3）"
                   if not (semantic or rest_new or rest_old) else
                   f"语义变更 {len(semantic)} / 新增 {len(rest_new)} / 删除 {len(rest_old)}："
                   f"按血缘闭包重算受影响子图"),
    }


def lineage_closure(artifacts: list[dict], seeds: list[str],
                    max_hops: int = 8) -> dict:
    """沿 `lineage.derived_from` 向下求闭包（§6.2 第 2 步）。

    artifacts: [{lineage: {id, kind, derived_from: [{id, kind}]}, ...}]
    seeds:     变更起点（需求项 / 知识项 id）

    返回 {closure: [ids 按层], by_kind: {kind: [ids]}, orphan: [引用了不存在的父的产物]}
    `orphan` 必须报出来：父产物被删了但子产物还在，是最隐蔽的脏数据
    （看起来有覆盖，实际结论基于已删除的需求）。
    """
    parents_of: dict[str, list[str]] = {}
    kind_of: dict[str, str] = {}
    known = set()
    for a in artifacts or []:
        lin = a.get("lineage") or {}
        aid = lin.get("id")
        if not aid:
            continue
        known.add(aid)
        kind_of[aid] = lin.get("kind") or a.get("type") or "unknown"
        for p in lin.get("derived_from") or []:
            pid = p.get("id") if isinstance(p, dict) else str(p)
            if pid:
                parents_of.setdefault(pid, []).append(aid)

    frontier = [s for s in (seeds or []) if s]
    seen: list[str] = []
    orphan = sorted({s for s in frontier if s not in known}) if known else []
    for _ in range(max_hops):
        nxt = []
        for pid in frontier:
            for child in parents_of.get(pid, []):
                if child not in seen:
                    seen.append(child)
                    nxt.append(child)
        if not nxt:
            break
        frontier = nxt
    by_kind: dict[str, list[str]] = {}
    for aid in seen:
        by_kind.setdefault(kind_of.get(aid, "unknown"), []).append(aid)
    return {"seeds": list(seeds or []), "closure": seen, "by_kind": by_kind,
            "hops_used": max_hops if frontier else None,
            "orphan": orphan,
            "note": ("被引用的父产物不在库中：结论可能基于已删除的上游，须人工核对"
                     if orphan else "血缘完整")}


def incremental_plan(diff: dict, closure: dict,
                     cases: list[dict] | None = None) -> dict:
    """组一份重算计划：**未被影响的产物一个字节都不动**（§6.2 第 3 步）。

    返回：
      recompute       —— 需要重算的产物（按 kind 分组，附理由）
      untouched       —— 明确不动的（给用户看的"范围有多大"，证明没有全量重跑）
      review_diff_only—— 人工只需审 diff 的对象
      estimated_cases —— 通常只触及 2~5 条（用它跟人解释成本）

    为什么单独给 `untouched`：不列出来，用户会默认"你肯定全改了一遍"，
    然后每次都重新审全量——增量机制的价值就等于零。
    """
    stats = diff.get("stats") or {}
    changed_types = {c.get("type") for c in diff.get("semantic_changed") or []}
    changed_types |= {it.get("type") for it in diff.get("added") or []}
    changed_types |= {it.get("type") for it in diff.get("removed") or []}
    changed_types.discard(None)

    recompute, untouched = [], []
    for kind, rule in RECOMPUTE_RULES.items():
        hit = sorted(changed_types & set(rule["on"]))
        if hit:
            recompute.append({"kind": kind, "on_types": hit, "why": rule["why"],
                              "artifacts": (closure.get("by_kind") or {}).get(kind, [])})
        else:
            untouched.append({"kind": kind, "why": f"本轮变更不涉及 {sorted(rule['on'])}"})

    touched_cases = [c for c in (cases or [])
                     if c.get("id") in set((closure.get("by_kind") or {}).get("case", []))]
    return {
        "recompute": recompute,
        "untouched": untouched,
        "review_diff_only": [r["kind"] for r in recompute] + sorted(
            (closure.get("by_kind") or {}).keys()),
        "estimated_cases": len(touched_cases),
        "case_ids": [c.get("id") for c in touched_cases],
        "summary": (f"语义变更 {stats.get('semantic_changed', 0)} 项，"
                    f"重算 {len(recompute)} 类产物、涉及 {len(touched_cases)} 条用例；"
                    f"{len(untouched)} 类产物不动"),
        "wording_note": (f"另有 {stats.get('wording_only', 0)} 项仅表述变更，"
                         f"只更新指纹、不触发重算（§6.3）"),
        "orphan_alert": closure.get("orphan") or [],
    }
