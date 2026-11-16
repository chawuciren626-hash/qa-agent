"""10.2 阶段一：需求分析 —— Parser 三件套（全部零 LLM）。

1. parse_markdown / parse_docx — 文档解析器：→ 章节树 + 条款列表，保留原文位置
   （docx 用 python-docx 可选加载；md 原生支持）
2. parse_openapi — 接口规格解析器：OpenAPI/Swagger → 接口清单 IR（v3 §10.2，优先使用）
3. parse_prototype — 原型解析器：Figma 导出 JSON → 页面/控件清单（只取类型与文案，不做语义）
4. check_location — 需求项抽取器（Advisor）的输出钩子：每条必须带原文位置，无位置即丢弃

设计陷阱提醒（v3 §10.2）：不要让 LLM 读整篇 PRD 总结；本工具把文档切成条款，
LLM 逐条抽取（Advisor），每条必须引用原文位置，抽不出位置的丢弃。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

__all__ = ["parse_markdown", "parse_docx", "parse_openapi", "parse_prototype",
           "check_location", "module_of", "MODULE_NOISE"]

# 歧义表述词表（可测性/歧义检查共用）
AMBIGUOUS_WORDS = ("尽快", "尽量", "大概", "差不多", "较好", "很快", "多种方式", "等等", "相关", "适当")

# 路径首段的噪声段：这些不是业务模块，跳过才能把 /api/order/list 归到 order
MODULE_NOISE = frozenset({"api", "apis", "rest", "internal", "public", "open",
                          "gateway", "service", "web", "app", "ui"})
_VERSION_SEG = re.compile(r"^v\d+$", re.I)


def module_of(path: str) -> str:
    """接口路径 → 业务模块名（跳过 api / v1 / {id} 这类噪声段）。

    为什么必须跳：几乎全部接口都是 /api/... 开头，只取首段会让所有接口的 module
    都变成 "api"，模块标签等于失效——而它是回归影响分析与按模块装配知识的入口。
    """
    for seg in [s for s in (path or "").strip("/").split("/") if s]:
        low = seg.lower()
        if low in MODULE_NOISE or _VERSION_SEG.match(low):
            continue
        if seg.startswith("{") or seg.startswith(":"):
            continue
        return seg
    return "root"


def parse_markdown(path: str) -> dict:
    """md → {sections: 章节树, clauses: 条款列表}。

    条款位置 = {file, line}（1 起始行号）；每个列表项/编号段落为一条条款。
    """
    text = Path(path).read_text(encoding="utf-8")
    sections, clauses, stack = [], [], []
    root = {"title": Path(path).stem, "level": 0, "children": sections}

    def current_at(level):
        while stack and stack[-1]["level"] >= level:
            stack.pop()
        parent = stack[-1]["children"] if stack else sections
        return parent

    for lineno, line in enumerate(text.splitlines(), 1):
        h = re.match(r"^(#{1,6})\s+(.*)$", line)
        li = re.match(r"^(\s*)[-*]|\d+[.)]\s+(.*)$", line)
        if h:
            node = {"title": h.group(2).strip(), "level": len(h.group(1)),
                    "line": lineno, "children": []}
            current_at(len(h.group(1))).append(node)
            stack.append(node)
        elif li and (h is None):
            body = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line)
            if body.strip():
                clauses.append({"text": body.strip(),
                                "location": {"file": str(path), "line": lineno}})
    return {"sections": sections, "clauses": clauses,
            "section_count": len(sections), "clause_count": len(clauses)}


def parse_docx(path: str) -> dict:
    """docx → 章节树 + 条款列表（位置 = {file, paragraph_index}）。
    python-docx 未安装时报明确错误，不静默降级。"""
    try:
        import docx  # python-docx
    except ImportError as e:
        raise RuntimeError("解析 docx 需要 python-docx（pip install python-docx）") from e
    doc = docx.Document(path)
    sections, clauses, stack = [], [], []
    for idx, para in enumerate(doc.paragraphs):
        text = (para.text or "").strip()
        if not text:
            continue
        style = (para.style.name or "").lower()
        if "heading" in style:
            try:
                level = int(style.split()[-1])
            except ValueError:
                level = 1
            node = {"title": text, "level": level, "paragraph": idx, "children": []}
            while stack and stack[-1]["level"] >= level:
                stack.pop()
            (stack[-1]["children"] if stack else sections).append(node)
            stack.append(node)
        elif text.startswith(("•", "-", "·")) or re.match(r"^\d+[.)]", text):
            clauses.append({"text": text.lstrip("•-· ").strip(),
                            "location": {"file": str(path), "paragraph": idx}})
    return {"sections": sections, "clauses": clauses}


def parse_openapi(path: str) -> dict:
    """OpenAPI 3.x / Swagger 2 → 接口清单 IR（零 LLM，结构化程度最高，优先使用）。

    输出条目：{api_id: METHOD PATH, method, path, summary, module(由 path 一级段推断),
               request_schema_required: [...], responses_code: [...]}
    module 标签是回归影响分析的粗粒度入口（v3 §10.2 必做补充）。
    """
    p = Path(path)
    if p.suffix in (".yaml", ".yml"):
        import yaml
        spec = yaml.safe_load(p.read_text(encoding="utf-8"))
    else:
        spec = json.loads(p.read_text(encoding="utf-8"))
    apis = []
    for path_str, item in (spec.get("paths") or {}).items():
        for method, op in item.items():
            if method.lower() not in ("get", "post", "put", "patch", "delete"):
                continue
            required = []
            body_schema = ((op.get("requestBody") or {}).get("content") or {}).get(
                "application/json", {}).get("schema") or \
                ((item.get("parameters") or []) and {} or {})
            if body_schema.get("required"):
                required = body_schema["required"]
            for prm in op.get("parameters") or []:
                if prm.get("required"):
                    required.append(prm["name"])
            apis.append({
                "api_id": f"{method.upper()} {path_str}",
                "method": method.upper(), "path": path_str,
                "summary": op.get("summary") or op.get("operationId") or "",
                "module": module_of(path_str),
                "request_required": sorted(set(required)),
                "responses_codes": sorted(str(c) for c in (op.get("responses") or {}).keys()),
            })
    modules = sorted({a["module"] for a in apis})
    return {"spec_version": spec.get("openapi") or spec.get("swagger") or "?",
            "api_count": len(apis), "modules": modules, "apis": apis}


def parse_prototype(figma_export: dict) -> dict:
    """Figma 导出 JSON → 页面/控件清单。只提取控件类型与文案，不做语义（v3 §10.2）。

    兼容两种形态：节点树（{document:{children:[...]}}）或直接页面数组。
    """
    def walk(node, page, out):
        if not isinstance(node, dict):
            return
        ntype = node.get("type")
        if ntype == "TEXT":
            out.append({"page": page, "control_type": "text",
                        "text": (node.get("characters") or "")[:120]})
            return
        if ntype in ("BUTTON", "COMPONENT", "INSTANCE", "INPUT"):
            out.append({"page": page,
                        "control_type": "input" if ntype == "INPUT" else "button",
                        "text": _node_label(node)[:120]})
            return  # 控件节点内的子 TEXT 是控件标签，不再单独提取（防重复计数）
        for child in node.get("children") or []:
            walk(child, page, out)

    def _node_label(node):
        chars = [c.get("characters", "") for c in (node.get("children") or [])
                 if c.get("type") == "TEXT"]
        return chars[0] if chars else node.get("name", "")

    roots = []
    if isinstance(figma_export, dict) and "document" in figma_export:
        roots = figma_export["document"].get("children") or []
    elif isinstance(figma_export, list):
        roots = figma_export
    controls: list[dict] = []
    for page_node in roots:
        page = page_node.get("name") or "?"
        walk(page_node, page, controls)
    pages = sorted({c["page"] for c in controls})
    return {"page_count": len(pages), "pages": pages,
            "control_count": len(controls), "controls": controls}


def check_location(requirement_item: dict) -> dict:
    """Advisor（需求项抽取器）输出钩子：无原文位置的需求项必须丢弃（v3 §10.2 硬规则）。"""
    loc = requirement_item.get("location") or requirement_item.get("source_location")
    ok = bool(loc) and bool((loc.get("file") or loc.get("doc")) is not None)
    return {"accepted": ok,
            "reason": None if ok else "需求项缺少原文位置（file/line 或 file/paragraph），已丢弃"}
