"""§10.10 项目知识层：把 md/docx 资料库抽取成结构化知识资产（确定性部分）。

为什么需要：
    现状是"每轮对话前把项目资料库整篇喂给模型"。三个后果——token 随资料库线性增长、
    长上下文中段规则被忽略（long_ctx 是 LLM 最短板）、以及**无法追溯"AI 基于哪版资料
    得出的结论"**（资料一改，下游产物为什么变就说不清，直接破坏"可复现优先"）。

本模块做的事（全部零 LLM）：
    1. split_clauses —— 条款化：段落/列表项逐条切分，带章节路径与原文行号；
    2. normalize_item —— 知识项校验：type 封闭 + **必须有原文位置**，无位置即丢弃
       （与 §10.2 check_location 同一纪律：抽不出位置的，宁可不入库）；
    3. dedupe_items —— 语义指纹去重（同一条规则在文档里出现三次只留一条）；
    4. build_knowledge —— 产出 knowledge IR（带 version / content_hash / 来源清单）；
    5. check_gaps —— 知识缺口检查：需求里提到但知识库没定义的业务名词；
    6. find_references —— 反查哪些知识项被某段文本引用（变更影响分析的输入）。

LLM 的位置：只负责"从条款里认出知识项"（Advisor），本模块负责切分、校验、去重、
记账。LLM 抽错会在这里被拦下（无位置/类型非法/重复）。
"""
from __future__ import annotations

import re
from pathlib import Path

from ..common.lineage import semantic_fingerprint, content_hash

__all__ = ["KNOWLEDGE_TYPES", "split_clauses", "split_sources", "normalize_item", "dedupe_items",
           "build_knowledge", "check_gaps", "find_references", "KNOWLEDGE_PRIORITY"]

# 知识项类型（封闭枚举）：决定它在下游怎么被用
KNOWLEDGE_TYPES = {
    "entity": "业务实体（订单/优惠券/账户…）",
    "rule": "业务规则（可被测试点引用的判定条件，最有价值）",
    "constraint": "约束（数值范围、必填、长度、上限）",
    "term": "术语定义（消除歧义）",
    "role": "角色与权限",
    "flow": "业务流程（步骤序列）",
}

# 装配优先级：越靠前越不容易被 token 预算裁掉
KNOWLEDGE_PRIORITY = {"rule": 5, "constraint": 5, "term": 4, "role": 4,
                      "entity": 3, "flow": 2}

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*)$")
# 表格行：| a | b |（业务规则常以表格给出，必须能切）
_TABLE_ROW = re.compile(r"^\s*\|(.+)\|\s*$")

# 疑似业务名词：XX单/券/额/等级/状态/流程… 仅 heuristic=True 时使用（默认关闭，误报高）
_SUSPECT_TERM = re.compile(
    r"[\u4e00-\u9fa5]{1,6}(?:单|券|额|等级|状态|流程|规则|权限|账号|账户|积分|余额|库存)")
_STOP_TERMS = {"订单", "单据", "清单", "名单", "菜单", "表单", "账单", "状态",
               "流程", "规则", "权限", "账号", "账户", "余额", "库存", "积分"}

# 显式术语标记：需求里被引号/书名号包起来的词（可靠的"这是术语"信号）
_QUOTED_TERM = re.compile(r"[“\"《「【]([^”\"》」】]{2,20})[”\"》」】]")


def split_clauses(text: str, source: str = "doc.md") -> list[dict]:
    """资料文档 → 条款列表（带章节路径与行号）。

    比 requirement/parsers.parse_markdown 多两件事：
      - 段落也算条款（业务规则常写在段落里，只切列表项会漏掉一半）；
      - 每条带 section_path（所属章节链），便于知识项归类和按模块装配。

    表格处理：分隔线（|---|---|）与**表头行**都跳过——表头不是知识，
    当成条款会让 LLM 抽出一堆 "术语 | 定义" 这种垃圾项。
    """
    clauses: list[dict] = []
    stack: list[tuple[int, str]] = []       # (level, title)
    lines = text.splitlines()

    # 预扫描表头行：紧邻分隔线的那一行（0-based）。表头本身与分隔线都不是知识
    header_lines: set[int] = set()
    for i in range(len(lines) - 1):
        if _TABLE_ROW.match(lines[i]) and _TABLE_ROW.match(lines[i + 1]):
            nxt = _TABLE_ROW.match(lines[i + 1]).group(1)
            cells = [c.strip() for c in nxt.split("|")]
            if cells and all(set(c) <= set("-: ") for c in cells if c):
                header_lines.add(i)          # 表头行
                header_lines.add(i + 1)       # 分隔线

    buf: list[str] = []
    buf_line = 0

    def flush():
        nonlocal buf, buf_line
        body = " ".join(x.strip() for x in buf if x.strip())
        if body:
            clauses.append({
                "clause_id": f"c{len(clauses) + 1:04d}",
                "section_path": " / ".join(t for _, t in stack) or Path(source).stem,
                "text": body,
                "location": {"file": source, "line": buf_line},
            })
        buf, buf_line = [], 0

    for lineno, line in enumerate(lines, 1):
        if lineno - 1 in header_lines:       # 表头行：直接跳过
            flush()
            continue
        if not line.strip():
            flush()
            continue
        h = _HEADING.match(line)
        if h:
            flush()
            level = len(h.group(1))
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, h.group(2).strip()))
            continue
        li = _LIST_ITEM.match(line)
        tr = _TABLE_ROW.match(line)
        if li:
            flush()
            buf, buf_line = [li.group(1)], lineno
            flush()
        elif tr:
            flush()
            cells = [c.strip() for c in tr.group(1).split("|")]
            if not all(set(c) <= set("-: ") for c in cells if c):   # 跳过分隔线
                buf, buf_line = [" | ".join(c for c in cells if c)], lineno
                flush()
                # 表格行额外给出 cells：术语表/规则表这类两列结构，拆成
                # name|statement 比让模型从 "分摊 | 定义" 里自己切更可靠
                if clauses and len(cells) >= 2:
                    clauses[-1]["cells"] = [c for c in cells if c]
        else:
            if not buf:
                buf_line = lineno
            buf.append(line)
    flush()
    return clauses


def split_sources(sources: list[dict]) -> list[dict]:
    """多份资料一起条款化：每份各自从第 1 行编号，条款 id 带来源前缀。

    为什么需要它：单文档的 `split_clauses` 每份都从 `c0001` 开始，多份拼在一起
    条款 id 会撞，知识项就"定位"到了别人的第 3 行——这种错不会报错，只会让
    「原文位置」变成一条假证据。

    前缀取 `s01`、`s02`…（按传入顺序，稳定可复现），并保留 `source_name`，
    使页面能同时显示"哪份资料 + 第几行 + 章节路径"。
    """
    clauses: list[dict] = []
    for index, source in enumerate(sources or [], start=1):
        name = str(source.get("name") or f"doc{index}")
        for clause in split_clauses(str(source.get("text") or ""), name):
            clauses.append({
                **clause,
                "clause_id": f"s{index:02d}-{clause['clause_id']}",
                "source_name": name,
            })
    return clauses


def normalize_item(raw: dict, clause_index: dict[str, dict] | None = None) -> dict | None:
    """Advisor 抽出的知识项 → 标准化；不合规返回 None（调用方计入 dropped）。

    四条硬校验（任一不过即丢弃，不"修正后入库"）：
      1. type 必须在封闭枚举内；
      2. **必须能定位到原文**（file + line，或 clause_id 能在条款索引里查到）；
      3. statement 非空且不是纯标题（长度 ≥ 4）；
      4. name 非空。
    """
    if not isinstance(raw, dict):
        return None
    ktype = str(raw.get("type") or "").strip()
    if ktype not in KNOWLEDGE_TYPES:
        return None
    name = str(raw.get("name") or "").strip()
    statement = str(raw.get("statement") or raw.get("text") or "").strip()
    if not name or len(statement) < 4:
        return None

    loc = raw.get("source") or raw.get("location") or {}
    cid = raw.get("clause_id") or loc.get("clause_id")
    if cid and clause_index and cid in clause_index:
        c = clause_index[cid]
        loc = dict(c["location"])
        section = c.get("section_path")
    else:
        if not (loc.get("file") and loc.get("line")):
            return None
        section = raw.get("section")

    return {
        "id": raw.get("id") or f"kb-{ktype}-{semantic_fingerprint(name)[:8]}",
        "type": ktype,
        "name": name,
        "statement": statement,
        "source": {"file": loc["file"], "line": int(loc["line"])},
        "section": section,
        "tags": sorted(raw.get("tags") or []),
        # 指纹只取 type+statement：name 是人起的标签，同一条规则被写成
        # "退款上限" 和 "退款金额限制" 时应该判为重复，不能因标题不同就放过
        "fingerprint": semantic_fingerprint(f"{ktype}|{statement}"),
    }


def dedupe_items(items: list[dict]) -> dict:
    """按语义指纹去重：同一规则在文档里写三遍只留一条，保留首次出现位置。"""
    kept: dict[str, dict] = {}
    duplicates: list[dict] = []
    for it in items:
        if not it:
            continue
        fp = it.get("fingerprint") or semantic_fingerprint(
            f"{it['type']}|{it['name']}|{it['statement']}")
        if fp in kept:
            duplicates.append({"dropped": it["id"], "kept": kept[fp]["id"],
                               "reason": "duplicate_fingerprint"})
        else:
            kept[fp] = it
    return {"items": list(kept.values()), "duplicates": duplicates,
            "duplicate_count": len(duplicates)}


def build_knowledge(project: str, raw_items: list[dict],
                    clauses: list[dict] | None = None,
                    version: int = 1, derived_from: dict | None = None,
                    actor: str = "agent:requirement_agent") -> dict:
    """产出 knowledge IR 正文。

    无原文位置的知识项一律丢弃并计数——这是本模块最重要的一条：**不可定位的知识
    等于不可信的知识**，它会污染所有下游产物且事后无法核对。
    """
    clause_index = {c["clause_id"]: c for c in (clauses or [])}
    normalized, dropped = [], []
    for raw in raw_items or []:
        n = normalize_item(raw, clause_index)
        if n is None:
            dropped.append({"raw": raw if isinstance(raw, dict) else str(raw),
                            "reason": "missing_source_or_bad_type_or_empty"})
        else:
            normalized.append(n)
    dd = dedupe_items(normalized)
    items = dd["items"]
    by_type: dict[str, int] = {}
    for it in items:
        by_type[it["type"]] = by_type.get(it["type"], 0) + 1
    body = {
        "type": "knowledge",
        "project": project,
        "items": items,
        "stats": {"items": len(items), "by_type": by_type,
                  "dropped": len(dropped), "duplicates": dd["duplicate_count"]},
        "sources": sorted({it["source"]["file"] for it in items}),
        "content_hash": content_hash({"items": [it["fingerprint"] for it in items]}),
    }
    return {**body, "_build_meta": {"version": version, "actor": actor,
                                    "derived_from": derived_from,
                                    "dropped": dropped,
                                    "duplicates": dd["duplicates"]}}


def check_gaps(requirement_text: str, knowledge: dict,
               glossary: list[str] | None = None,
               heuristic: bool = False) -> dict:
    """知识缺口检查：需求里提到但知识库没定义的业务名词。

    价值：AI 猜错一个未定义术语的成本远高于跑得慢——它会安静地写错测试点，没人发现。

    **默认不启用中文名词启发式**。原因很实在：中文没有分词，正则去猜业务名词的误报率
    高到没人会看（"用户下单"、"和积分" 都会被当成术语）。所以默认只查两类可靠信号：
      1. 需求里被显式标记的词：`“xx”` / `"xx"` / `《xx》` / `【xx】`；
      2. 调用方传入的业务词表（`glossary`，通常由产品经理提供）。
    `heuristic=True` 时才叠加词尾启发式，仅建议在探索期用。
    """
    known = {it["name"] for it in knowledge.get("items") or []}
    known_norm = {n.replace(" ", "") for n in known}

    candidates: list[str] = []
    for m in _QUOTED_TERM.finditer(requirement_text or ""):
        candidates.append(m.group(1).strip())
    candidates.extend(str(g).strip() for g in (glossary or []))
    if heuristic:
        candidates.extend(m.group(0) for m in _SUSPECT_TERM.finditer(requirement_text or ""))

    gaps, seen = [], set()
    for term in candidates:
        if not term or term in seen or len(term) < 2:
            continue
        seen.add(term)
        if term in known or term.replace(" ", "") in known_norm:
            continue
        if any(term in n or n in term for n in known if len(n) >= 2):
            continue
        gaps.append(term)
    return {"gaps": gaps, "gap_count": len(gaps), "known_terms": len(known),
            "advice": ("需求提到但知识库未定义，建议补充定义后再出测试点"
                       if gaps else "无缺口")}


def find_references(text: str, knowledge: dict) -> list[dict]:
    """反查文本引用了哪些知识项 → 变更影响分析用。

    机制：知识项名称/关键短语在文本中出现即视为引用。不追求语义级精确——
    它的用途是"资料改了，找出可能受影响的用例"，宁可多报一点也不能漏。
    """
    hits, low = [], text or ""
    for it in knowledge.get("items") or []:
        keys = [it["name"]] + [t for t in (it.get("tags") or []) if len(t) >= 2]
        if any(k and k in low for k in keys):
            hits.append({"knowledge_id": it["id"], "type": it["type"],
                         "name": it["name"],
                         "priority": KNOWLEDGE_PRIORITY.get(it["type"], 1)})
    hits.sort(key=lambda h: -h["priority"])
    return hits
